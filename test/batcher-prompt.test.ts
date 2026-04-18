import { describe, expect, it } from "vitest";

import { createBatches, type AgentBatch, type FileContext } from "../src/batcher";
import { buildAgentBatchPrompt } from "../src/promptBuilder";

const TEST_AGENT = "architect";

function createFixtureContextByPath(): Record<string, FileContext> {
  return {
    "src/app/FeatureService.ts": {
      fullContent: "export const feature = true;\n".repeat(40),
      gitDiff: "@@ -1,1 +1,1 @@\n+export const feature = false;\n".repeat(20),
    },
    "src/app/Small.ts": {
      fullContent: "export const small = 1;\n",
      gitDiff: "@@ -0,0 +1,1 @@\n+export const small = 2;\n",
    },
  };
}

describe("createBatches", () => {
  it("keeps batch IDs deterministic across identical runs", () => {
    const routedFiles = new Map<string, readonly string[]>([
      [TEST_AGENT, ["src/app/Small.ts", "src/app/FeatureService.ts", "src/app/Small.ts"]],
    ]);
    const fileContexts = createFixtureContextByPath();

    const firstRun = createBatches(routedFiles, fileContexts, 640);
    const secondRun = createBatches(routedFiles, fileContexts, 640);

    expect(firstRun.batches.map((batch) => batch.id)).toEqual(
      secondRun.batches.map((batch) => batch.id)
    );
  });

  it("chunks file content when it exceeds maxCharLimit", () => {
    const filePath = "src/app/Oversized.ts";
    const fullContent = "const value = 1;\n".repeat(90);
    const gitDiff = "@@ -1 +1 @@\n+const value = 2;\n".repeat(50);
    const routedFiles = new Map<string, readonly string[]>([[TEST_AGENT, [filePath]]]);
    const fileContexts: Record<string, FileContext> = {
      [filePath]: { fullContent, gitDiff },
    };

    const result = createBatches(routedFiles, fileContexts, 500);
    const chunks = result.batches
      .flatMap((batch) => batch.chunks)
      .filter((chunk) => chunk.filePath === filePath)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.totalChunks).toBe(chunks.length);
    expect(chunks.map((chunk) => chunk.fullContent).join("")).toBe(fullContent);
    expect(chunks.map((chunk) => chunk.gitDiff).join("")).toBe(gitDiff);
    expect(result.batches.every((batch) => batch.estimatedChars <= 500)).toBe(true);
  });

  it("throws when maxCharLimit is invalid", () => {
    const routedFiles = new Map<string, readonly string[]>([[TEST_AGENT, ["src/app/Small.ts"]]]);
    const fileContexts = createFixtureContextByPath();

    for (const maxCharLimit of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createBatches(routedFiles, fileContexts, maxCharLimit)).toThrow(
        '"maxCharLimit" must be a positive finite number.'
      );
    }
  });

  it("throws when a routed file is missing context", () => {
    const routedFiles = new Map<string, readonly string[]>([[TEST_AGENT, ["src/app/Missing.ts"]]]);

    expect(() => createBatches(routedFiles, {}, 640)).toThrow(
      'Missing file context for routed file "src/app/Missing.ts"'
    );
  });

  it("throws when framing overhead already exceeds maxCharLimit", () => {
    const routedFiles = new Map<string, readonly string[]>([[TEST_AGENT, ["src/app/Small.ts"]]]);
    const fileContexts = createFixtureContextByPath();

    expect(() => createBatches(routedFiles, fileContexts, 300)).toThrow(
      "is too small for required framing overhead"
    );
  });
});

function createPromptBatch(): AgentBatch {
  const filePath = "src/app/PromptFixture.ts";
  const routedFiles = new Map<string, readonly string[]>([[TEST_AGENT, [filePath]]]);
  const fileContexts: Record<string, FileContext> = {
    [filePath]: {
      fullContent: "### collision from content\nexport const ok = true;\n",
      gitDiff: "### collision from diff\n+export const ok = false;\n",
    },
  };

  return createBatches(routedFiles, fileContexts, 700).batches[0]!;
}

describe("buildAgentBatchPrompt", () => {
  it("contains required sections and tokens", () => {
    const prompt = buildAgentBatchPrompt({
      agentInstruction: "Review architecture and return strict JSON findings.",
      batch: createPromptBatch(),
    });

    expect(prompt).toContain("### AGENT_INSTRUCTION");
    expect(prompt).toContain("### BATCH");
    expect(prompt).toContain("### FILE");
    expect(prompt).toContain("### FULL_CONTENT");
    expect(prompt).toContain("### GIT_DIFF");
    expect(prompt).toContain("### OUTPUT_REQUIREMENTS");
    expect(prompt).toContain("Return ONLY a valid JSON array.");
    expect(prompt).toContain(`Every finding must include "agent":"${TEST_AGENT}".`);
  });

  it('sanitizes delimiter collisions from "### " to "##\\# "', () => {
    const prompt = buildAgentBatchPrompt({
      agentInstruction: "### collision from instruction\nreview this batch",
      batch: createPromptBatch(),
    });

    expect(prompt).toContain("##\\# collision from instruction");
    expect(prompt).toContain("##\\# collision from content");
    expect(prompt).toContain("##\\# collision from diff");
  });

  it("throws when agentInstruction is empty", () => {
    expect(() =>
      buildAgentBatchPrompt({
        agentInstruction: "   ",
        batch: createPromptBatch(),
      })
    ).toThrow('"agentInstruction" must not be empty.');
  });

  it("throws when batch has zero chunks", () => {
    const emptyBatch: AgentBatch = {
      id: "architect-0001-empty",
      agent: TEST_AGENT,
      batchIndex: 0,
      totalBatches: 1,
      estimatedChars: 0,
      chunks: [],
    };

    expect(() =>
      buildAgentBatchPrompt({
        agentInstruction: "Review architecture findings.",
        batch: emptyBatch,
      })
    ).toThrow('must include at least one chunk.');
  });
});

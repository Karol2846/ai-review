import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

import type { AgentBatch } from "../src/batcher";
import { LlmProviderError } from "../src/llmProvider";
import type { Finding } from "../src/findingSchema";
import { runAgentBatches } from "../src/runner";

const { generateFindingsMock } = vi.hoisted(() => ({
  generateFindingsMock: vi.fn<(model: unknown, prompt: string) => Promise<Finding[]>>(),
}));

vi.mock("../src/llmAdapter", () => ({
  generateFindings: generateFindingsMock,
}));

const fakeModel = new MockLanguageModelV3({
  doGenerate: {
    finishReason: { unified: "stop", raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: undefined, reasoning: undefined },
    },
    warnings: [],
    content: [],
  },
});

const validFinding: Finding = {
  file: "src/app/example.ts",
  line: 1,
  agent: "architect",
  severity: "warning",
  category: "design",
  message: "Issue found",
  suggestion: "Fix it",
};

function createBatch(id: string, batchIndex = 0, totalBatches = 1): AgentBatch {
  return {
    id,
    agent: "architect",
    batchIndex,
    totalBatches,
    estimatedChars: 120,
    chunks: [
      {
        agent: "architect",
        filePath: "src/app/example.ts",
        chunkIndex: 0,
        totalChunks: 1,
        fullContent: "export const value = 1;\n",
        gitDiff: "@@ -1 +1 @@\n+export const value = 2;\n",
        fullContentRange: [0, 24],
        gitDiffRange: [0, 38],
        estimatedChars: 90,
      },
    ],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(() => {
  generateFindingsMock.mockReset();
});

describe("runAgentBatches", () => {
  it("returns deterministic result order matching batch order", async () => {
    const firstBatch = createBatch("batch-1", 0, 2);
    const secondBatch = createBatch("batch-2", 1, 2);

    generateFindingsMock.mockImplementation(async (_model, prompt: string) => {
      if (prompt.includes("batch_id: batch-1")) {
        await delay(20);
        return [validFinding];
      }
      return [];
    });

    const result = await runAgentBatches({
      batches: [firstBatch, secondBatch],
      agentInstructions: { architect: "Review architecture." },
      model: fakeModel,
      concurrency: 2,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(result.results.map((item) => item.batchId)).toEqual(["batch-1", "batch-2"]);
    expect(result.successes[0]?.findings).toEqual([validFinding]);
    expect(result.successes[1]?.findings).toEqual([]);
    expect(result.summary.failureCount).toBe(0);
  });

  it("retries transient command failures and succeeds within retry budget", async () => {
    generateFindingsMock
      .mockRejectedValueOnce(new LlmProviderError("COMMAND_FAILED", "Temporary outage"))
      .mockRejectedValueOnce(new LlmProviderError("COMMAND_FAILED", "Temporary outage"))
      .mockResolvedValueOnce([validFinding]);

    const result = await runAgentBatches({
      batches: [createBatch("batch-retry")],
      agentInstructions: { architect: "Review architecture." },
      model: fakeModel,
      concurrency: 1,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(generateFindingsMock).toHaveBeenCalledTimes(3);
    expect(result.successes).toHaveLength(1);
    expect(result.successes[0]).toMatchObject({
      batchId: "batch-retry",
      attemptCount: 3,
      retryCount: 2,
    });
    expect(result.successes[0]?.findings).toEqual([validFinding]);
  });

  it("records warning metadata when transient failures exceed maxRetries", async () => {
    generateFindingsMock.mockRejectedValue(new LlmProviderError("COMMAND_FAILED", "Timeout while contacting model"));

    const result = await runAgentBatches({
      batches: [createBatch("batch-timeout")],
      agentInstructions: { architect: "Review architecture." },
      model: fakeModel,
      concurrency: 1,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(generateFindingsMock).toHaveBeenCalledTimes(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      batchId: "batch-timeout",
      code: "COMMAND_FAILED",
      isTransient: true,
      attemptCount: 3,
    });
    expect(result.summary.warningCount).toBe(1);
    expect(result.summary.errorCount).toBe(0);
  });

  it("records error metadata for non-transient failures without retrying", async () => {
    generateFindingsMock.mockRejectedValue(new LlmProviderError("NOT_AUTHENTICATED", "Please login first"));

    const result = await runAgentBatches({
      batches: [createBatch("batch-auth")],
      agentInstructions: { architect: "Review architecture." },
      model: fakeModel,
      concurrency: 1,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(generateFindingsMock).toHaveBeenCalledTimes(1);
    expect(result.failures[0]).toMatchObject({
      batchId: "batch-auth",
      code: "NOT_AUTHENTICATED",
      isTransient: false,
      attemptCount: 1,
    });
    expect(result.summary.warningCount).toBe(0);
    expect(result.summary.errorCount).toBe(1);
  });

  it("records missing instruction failure without calling the adapter", async () => {
    const result = await runAgentBatches({
      batches: [createBatch("batch-no-instruction")],
      agentInstructions: {},
      model: fakeModel,
      concurrency: 1,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(generateFindingsMock).not.toHaveBeenCalled();
    expect(result.failures[0]).toMatchObject({
      batchId: "batch-no-instruction",
      code: "MISSING_AGENT_INSTRUCTION",
      attemptCount: 0,
    });
    expect(result.summary.errorCount).toBe(1);
  });

  it("throws for concurrency: 0", async () => {
    await expect(
      runAgentBatches({
        batches: [createBatch("b")],
        agentInstructions: { architect: "Review." },
        model: fakeModel,
        concurrency: 0,
        retry: { maxRetries: 0, retryDelayMs: 0 },
      })
    ).rejects.toThrow(/"concurrency" must be a positive integer/u);
    expect(generateFindingsMock).not.toHaveBeenCalled();
  });

  it("throws for concurrency: 1.5", async () => {
    await expect(
      runAgentBatches({
        batches: [createBatch("b")],
        agentInstructions: { architect: "Review." },
        model: fakeModel,
        concurrency: 1.5,
        retry: { maxRetries: 0, retryDelayMs: 0 },
      })
    ).rejects.toThrow(/"concurrency" must be a positive integer/u);
  });

  it("throws for maxRetries: -1", async () => {
    await expect(
      runAgentBatches({
        batches: [createBatch("b")],
        agentInstructions: { architect: "Review." },
        model: fakeModel,
        concurrency: 1,
        retry: { maxRetries: -1, retryDelayMs: 0 },
      })
    ).rejects.toThrow(/"retry.maxRetries" must be a non-negative integer/u);
  });

  it("throws for retryDelayMs: -1", async () => {
    await expect(
      runAgentBatches({
        batches: [createBatch("b")],
        agentInstructions: { architect: "Review." },
        model: fakeModel,
        concurrency: 1,
        retry: { maxRetries: 0, retryDelayMs: -1 },
      })
    ).rejects.toThrow(/"retry.retryDelayMs" must be a non-negative finite number/u);
  });

  it("maxRetries: 0 succeeds on first attempt without retrying", async () => {
    generateFindingsMock.mockResolvedValueOnce([validFinding]);

    const result = await runAgentBatches({
      batches: [createBatch("batch-once")],
      agentInstructions: { architect: "Review." },
      model: fakeModel,
      concurrency: 1,
      retry: { maxRetries: 0, retryDelayMs: 0 },
    });

    expect(generateFindingsMock).toHaveBeenCalledTimes(1);
    expect(result.successes[0]).toMatchObject({
      batchId: "batch-once",
      status: "success",
      attemptCount: 1,
      retryCount: 0,
    });
    expect(result.successes[0]?.findings).toEqual([validFinding]);
  });

  it("maxRetries: 0 records transient failure without retrying", async () => {
    generateFindingsMock.mockRejectedValueOnce(new LlmProviderError("RATE_LIMITED", "rate limited"));

    const result = await runAgentBatches({
      batches: [createBatch("batch-no-retry")],
      agentInstructions: { architect: "Review." },
      model: fakeModel,
      concurrency: 1,
      retry: { maxRetries: 0, retryDelayMs: 0 },
    });

    expect(generateFindingsMock).toHaveBeenCalledTimes(1);
    expect(result.failures[0]).toMatchObject({
      batchId: "batch-no-retry",
      code: "RATE_LIMITED",
      isTransient: true,
      attemptCount: 1,
      retryCount: 0,
    });
    expect(result.summary.warningCount).toBe(1);
    expect(result.summary.errorCount).toBe(0);
  });
});

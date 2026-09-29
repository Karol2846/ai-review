import { describe, it, expect } from "vitest";
import { generateFindings } from "../src/llmAdapter";
import type { LlmClient } from "../src/llmClient";
import { LlmProviderError } from "../src/llmProvider";
import type { Finding } from "../src/findingSchema";

const validFinding: Finding = {
  file: "src/foo.ts",
  line: 5,
  agent: "tester",
  severity: "warning",
  category: "missing-test",
  message: "No test for this function",
  suggestion: "Add a unit test",
};

function clientReturning(text: string): LlmClient {
  return { provider: "claude-code", complete: async () => text };
}

function clientThrowing(error: unknown): LlmClient {
  return {
    provider: "claude-code",
    complete: async () => {
      throw error;
    },
  };
}

describe("generateFindings", () => {
  it("returns Finding[] parsed from the model reply", async () => {
    const findings = await generateFindings(clientReturning(JSON.stringify([validFinding])), "review this");
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/foo.ts");
    expect(findings[0].severity).toBe("warning");
  });

  it("extracts the JSON array from a reply wrapped in prose and a code fence", async () => {
    const reply = "Here you go:\n```json\n" + JSON.stringify([validFinding]) + "\n```";
    await expect(generateFindings(clientReturning(reply), "x")).resolves.toHaveLength(1);
  });

  it("returns empty array when model returns []", async () => {
    await expect(generateFindings(clientReturning("[]"), "x")).resolves.toEqual([]);
  });

  it("returns empty array when model output contains no valid findings", async () => {
    const reply = JSON.stringify([{ notAFinding: true }]);
    await expect(generateFindings(clientReturning(reply), "x")).resolves.toEqual([]);
  });

  it("passes LlmProviderError through unchanged", async () => {
    const error = new LlmProviderError("NOT_AUTHENTICATED", "log in first");
    await expect(generateFindings(clientThrowing(error), "x")).rejects.toBe(error);
  });

  it("wraps unexpected errors as COMMAND_FAILED", async () => {
    await expect(generateFindings(clientThrowing(new Error("boom")), "x")).rejects.toSatisfy(
      (e) => e instanceof LlmProviderError && e.code === "COMMAND_FAILED" && e.message === "boom"
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentBatch } from "../src/batcher";

const { runCopilotPromptMock } = vi.hoisted(() => ({
  runCopilotPromptMock: vi.fn(),
}));

vi.mock("../src/copilot", async () => {
  const actual = await vi.importActual<typeof import("../src/copilot")>("../src/copilot");
  return {
    ...actual,
    runCopilotPrompt: runCopilotPromptMock,
  };
});

import { CopilotServiceError } from "../src/copilot";
import { runAgentBatches } from "../src/runner";

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
  runCopilotPromptMock.mockReset();
});

describe("runAgentBatches", () => {
  it("returns deterministic result order matching batch order", async () => {
    const firstBatch = createBatch("batch-1", 0, 2);
    const secondBatch = createBatch("batch-2", 1, 2);

    runCopilotPromptMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes("batch_id: batch-1")) {
        await delay(20);
        return "output-1";
      }
      return "output-2";
    });

    const result = await runAgentBatches({
      batches: [firstBatch, secondBatch],
      agentInstructions: { architect: "Review architecture." },
      concurrency: 2,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(result.results.map((item) => item.batchId)).toEqual(["batch-1", "batch-2"]);
    expect(result.successes.map((item) => item.rawOutput)).toEqual(["output-1", "output-2"]);
    expect(result.summary.failureCount).toBe(0);
  });

  it("retries transient command failures and succeeds within retry budget", async () => {
    runCopilotPromptMock
      .mockRejectedValueOnce(new CopilotServiceError("COMMAND_FAILED", "Temporary outage"))
      .mockRejectedValueOnce(new CopilotServiceError("COMMAND_FAILED", "Temporary outage"))
      .mockResolvedValueOnce("recovered");

    const result = await runAgentBatches({
      batches: [createBatch("batch-retry")],
      agentInstructions: { architect: "Review architecture." },
      concurrency: 1,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(runCopilotPromptMock).toHaveBeenCalledTimes(3);
    expect(result.successes).toHaveLength(1);
    expect(result.successes[0]).toMatchObject({
      batchId: "batch-retry",
      attemptCount: 3,
      retryCount: 2,
      rawOutput: "recovered",
    });
  });

  it("records warning metadata when transient failures exceed maxRetries", async () => {
    runCopilotPromptMock.mockRejectedValue(
      new CopilotServiceError("COMMAND_FAILED", "Timeout while contacting model")
    );

    const result = await runAgentBatches({
      batches: [createBatch("batch-timeout")],
      agentInstructions: { architect: "Review architecture." },
      concurrency: 1,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(runCopilotPromptMock).toHaveBeenCalledTimes(3);
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
    runCopilotPromptMock.mockRejectedValue(
      new CopilotServiceError("NOT_AUTHENTICATED", "Please login first")
    );

    const result = await runAgentBatches({
      batches: [createBatch("batch-auth")],
      agentInstructions: { architect: "Review architecture." },
      concurrency: 1,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(runCopilotPromptMock).toHaveBeenCalledTimes(1);
    expect(result.failures[0]).toMatchObject({
      batchId: "batch-auth",
      code: "NOT_AUTHENTICATED",
      isTransient: false,
      attemptCount: 1,
    });
    expect(result.summary.warningCount).toBe(0);
    expect(result.summary.errorCount).toBe(1);
  });

  it("records missing instruction failure without calling Copilot", async () => {
    const result = await runAgentBatches({
      batches: [createBatch("batch-no-instruction")],
      agentInstructions: {},
      concurrency: 1,
      retry: { maxRetries: 2, retryDelayMs: 0 },
    });

    expect(runCopilotPromptMock).not.toHaveBeenCalled();
    expect(result.failures[0]).toMatchObject({
      batchId: "batch-no-instruction",
      code: "MISSING_AGENT_INSTRUCTION",
      attemptCount: 0,
    });
    expect(result.summary.errorCount).toBe(1);
  });
});

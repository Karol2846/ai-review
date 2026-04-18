import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentBatch } from "../src/batcher";
import type { BuildFileContextsResult } from "../src/contextBuilder";
import type {
  BatchRunFailure,
  BatchRunResult,
  BatchRunSuccess,
  RunAgentBatchesInput,
  RunAgentBatchesResult,
  RunnerSummary,
} from "../src/runner";
import type { RoutingRuntimeConfig } from "../src/routingTypes";

const { buildFileContextsMock, runAgentBatchesMock } = vi.hoisted(() => ({
  buildFileContextsMock: vi.fn(),
  runAgentBatchesMock: vi.fn(),
}));

vi.mock("../src/contextBuilder", async () => {
  const actual = await vi.importActual<typeof import("../src/contextBuilder")>("../src/contextBuilder");
  return {
    ...actual,
    buildFileContexts: buildFileContextsMock,
  };
});

vi.mock("../src/runner", async () => {
  const actual = await vi.importActual<typeof import("../src/runner")>("../src/runner");
  return {
    ...actual,
    runAgentBatches: runAgentBatchesMock,
  };
});

import { runReviewPipeline } from "../src/reviewPipeline";

function createRoutingConfig(): RoutingRuntimeConfig {
  return {
    unmatchedFilesPolicy: "skip",
    userConfigMergeMode: "override",
    invalidUserConfigPolicy: "fallback_with_warning",
    agentGlobs: {
      tester: ["**/*.ts"],
      architect: ["src/**/*.ts"],
    },
  };
}

function createSuccess(batch: AgentBatch, rawOutput: string, attemptCount = 1): BatchRunSuccess {
  return {
    status: "success",
    batchId: batch.id,
    agent: batch.agent,
    batchIndex: batch.batchIndex,
    totalBatches: batch.totalBatches,
    attemptCount,
    retryCount: Math.max(0, attemptCount - 1),
    rawOutput,
  };
}

function createFailure(
  batch: AgentBatch,
  overrides: Partial<Omit<BatchRunFailure, "status" | "batchId" | "agent" | "batchIndex" | "totalBatches">>
): BatchRunFailure {
  return {
    status: "failed",
    batchId: batch.id,
    agent: batch.agent,
    batchIndex: batch.batchIndex,
    totalBatches: batch.totalBatches,
    attemptCount: overrides.attemptCount ?? 1,
    retryCount: overrides.retryCount ?? 0,
    code: overrides.code ?? "COMMAND_FAILED",
    message: overrides.message ?? "runner failure",
    isTransient: overrides.isTransient ?? true,
  };
}

function toRunnerResult(results: readonly BatchRunResult[]): RunAgentBatchesResult {
  const successes = results.filter((result): result is BatchRunSuccess => result.status === "success");
  const failures = results.filter((result): result is BatchRunFailure => result.status === "failed");

  const summary: RunnerSummary = {
    totalBatches: results.length,
    successCount: successes.length,
    failureCount: failures.length,
    warningCount: failures.filter((failure) => failure.isTransient).length,
    errorCount: failures.filter((failure) => !failure.isTransient).length,
    warnings: failures
      .filter((failure) => failure.isTransient)
      .map((failure) => ({
        level: "warning",
        batchId: failure.batchId,
        agent: failure.agent,
        code: failure.code,
        message: failure.message,
      })),
    errors: failures
      .filter((failure) => !failure.isTransient)
      .map((failure) => ({
        level: "error",
        batchId: failure.batchId,
        agent: failure.agent,
        code: failure.code,
        message: failure.message,
      })),
  };

  return {
    results: [...results],
    successes,
    failures,
    summary,
  };
}

beforeEach(() => {
  buildFileContextsMock.mockReset();
  runAgentBatchesMock.mockReset();
});

describe("runReviewPipeline (smoke)", () => {
  it("wires routing, batching, parser, and aggregator into a deterministic end-to-end flow", async () => {
    const contextResult: BuildFileContextsResult = {
      contexts: [
        {
          filePath: "src/service.ts",
          fullContent: "export function service(input: string) { return input.trim(); }\n",
          gitDiff: "@@ -1 +1 @@\n-export function service(input) { return input; }\n+export function service(input: string) { return input.trim(); }\n",
        },
        {
          filePath: "test/service.test.ts",
          fullContent: "it('works', () => expect(service('x')).toBe('x'));\n",
          gitDiff: "@@ -0,0 +1 @@\n+it('works', () => expect(service('x')).toBe('x'));\n",
        },
      ],
      warnings: [
        {
          filePath: "assets/logo.png",
          code: "UNSUPPORTED_FILE_TYPE",
          message: 'Skipping non-reviewable file "assets/logo.png" (unsupported extension ".png").',
        },
      ],
    };
    buildFileContextsMock.mockResolvedValue(contextResult);

    runAgentBatchesMock.mockImplementation(async (input: RunAgentBatchesInput) => {
      const results = input.batches.map((batch) => {
        if (batch.agent === "architect") {
          return createSuccess(
            batch,
            [
              "```json",
              '[{"file":"src/service.ts","line":1,"agent":"architect","severity":"critical","category":"input-validation","message":"Input is trimmed without null guard.","suggestion":"Guard against undefined before calling trim."}]',
              "```",
            ].join("\n")
          );
        }

        return createSuccess(
          batch,
          '[{"file":"src/service.ts","line":1,"agent":"tester","severity":"warning","category":"input-validation","message":"Input is trimmed without null guard.","suggestion":"Add a test for undefined input."}]'
        );
      });

      return toRunnerResult(results);
    });

    const result = await runReviewPipeline({
      repoRootPath: "C:\\repo",
      mergeBase: "abc123",
      routingConfig: createRoutingConfig(),
      agentInstructions: {
        tester: "Review tests and edge cases.",
        architect: "Review architecture and API safety.",
      },
      maxCharLimit: 4_000,
      concurrency: 2,
      retry: { maxRetries: 1, retryDelayMs: 0 },
      minSeverity: "info",
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: "src/service.ts",
      line: 1,
      severity: "critical",
      category: "input-validation",
    });
    expect(result.findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.metadata.failedBatchCount).toBe(0);
    expect(result.metadata.batchCount).toBe(2);
    expect(result.metadata.contextWarningCount).toBe(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        stage: "context",
        code: "UNSUPPORTED_FILE_TYPE",
      }),
    ]);
  });

  it("surfaces failed batches in warnings/metadata and still returns successful findings", async () => {
    const contextResult: BuildFileContextsResult = {
      contexts: [
        {
          filePath: "src/service.ts",
          fullContent: "export function service(input: string) { return input.trim(); }\n",
          gitDiff: "@@ -1 +1 @@\n-export function service(input) { return input; }\n+export function service(input: string) { return input.trim(); }\n",
        },
      ],
      warnings: [],
    };
    buildFileContextsMock.mockResolvedValue(contextResult);

    runAgentBatchesMock.mockImplementation(async (input: RunAgentBatchesInput) => {
      const testerBatch = input.batches.find((batch) => batch.agent === "tester");
      const architectBatch = input.batches.find((batch) => batch.agent === "architect");

      if (!testerBatch || !architectBatch) {
        throw new Error("Expected tester and architect batches.");
      }

      const success = createSuccess(
        testerBatch,
        JSON.stringify([
          {
            file: "src/service.ts",
            line: 1,
            agent: "tester",
            severity: "warning",
            category: "input-validation",
            message: "Input is trimmed without null guard.",
            suggestion: "Add null-input test coverage.",
          },
          {
            file: "",
            line: 0,
            agent: "tester",
            severity: "warning",
            category: "invalid",
            message: "invalid",
            suggestion: "invalid",
          },
        ])
      );
      const failure = createFailure(architectBatch, {
        code: "COMMAND_FAILED",
        message: "copilot command timed out",
        isTransient: true,
        attemptCount: 2,
        retryCount: 1,
      });

      return toRunnerResult([success, failure]);
    });

    const result = await runReviewPipeline({
      repoRootPath: "C:\\repo",
      mergeBase: "abc123",
      routingConfig: createRoutingConfig(),
      agentInstructions: {
        tester: "Review tests and edge cases.",
        architect: "Review architecture and API safety.",
      },
      maxCharLimit: 4_000,
      concurrency: 2,
      retry: { maxRetries: 1, retryDelayMs: 0 },
      minSeverity: "warning",
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      agent: "tester",
      severity: "warning",
    });
    expect(result.metadata.failedBatchCount).toBe(1);
    expect(result.metadata.failedBatches).toHaveLength(1);
    expect(result.metadata.runner.warningCount).toBe(1);
    expect(result.metadata.parserWarningCount).toBe(1);
    expect(
      result.warnings.some(
        (warning) => warning.stage === "runner" && warning.code === "COMMAND_FAILED" && warning.level === "warning"
      )
    ).toBe(true);
    expect(
      result.warnings.some((warning) => warning.stage === "parser" && warning.code === "INVALID_RECORD")
    ).toBe(true);
  });
});

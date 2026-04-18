import pMap from "p-map";

import type { AgentBatch } from "./batcher";
import { CopilotServiceError, type CopilotServiceErrorCode, runCopilotPrompt } from "./copilot";
import { buildAgentBatchPrompt } from "./promptBuilder";
import type { AgentName } from "./routingTypes";

export interface RunnerRetryConfig {
  readonly maxRetries: number;
  readonly retryDelayMs: number;
}

export type AgentInstructionsByAgent =
  | ReadonlyMap<AgentName, string>
  | Readonly<Record<string, string>>;

type AgentInstructionsRecord = Readonly<Record<string, string>>;

export interface RunAgentBatchesInput {
  readonly batches: readonly AgentBatch[];
  readonly agentInstructions: AgentInstructionsByAgent;
  readonly concurrency: number;
  readonly retry: RunnerRetryConfig;
}

export type RunnerFailureCode =
  | CopilotServiceErrorCode
  | "MISSING_AGENT_INSTRUCTION"
  | "PROMPT_BUILD_FAILED"
  | "UNKNOWN";

export interface BatchRunSuccess {
  readonly status: "success";
  readonly batchId: string;
  readonly agent: AgentName;
  readonly batchIndex: number;
  readonly totalBatches: number;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly rawOutput: string;
}

export interface BatchRunFailure {
  readonly status: "failed";
  readonly batchId: string;
  readonly agent: AgentName;
  readonly batchIndex: number;
  readonly totalBatches: number;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly code: RunnerFailureCode;
  readonly message: string;
  readonly isTransient: boolean;
}

export type BatchRunResult = BatchRunSuccess | BatchRunFailure;

export interface RunnerIssue {
  readonly level: "warning" | "error";
  readonly batchId: string;
  readonly agent: AgentName;
  readonly code: RunnerFailureCode;
  readonly message: string;
}

export interface RunnerSummary {
  readonly totalBatches: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly warningCount: number;
  readonly errorCount: number;
  readonly warnings: readonly RunnerIssue[];
  readonly errors: readonly RunnerIssue[];
}

export interface RunAgentBatchesResult {
  readonly results: readonly BatchRunResult[];
  readonly successes: readonly BatchRunSuccess[];
  readonly failures: readonly BatchRunFailure[];
  readonly summary: RunnerSummary;
}

class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function readAgentInstruction(
  agentInstructions: AgentInstructionsByAgent,
  agent: AgentName
): string | undefined {
  if (agentInstructions instanceof Map) {
    return agentInstructions.get(agent);
  }

  const byAgent = agentInstructions as AgentInstructionsRecord;
  return byAgent[agent];
}

function isTransientCopilotError(error: unknown): boolean {
  return error instanceof CopilotServiceError && error.code === "COMMAND_FAILED";
}

function normalizeFailure(error: unknown): Pick<BatchRunFailure, "code" | "message" | "isTransient"> {
  if (error instanceof CopilotServiceError) {
    return {
      code: error.code,
      message: error.message,
      isTransient: isTransientCopilotError(error),
    };
  }

  if (error instanceof Error) {
    return {
      code: "UNKNOWN",
      message: error.message,
      isTransient: false,
    };
  }

  return {
    code: "UNKNOWN",
    message: "Unknown runner failure.",
    isTransient: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toBatchFailure(
  batch: AgentBatch,
  attemptCount: number,
  code: RunnerFailureCode,
  message: string,
  isTransient: boolean
): BatchRunFailure {
  return {
    status: "failed",
    batchId: batch.id,
    agent: batch.agent,
    batchIndex: batch.batchIndex,
    totalBatches: batch.totalBatches,
    attemptCount,
    retryCount: Math.max(0, attemptCount - 1),
    code,
    message,
    isTransient,
  };
}

function validateInput(input: RunAgentBatchesInput): void {
  if (!isPositiveInteger(input.concurrency)) {
    throw new RunnerError(`"concurrency" must be a positive integer. Received: ${input.concurrency}`);
  }

  if (!isNonNegativeInteger(input.retry.maxRetries)) {
    throw new RunnerError(
      `"retry.maxRetries" must be a non-negative integer. Received: ${input.retry.maxRetries}`
    );
  }

  if (!isFiniteNonNegative(input.retry.retryDelayMs)) {
    throw new RunnerError(
      `"retry.retryDelayMs" must be a non-negative finite number. Received: ${input.retry.retryDelayMs}`
    );
  }
}

async function runSingleBatch(
  batch: AgentBatch,
  agentInstructions: AgentInstructionsByAgent,
  retry: RunnerRetryConfig
): Promise<BatchRunResult> {
  const rawAgentInstruction = readAgentInstruction(agentInstructions, batch.agent);
  const agentInstruction = rawAgentInstruction?.trim();
  if (!agentInstruction) {
    return toBatchFailure(
      batch,
      0,
      "MISSING_AGENT_INSTRUCTION",
      `No instruction found for agent "${batch.agent}".`,
      false
    );
  }

  let prompt: string;
  try {
    prompt = buildAgentBatchPrompt({
      agentInstruction,
      batch,
    });
  } catch (error) {
    const failure = normalizeFailure(error);
    return toBatchFailure(batch, 0, "PROMPT_BUILD_FAILED", failure.message, false);
  }

  const maxAttempts = retry.maxRetries + 1;
  let lastFailure: BatchRunFailure | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const rawOutput = await runCopilotPrompt(prompt);
      return {
        status: "success",
        batchId: batch.id,
        agent: batch.agent,
        batchIndex: batch.batchIndex,
        totalBatches: batch.totalBatches,
        attemptCount: attempt,
        retryCount: attempt - 1,
        rawOutput,
      };
    } catch (error) {
      const failure = normalizeFailure(error);
      lastFailure = toBatchFailure(batch, attempt, failure.code, failure.message, failure.isTransient);

      const canRetry = failure.isTransient && attempt < maxAttempts;
      if (!canRetry) {
        return lastFailure;
      }

      await sleep(retry.retryDelayMs);
    }
  }

  return (
    lastFailure ??
    toBatchFailure(batch, maxAttempts, "UNKNOWN", "Runner exhausted retries without an explicit error.", true)
  );
}

function summarize(results: readonly BatchRunResult[]): RunnerSummary {
  const successes = results.filter((result): result is BatchRunSuccess => result.status === "success");
  const failures = results.filter((result): result is BatchRunFailure => result.status === "failed");

  const warnings = failures
    .filter((failure) => failure.isTransient)
    .map((failure): RunnerIssue => ({
      level: "warning",
      batchId: failure.batchId,
      agent: failure.agent,
      code: failure.code,
      message: failure.message,
    }));

  const errors = failures
    .filter((failure) => !failure.isTransient)
    .map((failure): RunnerIssue => ({
      level: "error",
      batchId: failure.batchId,
      agent: failure.agent,
      code: failure.code,
      message: failure.message,
    }));

  return {
    totalBatches: results.length,
    successCount: successes.length,
    failureCount: failures.length,
    warningCount: warnings.length,
    errorCount: errors.length,
    warnings,
    errors,
  };
}

export async function runAgentBatches(input: RunAgentBatchesInput): Promise<RunAgentBatchesResult> {
  validateInput(input);

  const results = await pMap(
    input.batches,
    async (batch) => runSingleBatch(batch, input.agentInstructions, input.retry),
    { concurrency: input.concurrency }
  );

  const successes = results.filter((result): result is BatchRunSuccess => result.status === "success");
  const failures = results.filter((result): result is BatchRunFailure => result.status === "failed");

  return {
    results,
    successes,
    failures,
    summary: summarize(results),
  };
}

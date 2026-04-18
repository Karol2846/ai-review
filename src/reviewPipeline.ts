import {
  aggregateFindings,
  type AggregatedFinding,
  type AggregationMetadata,
  type FindingSeverity,
} from "./aggregator";
import { createBatches, type AgentBatch, type FileContext } from "./batcher";
import {
  buildFileContexts,
  type ContextBuilderWarning,
  type ContextBuilderWarningCode,
} from "./contextBuilder";
import {
  parseModelResponse,
  type ParsedFinding,
  type ResponseParserCandidateSource,
  type ResponseParserWarning,
  type ResponseParserWarningCode,
} from "./responseParser";
import { routeFilesToAgents } from "./router";
import type { AgentName, RoutingRuntimeConfig } from "./routingTypes";
import {
  runAgentBatches,
  type AgentInstructionsByAgent,
  type BatchRunFailure,
  type BatchRunSuccess,
  type RunnerFailureCode,
  type RunnerRetryConfig,
  type RunnerSummary,
} from "./runner";

export interface RunReviewPipelineInput {
  readonly repoRootPath: string;
  readonly mergeBase: string;
  readonly routingConfig: RoutingRuntimeConfig;
  readonly agentInstructions: AgentInstructionsByAgent;
  readonly maxCharLimit: number;
  readonly concurrency: number;
  readonly retry: RunnerRetryConfig;
  readonly minSeverity: FindingSeverity;
}

export interface ParsedBatchFindings {
  readonly batchId: string;
  readonly agent: AgentName;
  readonly findings: readonly ParsedFinding[];
  readonly warnings: readonly ResponseParserWarning[];
}

export type ReviewPipelineWarningStage = "context" | "runner" | "parser";
export type ReviewPipelineWarningLevel = "warning" | "error";
export type ReviewPipelineWarningCode =
  | ContextBuilderWarningCode
  | RunnerFailureCode
  | ResponseParserWarningCode;

export interface ReviewPipelineWarning {
  readonly stage: ReviewPipelineWarningStage;
  readonly level: ReviewPipelineWarningLevel;
  readonly code: ReviewPipelineWarningCode;
  readonly message: string;
  readonly filePath?: string;
  readonly batchId?: string;
  readonly agent?: AgentName;
  readonly candidateSource?: ResponseParserCandidateSource;
  readonly candidateIndex?: number;
  readonly recordIndex?: number;
}

export interface ReviewPipelineMetadata {
  readonly contextFileCount: number;
  readonly contextWarningCount: number;
  readonly routedFileCount: number;
  readonly routedAgentCount: number;
  readonly batchCount: number;
  readonly batchCountByAgent: Readonly<Record<string, number>>;
  readonly parsedBatchCount: number;
  readonly parserWarningCount: number;
  readonly failedBatchCount: number;
  readonly failedBatches: readonly BatchRunFailure[];
  readonly runner: RunnerSummary;
  readonly aggregation: AggregationMetadata;
}

export interface RunReviewPipelineResult {
  readonly findings: readonly AggregatedFinding[];
  readonly warnings: readonly ReviewPipelineWarning[];
  readonly metadata: ReviewPipelineMetadata;
  readonly routedFilesByAgent: ReadonlyMap<AgentName, readonly string[]>;
  readonly batches: readonly AgentBatch[];
  readonly parsedBatches: readonly ParsedBatchFindings[];
}

function toFileContextMap(contexts: readonly { filePath: string; fullContent: string; gitDiff: string }[]): Record<string, FileContext> {
  const byPath: Record<string, FileContext> = Object.create(null) as Record<string, FileContext>;
  for (const context of contexts) {
    byPath[context.filePath] = {
      fullContent: context.fullContent,
      gitDiff: context.gitDiff,
    };
  }
  return byPath;
}

function countRoutedFiles(routedFilesByAgent: ReadonlyMap<AgentName, readonly string[]>): number {
  const seenFiles = new Set<string>();
  for (const files of routedFilesByAgent.values()) {
    for (const filePath of files) {
      seenFiles.add(filePath);
    }
  }
  return seenFiles.size;
}

function countBatchesByAgent(batches: readonly AgentBatch[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const batch of batches) {
    counts[batch.agent] = (counts[batch.agent] ?? 0) + 1;
  }
  return counts;
}

function mapContextWarning(warning: ContextBuilderWarning): ReviewPipelineWarning {
  return {
    stage: "context",
    level: "warning",
    code: warning.code,
    message: warning.message,
    filePath: warning.filePath,
  };
}

function mapRunnerFailure(failure: BatchRunFailure): ReviewPipelineWarning {
  return {
    stage: "runner",
    level: failure.isTransient ? "warning" : "error",
    code: failure.code,
    message: failure.message,
    batchId: failure.batchId,
    agent: failure.agent,
  };
}

function parseSuccessfulBatch(success: BatchRunSuccess): ParsedBatchFindings {
  const parsed = parseModelResponse(success.rawOutput);
  return {
    batchId: success.batchId,
    agent: success.agent,
    findings: parsed.findings,
    warnings: parsed.warnings,
  };
}

function mapParserWarnings(parsedBatches: readonly ParsedBatchFindings[]): ReviewPipelineWarning[] {
  const warnings: ReviewPipelineWarning[] = [];
  for (const parsedBatch of parsedBatches) {
    for (const warning of parsedBatch.warnings) {
      warnings.push({
        stage: "parser",
        level: "warning",
        code: warning.code,
        message: warning.message,
        batchId: parsedBatch.batchId,
        agent: parsedBatch.agent,
        candidateSource: warning.candidateSource,
        candidateIndex: warning.candidateIndex,
        recordIndex: warning.recordIndex,
      });
    }
  }
  return warnings;
}

export async function runReviewPipeline(
  input: RunReviewPipelineInput
): Promise<RunReviewPipelineResult> {
  const contextResult = await buildFileContexts(input.repoRootPath, input.mergeBase);
  const contextFilePaths = contextResult.contexts.map((context) => context.filePath);

  const routedFilesByAgent = routeFilesToAgents(contextFilePaths, input.routingConfig);
  const batchesResult = createBatches(
    routedFilesByAgent,
    toFileContextMap(contextResult.contexts),
    input.maxCharLimit
  );

  const runnerResult = await runAgentBatches({
    batches: batchesResult.batches,
    agentInstructions: input.agentInstructions,
    concurrency: input.concurrency,
    retry: input.retry,
  });

  const parsedBatches = runnerResult.successes.map((success) => parseSuccessfulBatch(success));
  const parserWarnings = mapParserWarnings(parsedBatches);

  const aggregationResult = aggregateFindings({
    batches: parsedBatches.map((batch) => batch.findings),
    minSeverity: input.minSeverity,
  });

  const warnings: ReviewPipelineWarning[] = [
    ...contextResult.warnings.map(mapContextWarning),
    ...runnerResult.failures.map(mapRunnerFailure),
    ...parserWarnings,
  ];

  return {
    findings: aggregationResult.findings,
    warnings,
    metadata: {
      contextFileCount: contextResult.contexts.length,
      contextWarningCount: contextResult.warnings.length,
      routedFileCount: countRoutedFiles(routedFilesByAgent),
      routedAgentCount: routedFilesByAgent.size,
      batchCount: batchesResult.batches.length,
      batchCountByAgent: countBatchesByAgent(batchesResult.batches),
      parsedBatchCount: parsedBatches.length,
      parserWarningCount: parserWarnings.length,
      failedBatchCount: runnerResult.failures.length,
      failedBatches: runnerResult.failures,
      runner: runnerResult.summary,
      aggregation: aggregationResult.metadata,
    },
    routedFilesByAgent,
    batches: batchesResult.batches,
    parsedBatches,
  };
}

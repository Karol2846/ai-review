import { createHash } from "node:crypto";

import { AGENT_NAMES, type AgentName } from "./routingTypes";

const BASE_BATCH_FRAMING_OVERHEAD = 160;
const BASE_FILE_FRAMING_OVERHEAD = 120;
const CHUNK_METADATA_OVERHEAD = 40;

export interface FileContext {
  readonly fullContent: string;
  readonly gitDiff: string;
}

export type RoutedFilesByAgent = ReadonlyMap<AgentName, readonly string[]>;
export type FileContextsByPath =
  | ReadonlyMap<string, FileContext>
  | Readonly<Record<string, FileContext>>;

export interface BatchChunk {
  readonly agent: AgentName;
  readonly filePath: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly fullContent: string;
  readonly gitDiff: string;
  readonly fullContentRange: readonly [start: number, end: number];
  readonly gitDiffRange: readonly [start: number, end: number];
  readonly estimatedChars: number;
}

export interface AgentBatch {
  readonly id: string;
  readonly agent: AgentName;
  readonly batchIndex: number;
  readonly totalBatches: number;
  readonly estimatedChars: number;
  readonly chunks: readonly BatchChunk[];
}

export interface CreateBatchesResult {
  readonly batches: readonly AgentBatch[];
  readonly batchesByAgent: ReadonlyMap<AgentName, readonly AgentBatch[]>;
}

class BatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatcherError";
  }
}

function toDeterministicAgentList(routedFiles: RoutedFilesByAgent): AgentName[] {
  const agents = [...routedFiles.keys()];
  const configuredAgentSet = new Set(agents);
  const defaultAgentsInOrder = AGENT_NAMES.filter((agent) => configuredAgentSet.has(agent));
  const defaultAgentSet = new Set<string>(defaultAgentsInOrder);
  const dynamicAgents = agents.filter((agent) => !defaultAgentSet.has(agent)).sort();

  return [...defaultAgentsInOrder, ...dynamicAgents];
}

function toDeterministicUniqueList(files: readonly string[]): string[] {
  return [...new Set(files)].sort();
}

function getFileContext(fileContexts: FileContextsByPath, filePath: string): FileContext | undefined {
  if (fileContexts instanceof Map) {
    return fileContexts.get(filePath);
  }

  const byPath = fileContexts as Readonly<Record<string, FileContext>>;
  return byPath[filePath];
}

function estimateBatchFramingOverhead(agent: AgentName): number {
  return BASE_BATCH_FRAMING_OVERHEAD + agent.length;
}

function estimateFileFramingOverhead(filePath: string): number {
  return BASE_FILE_FRAMING_OVERHEAD + CHUNK_METADATA_OVERHEAD + filePath.length;
}

function sanitizeForId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized.length > 0 ? normalized : "agent";
}

function buildBatchId(agent: AgentName, batchIndex: number, chunks: readonly BatchChunk[]): string {
  const signature = chunks
    .map((chunk) =>
      [
        chunk.filePath,
        `${chunk.chunkIndex}/${chunk.totalChunks}`,
        `${chunk.fullContentRange[0]}-${chunk.fullContentRange[1]}`,
        `${chunk.gitDiffRange[0]}-${chunk.gitDiffRange[1]}`,
      ].join(":")
    )
    .join("|");
  const digest = createHash("sha256").update(signature).digest("hex").slice(0, 12);

  return `${sanitizeForId(agent)}-${String(batchIndex + 1).padStart(4, "0")}-${digest}`;
}

interface ChunkDraft {
  readonly fullContent: string;
  readonly gitDiff: string;
  readonly fullContentRange: readonly [start: number, end: number];
  readonly gitDiffRange: readonly [start: number, end: number];
}

function chunkFileContext(
  agent: AgentName,
  filePath: string,
  context: FileContext,
  maxCharLimit: number
): BatchChunk[] {
  const batchOverhead = estimateBatchFramingOverhead(agent);
  const fileOverhead = estimateFileFramingOverhead(filePath);
  const payloadBudget = maxCharLimit - batchOverhead - fileOverhead;

  if (payloadBudget <= 0) {
    throw new BatcherError(
      `Max char limit (${maxCharLimit}) is too small for required framing overhead on "${filePath}".`
    );
  }

  const fullContent = context.fullContent ?? "";
  const gitDiff = context.gitDiff ?? "";

  const drafts: ChunkDraft[] = [];

  if (fullContent.length === 0 && gitDiff.length === 0) {
    drafts.push({
      fullContent: "",
      gitDiff: "",
      fullContentRange: [0, 0],
      gitDiffRange: [0, 0],
    });
  } else {
    let fullCursor = 0;
    let diffCursor = 0;

    while (fullCursor < fullContent.length || diffCursor < gitDiff.length) {
      const fullStart = fullCursor;
      const diffStart = diffCursor;

      let remaining = payloadBudget;

      if (fullCursor < fullContent.length) {
        const fullChunkLength = Math.min(remaining, fullContent.length - fullCursor);
        fullCursor += fullChunkLength;
        remaining -= fullChunkLength;
      }

      if (remaining > 0 && diffCursor < gitDiff.length) {
        const diffChunkLength = Math.min(remaining, gitDiff.length - diffCursor);
        diffCursor += diffChunkLength;
        remaining -= diffChunkLength;
      }

      const chunkFullContent = fullContent.slice(fullStart, fullCursor);
      const chunkGitDiff = gitDiff.slice(diffStart, diffCursor);

      if (chunkFullContent.length === 0 && chunkGitDiff.length === 0) {
        throw new BatcherError(`Failed to create non-empty chunk for "${filePath}".`);
      }

      drafts.push({
        fullContent: chunkFullContent,
        gitDiff: chunkGitDiff,
        fullContentRange: [fullStart, fullCursor],
        gitDiffRange: [diffStart, diffCursor],
      });
    }
  }

  const totalChunks = drafts.length;
  return drafts.map((draft, chunkIndex) => ({
    agent,
    filePath,
    chunkIndex,
    totalChunks,
    fullContent: draft.fullContent,
    gitDiff: draft.gitDiff,
    fullContentRange: draft.fullContentRange,
    gitDiffRange: draft.gitDiffRange,
    estimatedChars: fileOverhead + draft.fullContent.length + draft.gitDiff.length,
  }));
}

function packAgentChunks(
  agent: AgentName,
  chunks: readonly BatchChunk[],
  maxCharLimit: number
): readonly AgentBatch[] {
  const batchOverhead = estimateBatchFramingOverhead(agent);

  type MutableBatch = { estimatedChars: number; chunks: BatchChunk[] };
  const mutableBatches: MutableBatch[] = [];

  let currentBatch: MutableBatch = { estimatedChars: batchOverhead, chunks: [] };

  for (const chunk of chunks) {
    if (batchOverhead + chunk.estimatedChars > maxCharLimit) {
      throw new BatcherError(
        `Chunk for "${chunk.filePath}" exceeds max char limit (${maxCharLimit}) even after chunking.`
      );
    }

    if (
      currentBatch.chunks.length > 0 &&
      currentBatch.estimatedChars + chunk.estimatedChars > maxCharLimit
    ) {
      mutableBatches.push(currentBatch);
      currentBatch = { estimatedChars: batchOverhead, chunks: [] };
    }

    currentBatch.chunks.push(chunk);
    currentBatch.estimatedChars += chunk.estimatedChars;
  }

  if (currentBatch.chunks.length > 0) {
    mutableBatches.push(currentBatch);
  }

  const totalBatches = mutableBatches.length;
  return mutableBatches.map((batch, batchIndex) => ({
    id: buildBatchId(agent, batchIndex, batch.chunks),
    agent,
    batchIndex,
    totalBatches,
    estimatedChars: batch.estimatedChars,
    chunks: batch.chunks,
  }));
}

export function createBatches(
  routedFiles: RoutedFilesByAgent,
  fileContexts: FileContextsByPath,
  maxCharLimit: number
): CreateBatchesResult {
  if (!Number.isFinite(maxCharLimit) || maxCharLimit <= 0) {
    throw new BatcherError(`"maxCharLimit" must be a positive finite number. Received: ${maxCharLimit}`);
  }

  const batchesByAgent = new Map<AgentName, readonly AgentBatch[]>();
  const allBatches: AgentBatch[] = [];

  for (const agent of toDeterministicAgentList(routedFiles)) {
    const files = toDeterministicUniqueList(routedFiles.get(agent) ?? []);
    const agentChunks: BatchChunk[] = [];

    for (const filePath of files) {
      const context = getFileContext(fileContexts, filePath);
      if (!context) {
        throw new BatcherError(`Missing file context for routed file "${filePath}" (agent "${agent}").`);
      }

      agentChunks.push(...chunkFileContext(agent, filePath, context, maxCharLimit));
    }

    const agentBatches = packAgentChunks(agent, agentChunks, maxCharLimit);
    batchesByAgent.set(agent, agentBatches);
    allBatches.push(...agentBatches);
  }

  return {
    batches: allBatches,
    batchesByAgent,
  };
}

import type { AgentBatch, BatchChunk } from "./batcher";

const EMPTY_SECTION_SENTINEL = "<empty>";
const DELIMITER_COLLISION_PATTERN = /^###(?=\s)/gmu;
const DELIMITER_COLLISION_REPLACEMENT = "##\\#";

export interface BuildAgentBatchPromptInput {
  readonly agentInstruction: string;
  readonly batch: AgentBatch;
}

class PromptBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptBuilderError";
  }
}

function sanitizeForDelimitedPrompt(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  const sanitized = normalized.replace(DELIMITER_COLLISION_PATTERN, DELIMITER_COLLISION_REPLACEMENT);
  return sanitized.length > 0 ? sanitized : EMPTY_SECTION_SENTINEL;
}

function compareChunks(a: BatchChunk, b: BatchChunk): number {
  if (a.filePath !== b.filePath) {
    return a.filePath < b.filePath ? -1 : 1;
  }

  if (a.chunkIndex !== b.chunkIndex) {
    return a.chunkIndex - b.chunkIndex;
  }

  if (a.fullContentRange[0] !== b.fullContentRange[0]) {
    return a.fullContentRange[0] - b.fullContentRange[0];
  }

  return a.gitDiffRange[0] - b.gitDiffRange[0];
}

function toStableChunkOrder(chunks: readonly BatchChunk[]): BatchChunk[] {
  return [...chunks].sort(compareChunks);
}

function renderChunk(chunk: BatchChunk): string {
  return [
    "### FILE",
    `path: ${sanitizeForDelimitedPrompt(chunk.filePath)}`,
    `chunk: ${chunk.chunkIndex + 1}/${chunk.totalChunks}`,
    `full_content_range: ${chunk.fullContentRange[0]}-${chunk.fullContentRange[1]}`,
    `git_diff_range: ${chunk.gitDiffRange[0]}-${chunk.gitDiffRange[1]}`,
    "### FULL_CONTENT",
    sanitizeForDelimitedPrompt(chunk.fullContent),
    "### GIT_DIFF",
    sanitizeForDelimitedPrompt(chunk.gitDiff),
  ].join("\n");
}

function renderOutputRequirements(agent: string): string {
  return [
    "### OUTPUT_REQUIREMENTS",
    "Return ONLY a valid JSON array.",
    "Do not include markdown fences, commentary, headers, or trailing text.",
    "The response must start with `[` and end with `]`.",
    `Every finding must include "agent":"${agent}".`,
    "Use only files and line ranges present in this prompt.",
    'Required fields per finding: "file", "line", "agent", "severity", "category", "message", "suggestion".',
    'Optional field: "endLine".',
  ].join("\n");
}

export function buildAgentBatchPrompt(input: BuildAgentBatchPromptInput): string {
  const instruction = input.agentInstruction.trim();
  if (instruction.length === 0) {
    throw new PromptBuilderError('"agentInstruction" must not be empty.');
  }

  if (input.batch.chunks.length === 0) {
    throw new PromptBuilderError(`Batch "${input.batch.id}" must include at least one chunk.`);
  }

  const orderedChunks = toStableChunkOrder(input.batch.chunks);
  const renderedChunks = orderedChunks.map(renderChunk).join("\n\n");

  return [
    "### AGENT_INSTRUCTION",
    sanitizeForDelimitedPrompt(instruction),
    "### BATCH",
    `agent: ${input.batch.agent}`,
    `batch_id: ${input.batch.id}`,
    `batch: ${input.batch.batchIndex + 1}/${input.batch.totalBatches}`,
    `chunk_count: ${orderedChunks.length}`,
    'delimiter_sanitization: source lines starting with "### " are escaped to "##\\# "',
    renderedChunks,
    renderOutputRequirements(input.batch.agent),
  ].join("\n\n");
}

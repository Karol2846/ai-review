import { createHash } from "node:crypto";

import type { ParsedFinding } from "./responseParser";

const SEVERITY_ORDER = ["critical", "warning", "info"] as const;
const FINGERPRINT_VERSION = "v2";

export type FindingSeverity = (typeof SEVERITY_ORDER)[number];

export interface AggregatedFinding extends Omit<ParsedFinding, "severity"> {
  readonly severity: FindingSeverity;
  readonly fingerprint: string;
}

export interface SeverityCounts {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

type MutableSeverityCounts = {
  -readonly [K in keyof SeverityCounts]: number;
};

export interface AggregationDedupStats {
  readonly totalBeforeDedup: number;
  readonly totalAfterDedup: number;
  readonly duplicatesRemoved: number;
  readonly collisionGroupCount: number;
}

export interface AggregationMetadata {
  readonly batchCount: number;
  readonly minSeverity: FindingSeverity;
  readonly inputFindingCount: number;
  readonly findingsAfterSeverityFilter: number;
  readonly filteredOutBySeverity: number;
  readonly filteredOutByUnknownSeverity: number;
  readonly countsBySeverity: SeverityCounts;
  readonly dedup: AggregationDedupStats;
}

export interface AggregateFindingsInput {
  readonly batches: readonly (readonly ParsedFinding[])[];
  readonly minSeverity: FindingSeverity;
}

export interface AggregateFindingsResult {
  readonly findings: AggregatedFinding[];
  readonly metadata: AggregationMetadata;
}

export class AggregatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregatorError";
  }
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeTextToken(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeFilePath(filePath: string): string {
  return normalizeWhitespace(filePath).replace(/\\/gu, "/").replace(/\/+/gu, "/");
}

function toFindingSeverity(value: string): FindingSeverity | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "critical" || normalized === "warning" || normalized === "info") {
    return normalized;
  }
  return undefined;
}

export function isFindingSeverity(value: string): value is FindingSeverity {
  return toFindingSeverity(value) !== undefined;
}

function assertMinSeverity(value: string): FindingSeverity {
  const normalized = toFindingSeverity(value);
  if (normalized === undefined) {
    throw new AggregatorError(
      `Unsupported minSeverity "${value}". Expected one of: ${SEVERITY_ORDER.join(", ")}.`
    );
  }
  return normalized;
}

function severityRank(severity: FindingSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function dedupeChoiceKey(finding: AggregatedFinding): string {
  return [
    normalizeFilePath(finding.file),
    finding.line.toString(10),
    (finding.endLine ?? finding.line).toString(10),
    normalizeTextToken(finding.category),
    normalizeTextToken(finding.message),
    normalizeTextToken(finding.suggestion),
    normalizeTextToken(finding.agent),
  ].join("\u001f");
}

function compareForDedupeChoice(left: AggregatedFinding, right: AggregatedFinding): number {
  const severityDiff = compareNumbers(severityRank(left.severity), severityRank(right.severity));
  if (severityDiff !== 0) {
    return severityDiff;
  }
  return compareStrings(dedupeChoiceKey(left), dedupeChoiceKey(right));
}

function compareForOutput(left: AggregatedFinding, right: AggregatedFinding): number {
  const severityDiff = compareNumbers(severityRank(left.severity), severityRank(right.severity));
  if (severityDiff !== 0) {
    return severityDiff;
  }

  const fileDiff = compareStrings(left.file, right.file);
  if (fileDiff !== 0) {
    return fileDiff;
  }

  const lineDiff = compareNumbers(left.line, right.line);
  if (lineDiff !== 0) {
    return lineDiff;
  }

  const endLineDiff = compareNumbers(left.endLine ?? left.line, right.endLine ?? right.line);
  if (endLineDiff !== 0) {
    return endLineDiff;
  }

  const categoryDiff = compareStrings(left.category, right.category);
  if (categoryDiff !== 0) {
    return categoryDiff;
  }

  const messageDiff = compareStrings(left.message, right.message);
  if (messageDiff !== 0) {
    return messageDiff;
  }

  const suggestionDiff = compareStrings(left.suggestion, right.suggestion);
  if (suggestionDiff !== 0) {
    return suggestionDiff;
  }

  const agentDiff = compareStrings(left.agent, right.agent);
  if (agentDiff !== 0) {
    return agentDiff;
  }

  return compareStrings(left.fingerprint, right.fingerprint);
}

function emptySeverityCounts(): MutableSeverityCounts {
  return {
    critical: 0,
    warning: 0,
    info: 0,
  };
}

function countBySeverity(findings: readonly AggregatedFinding[]): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

export function buildFindingFingerprint(finding: ParsedFinding): string {
  const payload = [
    FINGERPRINT_VERSION,
    normalizeFilePath(finding.file),
    finding.line.toString(10),
    (finding.endLine ?? finding.line).toString(10),
    normalizeTextToken(finding.category),
    normalizeTextToken(finding.message),
  ].join("\u001f");

  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function aggregateFindings(input: AggregateFindingsInput): AggregateFindingsResult {
  const minSeverity = assertMinSeverity(input.minSeverity);
  const minSeverityRank = severityRank(minSeverity);

  let inputFindingCount = 0;
  let filteredOutBySeverity = 0;
  let filteredOutByUnknownSeverity = 0;
  const findingsAfterSeverityFilter: AggregatedFinding[] = [];

  for (const batchFindings of input.batches) {
    for (const finding of batchFindings) {
      inputFindingCount += 1;

      const normalizedSeverity = toFindingSeverity(finding.severity);
      if (normalizedSeverity === undefined) {
        filteredOutByUnknownSeverity += 1;
        filteredOutBySeverity += 1;
        continue;
      }

      if (severityRank(normalizedSeverity) > minSeverityRank) {
        filteredOutBySeverity += 1;
        continue;
      }

      findingsAfterSeverityFilter.push({
        ...finding,
        severity: normalizedSeverity,
        fingerprint: buildFindingFingerprint(finding),
      });
    }
  }

  const groupedByFingerprint = new Map<string, AggregatedFinding[]>();
  for (const finding of findingsAfterSeverityFilter) {
    const bucket = groupedByFingerprint.get(finding.fingerprint);
    if (bucket) {
      bucket.push(finding);
    } else {
      groupedByFingerprint.set(finding.fingerprint, [finding]);
    }
  }

  let duplicateCount = 0;
  let collisionGroupCount = 0;
  const deduped: AggregatedFinding[] = [];
  for (const group of groupedByFingerprint.values()) {
    if (group.length > 1) {
      duplicateCount += group.length - 1;
      collisionGroupCount += 1;
    }

    const selected = [...group].sort(compareForDedupeChoice)[0];
    if (selected) {
      deduped.push(selected);
    }
  }

  deduped.sort(compareForOutput);

  return {
    findings: deduped,
    metadata: {
      batchCount: input.batches.length,
      minSeverity,
      inputFindingCount,
      findingsAfterSeverityFilter: findingsAfterSeverityFilter.length,
      filteredOutBySeverity,
      filteredOutByUnknownSeverity,
      countsBySeverity: countBySeverity(deduped),
      dedup: {
        totalBeforeDedup: findingsAfterSeverityFilter.length,
        totalAfterDedup: deduped.length,
        duplicatesRemoved: duplicateCount,
        collisionGroupCount,
      },
    },
  };
}

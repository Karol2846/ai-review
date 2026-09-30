import type { Finding } from "./findingSchema";

/**
 * How many lines around a changed hunk still count as "in the diff". Covers findings that point
 * at the enclosing signature or a neighbouring line directly affected by the change.
 */
export const DEFAULT_DIFF_LINE_TOLERANCE = 3;

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu;

export type FindingValidationCode = "UNKNOWN_FILE" | "LINE_OUT_OF_RANGE" | "LINE_OUTSIDE_DIFF";

export interface FindingValidationContext {
  readonly filePath: string;
  readonly fullContent: string;
  readonly gitDiff: string;
}

export interface DroppedFinding {
  readonly finding: Finding;
  readonly code: FindingValidationCode;
  readonly message: string;
}

export interface ValidateFindingsResult {
  readonly findings: Finding[];
  readonly dropped: DroppedFinding[];
}

export type LineRange = readonly [start: number, end: number];

interface FileLineInfo {
  readonly lineCount: number;
  readonly changedRanges: readonly LineRange[];
}

/**
 * New-side line ranges covered by each hunk of a unified diff (`@@ -a,b +c,d @@` → `[c, c+d-1]`).
 * A pure-deletion hunk (`d = 0`) maps to the line the deletion happened at.
 */
export function parseChangedLineRanges(gitDiff: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const match of gitDiff.matchAll(HUNK_HEADER_PATTERN)) {
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    const first = Math.max(start, 1);
    ranges.push([first, Math.max(first, start + length - 1)]);
  }
  return ranges;
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const newlines = content.match(/\n/gu)?.length ?? 0;
  return content.endsWith("\n") ? newlines : newlines + 1;
}

function normalizeFindingPath(filePath: string): string {
  return filePath.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
}

function overlapsChangedRange(
  line: number,
  endLine: number,
  ranges: readonly LineRange[],
  tolerance: number
): boolean {
  return ranges.some(([start, end]) => line <= end + tolerance && endLine >= start - tolerance);
}

/**
 * Drops findings the model could not have grounded in the reviewed diff: unknown files, lines past
 * the end of the file, and lines outside every changed hunk (± `tolerance`). Files whose diff has
 * no hunks (binary, mode-only) skip the hunk check.
 */
export function validateFindings(
  findings: readonly Finding[],
  contexts: readonly FindingValidationContext[],
  tolerance: number = DEFAULT_DIFF_LINE_TOLERANCE
): ValidateFindingsResult {
  const infoByPath = new Map<string, FileLineInfo>();
  for (const context of contexts) {
    infoByPath.set(context.filePath, {
      lineCount: countLines(context.fullContent),
      changedRanges: parseChangedLineRanges(context.gitDiff),
    });
  }

  const valid: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of findings) {
    const filePath = normalizeFindingPath(finding.file);
    const info = infoByPath.get(filePath);
    const location = `${finding.file}:${finding.line}`;

    if (info === undefined) {
      dropped.push({
        finding,
        code: "UNKNOWN_FILE",
        message: `Dropped ${finding.agent} finding at ${location}: file was not part of the review.`,
      });
      continue;
    }

    if (finding.line > Math.max(info.lineCount, 1)) {
      dropped.push({
        finding,
        code: "LINE_OUT_OF_RANGE",
        message: `Dropped ${finding.agent} finding at ${location}: file has only ${info.lineCount} lines.`,
      });
      continue;
    }

    const endLine = Math.min(finding.endLine ?? finding.line, Math.max(info.lineCount, finding.line));
    if (
      info.changedRanges.length > 0 &&
      !overlapsChangedRange(finding.line, endLine, info.changedRanges, tolerance)
    ) {
      dropped.push({
        finding,
        code: "LINE_OUTSIDE_DIFF",
        message: `Dropped ${finding.agent} finding at ${location}: line is outside the changed hunks.`,
      });
      continue;
    }

    valid.push({
      ...finding,
      file: filePath,
      ...(finding.endLine !== undefined ? { endLine } : {}),
    });
  }

  return { findings: valid, dropped };
}

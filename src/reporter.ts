import chalk, { Chalk, type ChalkInstance } from "chalk";

import type { FindingSeverity } from "./aggregator";

const REPORT_DIVIDER = "─────────────────────────────────────────";

export interface ReporterFinding {
  readonly file: string;
  readonly line: number;
  readonly agent: string;
  readonly category: string;
  readonly severity: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface RenderReportOptions {
  readonly color?: boolean;
}

function severityRank(severity: string): number {
  switch (severity.trim().toLowerCase()) {
    case "critical":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
    default:
      return 3;
  }
}

function compareFindings(left: ReporterFinding, right: ReporterFinding): number {
  if (left.file !== right.file) {
    return left.file < right.file ? -1 : 1;
  }

  const severityDiff = severityRank(left.severity) - severityRank(right.severity);
  if (severityDiff !== 0) {
    return severityDiff;
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  if (left.agent !== right.agent) {
    return left.agent < right.agent ? -1 : 1;
  }

  if (left.category !== right.category) {
    return left.category < right.category ? -1 : 1;
  }

  if (left.message !== right.message) {
    return left.message < right.message ? -1 : 1;
  }

  const leftSuggestion = left.suggestion ?? "";
  const rightSuggestion = right.suggestion ?? "";
  if (leftSuggestion !== rightSuggestion) {
    return leftSuggestion < rightSuggestion ? -1 : 1;
  }

  return 0;
}

function normalizedSeverity(severity: string): FindingSeverity | "unknown" {
  const normalized = severity.trim().toLowerCase();
  if (normalized === "critical" || normalized === "warning" || normalized === "info") {
    return normalized;
  }
  return "unknown";
}

function severityIcon(chalkInstance: ChalkInstance, severity: string): string {
  switch (normalizedSeverity(severity)) {
    case "critical":
      return chalkInstance.red("●");
    case "warning":
      return chalkInstance.yellow("●");
    case "info":
      return chalkInstance.cyan("●");
    default:
      return "○";
  }
}

function severityLabel(chalkInstance: ChalkInstance, severity: string): string {
  switch (normalizedSeverity(severity)) {
    case "critical":
      return chalkInstance.red("critical");
    case "warning":
      return chalkInstance.yellow("warning");
    case "info":
      return chalkInstance.cyan("info");
    default:
      return severity.trim().length > 0 ? severity : "unknown";
  }
}

function toChalk(useColor: boolean): ChalkInstance {
  return useColor ? chalk : new Chalk({ level: 0 });
}

export function renderReport(
  findings: readonly ReporterFinding[],
  options: RenderReportOptions = {}
): string {
  const useColor = options.color ?? true;
  const chalkInstance = toChalk(useColor);
  const sortedFindings = [...findings].sort(compareFindings);
  const lines: string[] = [];

  let currentFile = "";
  for (const finding of sortedFindings) {
    if (finding.file !== currentFile) {
      if (currentFile.length > 0) {
        lines.push("");
      }

      lines.push(chalkInstance.bold(`━━━ ${finding.file} ━━━`));
      lines.push("");
      currentFile = finding.file;
    }

    lines.push(
      `  ${severityIcon(chalkInstance, finding.severity)} ${severityLabel(chalkInstance, finding.severity)} ${chalkInstance.dim(`[${finding.agent}/${finding.category}]`)} ${chalkInstance.white(`L${finding.line}`)}`
    );
    lines.push(`    ${finding.message}`);

    const suggestion = finding.suggestion?.trim();
    if (suggestion && suggestion.length > 0) {
      lines.push(`    ${chalkInstance.green(`→ ${suggestion}`)}`);
    }

    lines.push("");
  }

  const uniqueFiles = new Set(sortedFindings.map((finding) => finding.file)).size;
  const uniqueAgents = new Set(sortedFindings.map((finding) => finding.agent)).size;
  lines.push(chalkInstance.dim(REPORT_DIVIDER));
  lines.push(
    chalkInstance.dim(
      `${sortedFindings.length} findings across ${uniqueFiles} files from ${uniqueAgents} agents`
    )
  );

  return lines.join("\n");
}


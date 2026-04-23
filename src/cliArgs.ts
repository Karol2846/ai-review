import { parseArgs } from "node:util";

import { isFindingSeverity, type FindingSeverity } from "./aggregator";
import { AGENT_NAMES } from "./routingTypes";

const DEFAULT_MAX_PARALLEL = 5;
const DEFAULT_SEVERITY: FindingSeverity = "info";

export interface CliOptions {
  readonly annotate: boolean;
  readonly report: boolean;
  readonly clean: boolean;
  readonly json: boolean;
  readonly debug: boolean;
  readonly showHelp: boolean;
  readonly baseBranch?: string;
  readonly agents: readonly string[];
  readonly agentsCsv: string;
  readonly minSeverity: FindingSeverity;
  readonly fileFilter?: string;
  readonly maxParallel: number;
}

export class CliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgsError";
  }
}

function parseCsvList(value: string, optionName: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new CliArgsError(`"${optionName}" must include at least one non-empty value.`);
  }

  return entries;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new CliArgsError(`"${optionName}" must be a positive integer. Received: "${value}".`);
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliArgsError(`"${optionName}" must be a positive integer. Received: "${value}".`);
  }

  return parsed;
}

function parseOptionalNonEmpty(value: string | undefined, optionName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new CliArgsError(`"${optionName}" must not be empty.`);
  }

  return normalized;
}

function parseSeverity(value: string | undefined): FindingSeverity {
  if (value === undefined) {
    return DEFAULT_SEVERITY;
  }

  const normalized = value.trim().toLowerCase();
  if (!isFindingSeverity(normalized)) {
    throw new CliArgsError(
      `"--severity" must be one of: critical, warning, info. Received: "${value}".`
    );
  }

  return normalized;
}

export function formatCliUsage(): string {
  return [
    "ai-review - Multi-Agent Local Code Review",
    "",
    "Usage: ai-review [OPTIONS]",
    "",
    "Options:",
    "  --base <branch>    Base branch for diff (default: auto-detect)",
    "  --report           Print terminal report (annotations are default)",
    "  --clean            Remove previous [ai-review] TODO comments",
    "  --agents <list>    Comma-separated agent list (default: all)",
    "  --severity <min>   Minimum severity: critical, warning, info (default: info)",
    "  --files <glob>     Filter changed files by glob pattern",
    "  --json             Output raw JSON findings",
    "  --debug            Show raw agent output and timings for debugging",
    "  --parallel <n>     Max parallel agent invocations (default: 5)",
    "  -h, --help         Show this help",
  ].join("\n");
}

function readOptionalStringValue(value: unknown, optionName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    throw new CliArgsError(`"${optionName}" must be provided at most once.`);
  }

  if (typeof value !== "string") {
    throw new CliArgsError(`"${optionName}" must be a string.`);
  }

  return value;
}

function readBooleanFlag(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }

  if (Array.isArray(value) || typeof value !== "boolean") {
    throw new CliArgsError("Boolean flags must not be repeated with non-boolean values.");
  }

  return value;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let parsedValues: ReturnType<typeof parseArgs>["values"];

  try {
    parsedValues = parseArgs({
      args: [...argv],
      options: {
        report: { type: "boolean" },
        clean: { type: "boolean" },
        json: { type: "boolean" },
        debug: { type: "boolean" },
        base: { type: "string" },
        agents: { type: "string" },
        severity: { type: "string" },
        files: { type: "string" },
        parallel: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    if (error instanceof Error && error.message.trim().length > 0) {
      throw new CliArgsError(error.message.trim());
    }
    throw new CliArgsError("Failed to parse CLI arguments.");
  }

  const baseBranch = parseOptionalNonEmpty(readOptionalStringValue(parsedValues.base, "--base"), "--base");
  const agentsValue = readOptionalStringValue(parsedValues.agents, "--agents");
  const agents = agentsValue
    ? parseCsvList(agentsValue, "--agents")
    : [...AGENT_NAMES];
  const minSeverity = parseSeverity(readOptionalStringValue(parsedValues.severity, "--severity"));
  const fileFilter = parseOptionalNonEmpty(
    readOptionalStringValue(parsedValues.files, "--files"),
    "--files"
  );
  const parallelValue = readOptionalStringValue(parsedValues.parallel, "--parallel");
  const maxParallel = parallelValue
    ? parsePositiveInteger(parallelValue, "--parallel")
    : DEFAULT_MAX_PARALLEL;

  return {
    annotate: true,
    report: readBooleanFlag(parsedValues.report),
    clean: readBooleanFlag(parsedValues.clean),
    json: readBooleanFlag(parsedValues.json),
    debug: readBooleanFlag(parsedValues.debug),
    showHelp: readBooleanFlag(parsedValues.help),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    agents,
    agentsCsv: agents.join(","),
    minSeverity,
    ...(fileFilter !== undefined ? { fileFilter } : {}),
    maxParallel,
  };
}

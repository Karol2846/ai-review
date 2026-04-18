export interface ParsedFinding {
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
  readonly agent: string;
  readonly severity: string;
  readonly category: string;
  readonly message: string;
  readonly suggestion: string;
}

export type ResponseParserWarningCode =
  | "NO_JSON_ARRAY_FOUND"
  | "NO_VALID_FINDINGS"
  | "INVALID_RECORD";

export type ResponseParserCandidateSource = "entire" | "fenced-json" | "fenced" | "inline-array";

export interface ResponseParserWarning {
  readonly code: ResponseParserWarningCode;
  readonly message: string;
  readonly candidateSource?: ResponseParserCandidateSource;
  readonly candidateIndex?: number;
  readonly recordIndex?: number;
}

export interface ParseResponseResult {
  readonly findings: ParsedFinding[];
  readonly warnings: ResponseParserWarning[];
}

interface ExtractionCandidate {
  readonly source: ResponseParserCandidateSource;
  readonly start: number;
  readonly raw: string;
}

interface ParsedCandidate extends ExtractionCandidate {
  readonly records: readonly unknown[];
}

interface EvaluatedCandidate extends ParsedCandidate {
  readonly findings: ParsedFinding[];
  readonly warnings: ResponseParserWarning[];
  readonly invalidCount: number;
}

const REQUIRED_STRING_FIELDS = [
  "file",
  "agent",
  "severity",
  "category",
  "message",
  "suggestion",
] as const;

type RequiredStringField = (typeof REQUIRED_STRING_FIELDS)[number];

function normalizeOutput(rawOutput: string): string {
  return rawOutput.replace(/\r\n?/gu, "\n");
}

function sourceRank(source: ResponseParserCandidateSource): number {
  switch (source) {
    case "entire":
      return 0;
    case "fenced-json":
      return 1;
    case "fenced":
      return 2;
    case "inline-array":
      return 3;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyStringField(
  record: Record<string, unknown>,
  field: RequiredStringField,
  reasons: string[]
): string | undefined {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    reasons.push(`"${field}" must be a non-empty string`);
    return undefined;
  }

  return value;
}

function readPositiveIntegerField(
  record: Record<string, unknown>,
  field: "line" | "endLine",
  reasons: string[],
  required: boolean
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    if (required) {
      reasons.push(`"${field}" is required`);
    }
    return undefined;
  }

  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    reasons.push(`"${field}" must be a positive integer`);
    return undefined;
  }

  return value;
}

function collectBracketArrayCandidates(text: string): ExtractionCandidate[] {
  const candidates: ExtractionCandidate[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let arrayStart = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[") {
      if (depth === 0) {
        arrayStart = index;
      }
      depth += 1;
      continue;
    }

    if (char === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0 && arrayStart >= 0) {
        candidates.push({
          source: "inline-array",
          start: arrayStart,
          raw: text.slice(arrayStart, index + 1),
        });
        arrayStart = -1;
      }
    }
  }

  return candidates;
}

function addCandidate(
  candidateMap: Map<string, ExtractionCandidate>,
  source: ResponseParserCandidateSource,
  start: number,
  raw: string
): void {
  const normalizedRaw = raw.trim();
  if (normalizedRaw.length === 0) {
    return;
  }

  const key = `${start}:${normalizedRaw}`;
  const candidate: ExtractionCandidate = {
    source,
    start,
    raw: normalizedRaw,
  };

  const existing = candidateMap.get(key);
  if (!existing || sourceRank(candidate.source) < sourceRank(existing.source)) {
    candidateMap.set(key, candidate);
  }
}

function collectExtractionCandidates(text: string): ExtractionCandidate[] {
  const candidateMap = new Map<string, ExtractionCandidate>();
  const firstNonWhitespace = text.search(/\S/u);

  if (firstNonWhitespace >= 0) {
    addCandidate(candidateMap, "entire", firstNonWhitespace, text.slice(firstNonWhitespace));
  }

  const codeFencePattern = /```([a-zA-Z0-9_-]+)?[ \t]*\n([\s\S]*?)```/gu;
  for (const match of text.matchAll(codeFencePattern)) {
    const language = (match[1] ?? "").trim().toLowerCase();
    const source: ResponseParserCandidateSource = language === "json" ? "fenced-json" : "fenced";
    addCandidate(candidateMap, source, match.index ?? 0, match[2] ?? "");
  }

  for (const candidate of collectBracketArrayCandidates(text)) {
    addCandidate(candidateMap, candidate.source, candidate.start, candidate.raw);
  }

  return [...candidateMap.values()].sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }

    const rankDiff = sourceRank(a.source) - sourceRank(b.source);
    if (rankDiff !== 0) {
      return rankDiff;
    }

    return a.raw.length - b.raw.length;
  });
}

function toParsedArrayCandidates(candidates: readonly ExtractionCandidate[]): ParsedCandidate[] {
  const parsedCandidates: ParsedCandidate[] = [];

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.raw) as unknown;
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    parsedCandidates.push({
      ...candidate,
      records: parsed,
    });
  }

  return parsedCandidates;
}

function validateRecord(
  record: unknown,
  recordIndex: number,
  candidate: ParsedCandidate,
  candidateIndex: number
): { finding?: ParsedFinding; warning?: ResponseParserWarning } {
  if (!isPlainObject(record)) {
    return {
      warning: {
        code: "INVALID_RECORD",
        message: `Dropped record at index ${recordIndex}: expected an object.`,
        candidateSource: candidate.source,
        candidateIndex,
        recordIndex,
      },
    };
  }

  const reasons: string[] = [];
  const file = readNonEmptyStringField(record, "file", reasons);
  const agent = readNonEmptyStringField(record, "agent", reasons);
  const severity = readNonEmptyStringField(record, "severity", reasons);
  const category = readNonEmptyStringField(record, "category", reasons);
  const message = readNonEmptyStringField(record, "message", reasons);
  const suggestion = readNonEmptyStringField(record, "suggestion", reasons);
  const line = readPositiveIntegerField(record, "line", reasons, true);
  const endLine = readPositiveIntegerField(record, "endLine", reasons, false);

  if (line !== undefined && endLine !== undefined && endLine < line) {
    reasons.push('"endLine" must be greater than or equal to "line"');
  }

  if (
    reasons.length > 0 ||
    file === undefined ||
    agent === undefined ||
    severity === undefined ||
    category === undefined ||
    message === undefined ||
    suggestion === undefined ||
    line === undefined
  ) {
    return {
      warning: {
        code: "INVALID_RECORD",
        message: `Dropped record at index ${recordIndex}: ${reasons.join("; ")}.`,
        candidateSource: candidate.source,
        candidateIndex,
        recordIndex,
      },
    };
  }

  return {
    finding: {
      file,
      line,
      ...(endLine !== undefined ? { endLine } : {}),
      agent,
      severity,
      category,
      message,
      suggestion,
    },
  };
}

function evaluateCandidate(candidate: ParsedCandidate, candidateIndex: number): EvaluatedCandidate {
  const findings: ParsedFinding[] = [];
  const warnings: ResponseParserWarning[] = [];

  for (const [recordIndex, record] of candidate.records.entries()) {
    const { finding, warning } = validateRecord(record, recordIndex, candidate, candidateIndex);
    if (finding) {
      findings.push(finding);
    }
    if (warning) {
      warnings.push(warning);
    }
  }

  return {
    ...candidate,
    findings,
    warnings,
    invalidCount: warnings.length,
  };
}

function chooseMostPlausibleCandidate(candidates: readonly EvaluatedCandidate[]): EvaluatedCandidate {
  return [...candidates].sort((a, b) => {
    if (a.findings.length !== b.findings.length) {
      return b.findings.length - a.findings.length;
    }

    if (a.invalidCount !== b.invalidCount) {
      return a.invalidCount - b.invalidCount;
    }

    const sourceDiff = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDiff !== 0) {
      return sourceDiff;
    }

    if (a.start !== b.start) {
      return a.start - b.start;
    }

    return b.raw.length - a.raw.length;
  })[0];
}

export function parseModelResponse(rawOutput: string): ParseResponseResult {
  const normalizedOutput = normalizeOutput(rawOutput);
  const extractionCandidates = collectExtractionCandidates(normalizedOutput);
  const parsedCandidates = toParsedArrayCandidates(extractionCandidates);

  if (parsedCandidates.length === 0) {
    return {
      findings: [],
      warnings: [
        {
          code: "NO_JSON_ARRAY_FOUND",
          message: "No parseable JSON array could be extracted from model output.",
        },
      ],
    };
  }

  const evaluatedCandidates = parsedCandidates.map((candidate, index) =>
    evaluateCandidate(candidate, index)
  );
  const selectedCandidate = chooseMostPlausibleCandidate(evaluatedCandidates);
  const warnings = [...selectedCandidate.warnings];

  if (selectedCandidate.findings.length === 0) {
    warnings.push({
      code: "NO_VALID_FINDINGS",
      message: "Extracted JSON array contained no valid finding records.",
      candidateSource: selectedCandidate.source,
    });
  }

  return {
    findings: selectedCandidate.findings,
    warnings,
  };
}

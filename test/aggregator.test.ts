import { describe, expect, it } from "vitest";

import { aggregateFindings, buildFindingFingerprint } from "../src/aggregator";
import type { ParsedFinding } from "../src/responseParser";

function createFinding(overrides: Partial<ParsedFinding> = {}): ParsedFinding {
  return {
    file: "src/sample.ts",
    line: 10,
    agent: "tester",
    severity: "warning",
    category: "quality",
    message: "Missing null check",
    suggestion: "Add a guard clause.",
    ...overrides,
  };
}

describe("aggregateFindings", () => {
  it("filters by min severity and tracks metadata", () => {
    const result = aggregateFindings({
      minSeverity: "warning",
      batches: [
        [
          createFinding({ severity: "critical", line: 1, category: "critical-issue" }),
          createFinding({ severity: "warning", line: 2, category: "warning-issue" }),
          createFinding({ severity: "info", line: 3, category: "info-issue" }),
          createFinding({ severity: "notice", line: 4, category: "unknown-issue" }),
        ],
      ],
    });

    expect(result.findings.map((finding) => finding.severity)).toEqual(["critical", "warning"]);
    expect(result.metadata).toMatchObject({
      inputFindingCount: 4,
      findingsAfterSeverityFilter: 2,
      filteredOutBySeverity: 2,
      filteredOutByUnknownSeverity: 1,
      countsBySeverity: {
        critical: 1,
        warning: 1,
        info: 0,
      },
    });
  });

  it("deduplicates collisions by keeping highest severity finding", () => {
    const result = aggregateFindings({
      minSeverity: "info",
      batches: [
        [
          createFinding({
            severity: "warning",
            file: "src/account.ts",
            line: 15,
            category: "null-check",
            message: "Missing null check in createUser",
            suggestion: "Add test coverage.",
          }),
          createFinding({
            severity: "critical",
            file: "src/account.ts",
            line: 15,
            category: "null-check",
            message: "Missing null check in createUser",
            suggestion: "Validate and throw early.",
          }),
        ],
      ],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: "critical",
      suggestion: "Validate and throw early.",
    });
    expect(result.metadata.dedup).toMatchObject({
      totalBeforeDedup: 2,
      totalAfterDedup: 1,
      duplicatesRemoved: 1,
      collisionGroupCount: 1,
    });
  });

  it("keeps deterministic winner for equal-severity fingerprint collisions", () => {
    const first = createFinding({
      severity: "warning",
      file: "src/api.ts",
      line: 8,
      category: "error-handling",
      message: "Missing error handling",
      suggestion: "Wrap call in try/catch.",
      agent: "tester",
    });

    const second = createFinding({
      severity: "warning",
      file: "src/api.ts",
      line: 8,
      category: "error-handling",
      message: "Missing error handling",
      suggestion: "Add explicit error mapping.",
      agent: "architect",
    });

    const forward = aggregateFindings({ minSeverity: "info", batches: [[first, second]] });
    const reverse = aggregateFindings({ minSeverity: "info", batches: [[second, first]] });

    expect(forward.findings).toEqual(reverse.findings);
    expect(forward.findings[0]?.suggestion).toBe("Add explicit error mapping.");
  });

  it("sorts output deterministically by severity, file, then line", () => {
    const result = aggregateFindings({
      minSeverity: "info",
      batches: [
        [
          createFinding({ severity: "warning", file: "src/b.ts", line: 1, category: "w-3" }),
          createFinding({ severity: "critical", file: "src/z.ts", line: 30, category: "c-1" }),
        ],
        [
          createFinding({ severity: "warning", file: "src/a.ts", line: 2, category: "w-2" }),
          createFinding({ severity: "warning", file: "src/a.ts", line: 1, category: "w-1" }),
          createFinding({ severity: "info", file: "src/a.ts", line: 1, category: "i-1" }),
        ],
      ],
    });

    expect(
      result.findings.map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
      }))
    ).toEqual([
      { severity: "critical", file: "src/z.ts", line: 30 },
      { severity: "warning", file: "src/a.ts", line: 1 },
      { severity: "warning", file: "src/a.ts", line: 2 },
      { severity: "warning", file: "src/b.ts", line: 1 },
      { severity: "info", file: "src/a.ts", line: 1 },
    ]);
  });

  it("builds stable fingerprints from normalized file/category/message content", () => {
    const fingerprintA = buildFindingFingerprint(
      createFinding({
        file: "src\\domain\\service.ts",
        category: "  Safety  ",
        message: "Missing   NULL   check",
      })
    );
    const fingerprintB = buildFindingFingerprint(
      createFinding({
        file: "src/domain/service.ts",
        category: "safety",
        message: "missing null check",
      })
    );

    expect(fingerprintA).toBe(fingerprintB);
    expect(fingerprintA).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("throws when min severity is unsupported", () => {
    expect(() =>
      aggregateFindings({
        minSeverity: "fatal" as never,
        batches: [],
      })
    ).toThrowError(/Unsupported minSeverity/u);
  });
});

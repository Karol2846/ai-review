import { describe, expect, it } from "vitest";

import { renderReport, type ReporterFinding } from "../src/reporter";

function createFinding(overrides: Partial<ReporterFinding> = {}): ReporterFinding {
  return {
    file: "src/a.ts",
    line: 1,
    agent: "tester",
    category: "quality",
    severity: "warning",
    message: "Default message",
    ...overrides,
  };
}

describe("renderReport", () => {
  it("sorts findings deterministically by file, severity rank, and line", () => {
    const output = renderReport(
      [
        createFinding({ file: "src/b.ts", severity: "critical", line: 1, message: "b-critical" }),
        createFinding({ file: "src/a.ts", severity: "info", line: 4, message: "a-info" }),
        createFinding({ file: "src/a.ts", severity: "critical", line: 3, message: "a-critical" }),
        createFinding({ file: "src/a.ts", severity: "warning", line: 2, message: "a-warning" }),
      ],
      { color: false }
    );

    const findingLines = output.split("\n").filter((line) => line.startsWith("  ● "));
    expect(findingLines).toEqual([
      "  ● critical [tester/quality] L3",
      "  ● warning [tester/quality] L2",
      "  ● info [tester/quality] L4",
      "  ● critical [tester/quality] L1",
    ]);
  });

  it("renders file headers and summary values", () => {
    const output = renderReport(
      [
        createFinding({ file: "src/z.ts", line: 1, agent: "tester", message: "first" }),
        createFinding({ file: "src/a.ts", line: 2, agent: "architect", severity: "critical" }),
        createFinding({ file: "src/a.ts", line: 3, agent: "tester", severity: "info" }),
      ],
      { color: false }
    );

    const lines = output.split("\n");
    expect(lines).toContain("━━━ src/a.ts ━━━");
    expect(lines).toContain("━━━ src/z.ts ━━━");
    expect(lines.at(-2)).toBe("─────────────────────────────────────────");
    expect(lines.at(-1)).toBe("3 findings across 2 files from 2 agents");
  });

  it("renders suggestion line only for non-empty trimmed suggestions", () => {
    const output = renderReport(
      [
        createFinding({ line: 1, suggestion: "  Apply guard clause.  " }),
        createFinding({ line: 2, suggestion: "   " }),
        createFinding({ line: 3 }),
      ],
      { color: false }
    );

    const lines = output.split("\n");
    expect(lines).toContain("    → Apply guard clause.");
    expect(lines.filter((line) => line.includes("→"))).toHaveLength(1);
  });

  it("disables ANSI color output when color=false", () => {
    const output = renderReport(
      [createFinding({ severity: "critical", suggestion: "Fix immediately." })],
      { color: false }
    );

    expect(output).not.toMatch(/\u001b\[[0-9;]*m/u);
  });
});

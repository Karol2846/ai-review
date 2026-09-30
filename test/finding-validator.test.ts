import { describe, expect, it } from "vitest";

import type { Finding } from "../src/findingSchema";
import { parseChangedLineRanges, validateFindings } from "../src/findingValidator";

function finding(overrides: Partial<Finding>): Finding {
  return {
    file: "src/service.ts",
    line: 10,
    agent: "tester",
    severity: "warning",
    category: "edge-case",
    message: "Missing null check.",
    suggestion: "Add a guard.",
    ...overrides,
  };
}

const fullContent = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const contexts = [
  {
    filePath: "src/service.ts",
    fullContent,
    gitDiff: ["@@ -8,3 +8,4 @@ class Service", " a", "-b", "+c", "+d", " e", "@@ -30,2 +31,0 @@", "-x", "-y"].join("\n"),
  },
];

describe("parseChangedLineRanges", () => {
  it("maps hunk headers to new-side line ranges", () => {
    expect(parseChangedLineRanges(contexts[0]!.gitDiff)).toEqual([
      [8, 11],
      [31, 31],
    ]);
  });

  it("treats a missing hunk length as one line and a new file as starting at line 1", () => {
    expect(parseChangedLineRanges("@@ -5 +5 @@\n-a\n+b")).toEqual([[5, 5]]);
    expect(parseChangedLineRanges("@@ -0,0 +1,3 @@\n+a\n+b\n+c")).toEqual([[1, 3]]);
  });

  it("returns no ranges for a diff without hunks", () => {
    expect(parseChangedLineRanges("Binary files a/x.bin and b/x.bin differ")).toEqual([]);
  });
});

describe("validateFindings", () => {
  it("keeps findings inside a hunk or within the tolerance around it", () => {
    const result = validateFindings(
      [finding({ line: 9 }), finding({ line: 5 }), finding({ line: 14 }), finding({ line: 34 })],
      contexts
    );

    expect(result.findings.map((f) => f.line)).toEqual([9, 5, 14, 34]);
    expect(result.dropped).toEqual([]);
  });

  it("drops findings outside every changed hunk", () => {
    const result = validateFindings([finding({ line: 20 })], contexts);

    expect(result.findings).toEqual([]);
    expect(result.dropped[0]).toMatchObject({ code: "LINE_OUTSIDE_DIFF" });
  });

  it("keeps a multi-line finding whose range reaches into a hunk", () => {
    const result = validateFindings([finding({ line: 1, endLine: 6 })], contexts);

    expect(result.findings).toHaveLength(1);
  });

  it("drops findings past the end of the file and clamps endLine to the file length", () => {
    const result = validateFindings(
      [finding({ line: 41 }), finding({ line: 34, endLine: 99 })],
      contexts
    );

    expect(result.dropped.map((d) => d.code)).toEqual(["LINE_OUT_OF_RANGE"]);
    expect(result.findings[0]).toMatchObject({ line: 34, endLine: 40 });
  });

  it("drops findings for files that were not reviewed and normalizes ./ prefixes", () => {
    const result = validateFindings(
      [finding({ file: "src/other.ts" }), finding({ file: "./src/service.ts" })],
      contexts
    );

    expect(result.dropped.map((d) => d.code)).toEqual(["UNKNOWN_FILE"]);
    expect(result.findings[0]?.file).toBe("src/service.ts");
  });

  it("skips the hunk check when the diff has no hunks", () => {
    const result = validateFindings([finding({ line: 20 })], [{ ...contexts[0]!, gitDiff: "" }]);

    expect(result.findings).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";

import { parseModelResponse } from "../src/responseParser";

describe("parseModelResponse", () => {
  it("parses a pure JSON array", () => {
    const rawOutput =
      '[{"file":"src/a.ts","line":10,"agent":"tester","severity":"warning","category":"tests","message":"m","suggestion":"s"}]';

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("parses JSON wrapped in markdown fence", () => {
    const rawOutput = [
      "```json",
      '[{"file":"src/a.ts","line":1,"agent":"tester","severity":"critical","category":"quality","message":"m","suggestion":"s"}]',
      "```",
    ].join("\n");

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("extracts array from prose before and after", () => {
    const rawOutput = [
      "Here are findings:",
      '[{"file":"src/a.ts","line":2,"agent":"tester","severity":"info","category":"style","message":"m","suggestion":"s"}]',
      "Thanks!",
    ].join("\n");

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("drops invalid records and reports warning metadata", () => {
    const rawOutput = JSON.stringify([
      {
        file: "src/a.ts",
        line: 3,
        agent: "tester",
        severity: "warning",
        category: "tests",
        message: "m",
        suggestion: "s",
      },
      {
        line: 4,
        agent: "tester",
        severity: "warning",
        category: "tests",
        message: "m",
        suggestion: "s",
      },
    ]);

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: "INVALID_RECORD",
      recordIndex: 1,
    });
  });

  it("returns warning and no throw when no parseable array exists", () => {
    const result = parseModelResponse("Model answered with prose only.");

    expect(result.findings).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: "NO_JSON_ARRAY_FOUND",
    });
  });

  it("chooses the most plausible array when multiple arrays are present", () => {
    const rawOutput = [
      '[{"foo":"bar"}]',
      '[{"file":"src/a.ts","line":5,"agent":"tester","severity":"warning","category":"tests","message":"m","suggestion":"s"}]',
    ].join("\n");

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(5);
  });

  it("rejects endLine less than line", () => {
    const rawOutput = JSON.stringify([
      { file: "src/a.ts", line: 5, endLine: 3, agent: "tester", severity: "warning", category: "c", message: "m", suggestion: "s" },
    ]);

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(0);
    const invalidRecord = result.warnings.find((w) => w.code === "INVALID_RECORD");
    expect(invalidRecord).toMatchObject({ code: "INVALID_RECORD", recordIndex: 0 });
    expect(invalidRecord?.message).toContain('"endLine" must be greater than or equal to "line"');
  });

  it("rejects line: 0", () => {
    const rawOutput = JSON.stringify([
      { file: "src/a.ts", line: 0, agent: "tester", severity: "warning", category: "c", message: "m", suggestion: "s" },
    ]);

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toMatchObject({ code: "INVALID_RECORD", recordIndex: 0 });
    expect(result.warnings[0]?.message).toContain('"line" must be a positive integer');
  });

  it("rejects negative line", () => {
    const rawOutput = JSON.stringify([
      { file: "src/a.ts", line: -1, agent: "tester", severity: "warning", category: "c", message: "m", suggestion: "s" },
    ]);

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toMatchObject({ code: "INVALID_RECORD", recordIndex: 0 });
    expect(result.warnings[0]?.message).toContain('"line" must be a positive integer');
  });

  it("rejects null in required string field", () => {
    const rawOutput = JSON.stringify([
      { file: null, line: 1, agent: "tester", severity: "warning", category: "c", message: "m", suggestion: "s" },
    ]);

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toMatchObject({ code: "INVALID_RECORD", recordIndex: 0 });
  });

  it("rejects number in required string field", () => {
    const rawOutput = JSON.stringify([
      { file: 123, line: 1, agent: "tester", severity: "warning", category: "c", message: "m", suggestion: "s" },
    ]);

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toMatchObject({ code: "INVALID_RECORD", recordIndex: 0 });
  });

  it("returns NO_VALID_FINDINGS when the extracted array is empty", () => {
    const result = parseModelResponse("[]");

    expect(result.findings).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: "NO_VALID_FINDINGS" });
  });

  it("falls back to inline array when fenced block contains malformed JSON", () => {
    const validFinding = { file: "src/a.ts", line: 1, agent: "tester", severity: "warning", category: "c", message: "m", suggestion: "s" };
    const rawOutput = [
      "```json",
      "{ not valid json",
      "```",
      JSON.stringify([validFinding]),
    ].join("\n");

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it("selects fenced block with more valid findings over one with fewer", () => {
    const validFinding = { file: "src/a.ts", line: 7, agent: "tester", severity: "info", category: "c", message: "m", suggestion: "s" };
    const rawOutput = [
      "```json",
      '[{"foo":"bar"}]',
      "```",
      "```json",
      JSON.stringify([validFinding]),
      "```",
    ].join("\n");

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(7);
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts endLine equal to line", () => {
    const rawOutput = JSON.stringify([
      { file: "src/a.ts", line: 5, endLine: 5, agent: "tester", severity: "warning", category: "c", message: "m", suggestion: "s" },
    ]);

    const result = parseModelResponse(rawOutput);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.endLine).toBe(5);
    expect(result.warnings).toHaveLength(0);
  });
});

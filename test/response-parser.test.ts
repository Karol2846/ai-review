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
});

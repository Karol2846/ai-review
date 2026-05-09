import { describe, it, expect } from "vitest";
import { findingSchema, findingsSchema } from "../src/findingSchema";

const validFinding = {
  file: "src/foo.ts",
  line: 10,
  agent: "clean-coder" as const,
  severity: "warning" as const,
  category: "unused-variable",
  message: "Variable x is never used",
  suggestion: "Remove the variable",
};

describe("findingSchema", () => {
  it("accepts a minimal valid finding", () => {
    const result = findingSchema.safeParse(validFinding);
    expect(result.success).toBe(true);
  });

  it("accepts a finding with optional endLine and fingerprint", () => {
    const result = findingSchema.safeParse({
      ...validFinding,
      endLine: 15,
      fingerprint: "abc123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid severity", () => {
    const result = findingSchema.safeParse({ ...validFinding, severity: "high" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid agent", () => {
    const result = findingSchema.safeParse({ ...validFinding, agent: "unknown-agent" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer line", () => {
    const result = findingSchema.safeParse({ ...validFinding, line: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects line < 1", () => {
    const result = findingSchema.safeParse({ ...validFinding, line: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects missing required field", () => {
    const { message: _m, ...withoutMessage } = validFinding;
    const result = findingSchema.safeParse(withoutMessage);
    expect(result.success).toBe(false);
  });
});

describe("findingsSchema", () => {
  it("accepts an empty array", () => {
    expect(findingsSchema.safeParse([]).success).toBe(true);
  });

  it("accepts an array with multiple findings", () => {
    const result = findingsSchema.safeParse([validFinding, { ...validFinding, line: 20 }]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(2);
  });

  it("rejects a non-array", () => {
    expect(findingsSchema.safeParse(validFinding).success).toBe(false);
  });
});

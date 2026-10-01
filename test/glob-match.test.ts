import { describe, expect, it } from "vitest";

import { isNegatedGlob, matchesGlobs } from "../src/globMatch";

describe("matchesGlobs", () => {
  it("matches when any positive pattern matches", () => {
    expect(matchesGlobs("src/a.ts", ["**/*.java", "**/*.ts"])).toBe(true);
    expect(matchesGlobs("README.md", ["**/*.java", "**/*.ts"])).toBe(false);
  });

  it("excludes paths matching a negated pattern, whatever its position", () => {
    expect(matchesGlobs("src/a.d.ts", ["**/*.ts", "!**/*.d.ts"])).toBe(false);
    expect(matchesGlobs("src/a.d.ts", ["!**/*.d.ts", "**/*.ts"])).toBe(false);
    expect(matchesGlobs("src/a.ts", ["!**/*.d.ts", "**/*.ts"])).toBe(true);
  });

  it("does not let a negation alone match unrelated paths when positives exist", () => {
    expect(matchesGlobs("src/a.ts", ["vendor/**", "!vendor/keep/**"])).toBe(false);
  });

  it("treats a negation-only list as 'everything except'", () => {
    expect(matchesGlobs("src/a.ts", ["!**/*.md"])).toBe(true);
    expect(matchesGlobs("README.md", ["!**/*.md"])).toBe(false);
  });

  it("matches nothing for an empty pattern list", () => {
    expect(matchesGlobs("src/a.ts", [])).toBe(false);
  });

  it("normalizes Windows-style separators", () => {
    expect(matchesGlobs("src\\a.d.ts", ["src/**/*.ts", "!**/*.d.ts"])).toBe(false);
    expect(matchesGlobs("src\\a.ts", ["src/**/*.ts", "!**/*.d.ts"])).toBe(true);
  });
});

describe("isNegatedGlob", () => {
  it("treats a leading ! as negation but !(…) as an extglob", () => {
    expect(isNegatedGlob("!**/*.d.ts")).toBe(true);
    expect(isNegatedGlob("**/*.ts")).toBe(false);
    expect(isNegatedGlob("!(*.d).ts")).toBe(false);
  });
});

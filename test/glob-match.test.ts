import { describe, expect, it } from "vitest";

import { explainGlobMatch, isNegatedGlob, matchesGlobs } from "../src/globMatch";

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

describe("explainGlobMatch", () => {
  it("returns the first positive pattern that matched", () => {
    expect(explainGlobMatch("src/a.ts", ["**/*.java", "src/**", "**/*.ts"])).toEqual({
      matchedBy: "src/**",
    });
  });

  it("reports the negation that removed the path", () => {
    expect(explainGlobMatch("src/a.d.ts", ["**/*.ts", "!**/*.d.ts"])).toEqual({
      matchedBy: "**/*.ts",
      excludedBy: "!**/*.d.ts",
    });
  });

  it("returns null when no positive pattern matches or the list is empty", () => {
    expect(explainGlobMatch("README.md", ["**/*.ts", "!**/*.d.ts"])).toBeNull();
    expect(explainGlobMatch("src/a.ts", [])).toBeNull();
  });

  it("handles negation-only lists", () => {
    expect(explainGlobMatch("src/a.ts", ["!**/*.md"])).toEqual({});
    expect(explainGlobMatch("README.md", ["!**/*.md"])).toEqual({ excludedBy: "!**/*.md" });
  });

  it("agrees with matchesGlobs", () => {
    const lists = [["**/*.ts", "!**/*.d.ts"], ["!**/*.md"], ["vendor/**", "!vendor/keep/**"], []];
    const paths = ["src/a.ts", "src/a.d.ts", "README.md", "vendor/x.ts", "vendor/keep/y.ts", ".github/ci.yml"];
    for (const patterns of lists) {
      for (const path of paths) {
        const explanation = explainGlobMatch(path, patterns);
        const explainedMatch = explanation !== null && explanation.excludedBy === undefined;
        expect(explainedMatch, `${path} vs ${JSON.stringify(patterns)}`).toBe(matchesGlobs(path, patterns));
      }
    }
  });
});

import micromatch from "micromatch";

/**
 * `dot: true` lets `*` and `**` match dot-segments, so `.github/**` or `src/.config/x.ts` are
 * matched like any other path (micromatch skips them by default).
 */
const GLOB_MATCH_OPTIONS = { dot: true } as const;

/** Normalizes a repo-relative path to forward slashes so globs match the same way on Windows. */
export function normalizeGlobPath(filePath: string): string {
  return filePath.replace(/\\/gu, "/");
}

/** A leading `!` negates the pattern; `!(…)` is an extglob and stays a positive pattern. */
export function isNegatedGlob(pattern: string): boolean {
  return pattern.startsWith("!") && !pattern.startsWith("!(");
}

/**
 * Returns true when `filePath` matches at least one positive pattern and none of the `!`-negated
 * ones. Negations win regardless of their position in the list, because lists are merged from
 * several sources (defaults + `ai-review.json`, config + CLI) whose order the user cannot see.
 * A list made only of negations matches every path it does not exclude; an empty list matches
 * nothing.
 *
 * Neither `micromatch.isMatch` (ORs all patterns, so `!**\/*.d.ts` matches almost anything) nor
 * `micromatch()` (a later positive pattern re-includes what an earlier negation removed) gives
 * these semantics on its own.
 */
export function matchesGlobs(filePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  const path = normalizeGlobPath(filePath);
  const positive = patterns.filter((pattern) => !isNegatedGlob(pattern));
  const negated = patterns.filter(isNegatedGlob).map((pattern) => pattern.slice(1));

  if (negated.length > 0 && micromatch.isMatch(path, negated, GLOB_MATCH_OPTIONS)) {
    return false;
  }
  return positive.length === 0 || micromatch.isMatch(path, positive, GLOB_MATCH_OPTIONS);
}

export interface GlobMatchExplanation {
  /** First positive pattern that matched; absent when the list holds only negations. */
  readonly matchedBy?: string;
  /** First `!` pattern that removed the path, with its leading `!`; absent when none did. */
  readonly excludedBy?: string;
}

/**
 * Explains `matchesGlobs` for one path: `null` when no positive pattern matches (or the list is
 * empty), otherwise the pattern that matched and, if the path was then removed, the negation that
 * removed it. `matchesGlobs` is true exactly when this returns a result without `excludedBy`.
 */
export function explainGlobMatch(
  filePath: string,
  patterns: readonly string[]
): GlobMatchExplanation | null {
  if (patterns.length === 0) {
    return null;
  }

  const path = normalizeGlobPath(filePath);
  const positive = patterns.filter((pattern) => !isNegatedGlob(pattern));
  const matchedBy = positive.find((pattern) => micromatch.isMatch(path, pattern, GLOB_MATCH_OPTIONS));
  if (positive.length > 0 && matchedBy === undefined) {
    return null;
  }

  const excludedBy = patterns
    .filter(isNegatedGlob)
    .find((pattern) => micromatch.isMatch(path, pattern.slice(1), GLOB_MATCH_OPTIONS));

  return {
    ...(matchedBy !== undefined ? { matchedBy } : {}),
    ...(excludedBy !== undefined ? { excludedBy } : {}),
  };
}

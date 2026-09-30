import { execa } from "execa";

type CommandFailure = {
  shortMessage?: string;
  stderr?: string;
  stdout?: string;
  message?: string;
};

function isCommandFailure(value: unknown): value is CommandFailure {
  return typeof value === "object" && value !== null;
}

function readFailureDetail(error: unknown): string {
  if (!isCommandFailure(error)) {
    return "Unknown command failure.";
  }

  const detail = error.shortMessage ?? error.stderr ?? error.stdout ?? error.message;
  return detail && detail.trim().length > 0 ? detail.trim() : "Unknown command failure.";
}

export class GitServiceError extends Error {
  readonly command: string[];

  constructor(message: string, command: string[]) {
    super(message);
    this.name = "GitServiceError";
    this.command = command;
  }
}

async function runGitCommand(args: string[]): Promise<string> {
  try {
    const { stdout } = await execa("git", args, { reject: true });
    return stdout;
  } catch (error) {
    const detail = readFailureDetail(error);
    throw new GitServiceError(`git ${args.join(" ")} failed: ${detail}`, args);
  }
}

function requireValue(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new GitServiceError(`${fieldName} must not be empty.`, []);
  }
  return normalized;
}

export async function getMergeBase(baseBranch: string): Promise<string> {
  const normalized = requireValue(baseBranch, "baseBranch");
  const branchRef = normalized.startsWith("origin/") ? normalized : `origin/${normalized}`;
  const stdout = await runGitCommand(["merge-base", "HEAD", branchRef]);

  return requireValue(stdout, "mergeBase");
}

/**
 * Which changes a review covers.
 * - `working-tree` (default): everything since the merge-base — commits, staged and unstaged edits,
 *   and untracked (non-ignored) files.
 * - `committed`: only commits, `<mergeBase>..HEAD`.
 */
export type ReviewScope = "working-tree" | "committed";

export const DEFAULT_REVIEW_SCOPE: ReviewScope = "working-tree";

function splitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Diff range argument for `git diff`: `<mergeBase>..HEAD` for commits, `<mergeBase>` for the working tree. */
function toDiffRange(mergeBase: string, scope: ReviewScope): string {
  return scope === "committed" ? `${mergeBase}..HEAD` : mergeBase;
}

export async function getChangedFiles(
  mergeBase: string,
  scope: ReviewScope = DEFAULT_REVIEW_SCOPE
): Promise<string[]> {
  const normalizedMergeBase = requireValue(mergeBase, "mergeBase");
  const changed = splitLines(
    await runGitCommand(["diff", "--name-only", toDiffRange(normalizedMergeBase, scope)])
  );

  if (scope === "committed") {
    return changed;
  }

  const untracked = splitLines(
    await runGitCommand(["ls-files", "--others", "--exclude-standard", "--full-name", "--", ":/"])
  );
  return [...new Set([...changed, ...untracked])];
}

export async function getFileDiff(
  commitSha: string,
  filePath: string,
  scope: ReviewScope = DEFAULT_REVIEW_SCOPE
): Promise<string> {
  const normalizedCommitSha = requireValue(commitSha, "commitSha");
  const normalizedFilePath = requireValue(filePath, "filePath");
  return runGitCommand(["diff", toDiffRange(normalizedCommitSha, scope), "--", normalizedFilePath]);
}

/** Returns the content of a repo-root-relative path at HEAD, or `undefined` when HEAD has no such file. */
export async function readFileAtHead(filePath: string): Promise<string | undefined> {
  const normalizedFilePath = requireValue(filePath, "filePath");
  try {
    const { stdout } = await execa("git", ["show", `HEAD:${normalizedFilePath}`], {
      reject: true,
      stripFinalNewline: false,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

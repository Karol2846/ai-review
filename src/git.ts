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

export async function getChangedFiles(mergeBase: string): Promise<string[]> {
  const normalizedMergeBase = requireValue(mergeBase, "mergeBase");
  const stdout = await runGitCommand(["diff", "--name-only", `${normalizedMergeBase}..HEAD`]);

  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function getFileDiff(commitSha: string, filePath: string): Promise<string> {
  const normalizedCommitSha = requireValue(commitSha, "commitSha");
  const normalizedFilePath = requireValue(filePath, "filePath");
  return runGitCommand(["diff", `${normalizedCommitSha}..HEAD`, "--", normalizedFilePath]);
}

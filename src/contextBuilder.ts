import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { DEFAULT_REVIEW_SCOPE, getChangedFiles, getFileDiff, readFileAtHead, type ReviewScope } from "./git";

const UNSUPPORTED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".jar",
  ".class",
  ".lock",
]);

export interface FileContextItem {
  readonly filePath: string;
  readonly fullContent: string;
  readonly gitDiff: string;
}

export type ContextBuilderWarningCode =
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_NOT_FOUND"
  | "FILE_READ_FAILED";

export interface ContextBuilderWarning {
  readonly filePath: string;
  readonly code: ContextBuilderWarningCode;
  readonly message: string;
}

export interface BuildFileContextsResult {
  readonly contexts: FileContextItem[];
  readonly warnings: ContextBuilderWarning[];
}

function toDeterministicFileList(files: readonly string[]): string[] {
  return [...new Set(files)].sort();
}

function isUnsupportedFile(filePath: string): boolean {
  return UNSUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function createUnsupportedWarning(filePath: string): ContextBuilderWarning {
  const extension = extname(filePath).toLowerCase();

  return {
    filePath,
    code: "UNSUPPORTED_FILE_TYPE",
    message: `Skipping non-reviewable file "${filePath}" (unsupported extension "${extension || "<none>"}").`,
  };
}

function createMissingFileWarning(filePath: string): ContextBuilderWarning {
  return {
    filePath,
    code: "FILE_NOT_FOUND",
    message: `Skipping "${filePath}" because it does not exist in the post-change working tree.`,
  };
}

function createMissingAtHeadWarning(filePath: string): ContextBuilderWarning {
  return {
    filePath,
    code: "FILE_NOT_FOUND",
    message: `Skipping "${filePath}" because it does not exist at HEAD.`,
  };
}

function createReadFailureWarning(filePath: string, error: unknown): ContextBuilderWarning {
  const detail = error instanceof Error && error.message.trim().length > 0 ? error.message.trim() : "Unknown error.";

  return {
    filePath,
    code: "FILE_READ_FAILED",
    message: `Skipping "${filePath}" because file content could not be read: ${detail}`,
  };
}

async function readCurrentFileContent(repoRootPath: string, filePath: string): Promise<string> {
  const absolutePath = resolve(repoRootPath, filePath);
  return readFile(absolutePath, "utf8");
}

/**
 * An untracked file has no `git diff` against the merge-base, so its diff is synthesized as a
 * whole-file addition — the same shape `git diff` gives for a newly added file.
 */
export function buildNewFileDiff(filePath: string, content: string): string {
  if (content.length === 0) {
    return "";
  }

  const lines = content.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
  return [
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export async function buildFileContexts(
  repoRootPath: string,
  mergeBase: string,
  changedFilesInput?: readonly string[],
  scope: ReviewScope = DEFAULT_REVIEW_SCOPE
): Promise<BuildFileContextsResult> {
  const changedFiles = changedFilesInput
    ? toDeterministicFileList(changedFilesInput)
    : toDeterministicFileList(await getChangedFiles(mergeBase, scope));
  const contexts: FileContextItem[] = [];
  const warnings: ContextBuilderWarning[] = [];

  for (const filePath of changedFiles) {
    if (isUnsupportedFile(filePath)) {
      warnings.push(createUnsupportedWarning(filePath));
      continue;
    }

    // Content must come from the same snapshot as the diff, or line numbers won't line up:
    // HEAD for committed-only reviews, the working tree otherwise.
    let fullContent: string;
    if (scope === "committed") {
      const headContent = await readFileAtHead(filePath);
      if (headContent === undefined) {
        warnings.push(createMissingAtHeadWarning(filePath));
        continue;
      }
      fullContent = headContent;
    } else {
      try {
        fullContent = await readCurrentFileContent(repoRootPath, filePath);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          warnings.push(createMissingFileWarning(filePath));
          continue;
        }

        warnings.push(createReadFailureWarning(filePath, error));
        continue;
      }
    }

    let gitDiff = await getFileDiff(mergeBase, filePath, scope);
    if (scope === "working-tree" && gitDiff.trim().length === 0) {
      // Listed as changed but no diff against the merge-base → untracked file.
      gitDiff = buildNewFileDiff(filePath, fullContent);
    }

    contexts.push({
      filePath,
      fullContent,
      gitDiff,
    });
  }

  return {
    contexts,
    warnings,
  };
}

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { getChangedFiles, getFileDiff } from "./git";

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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export async function buildFileContexts(
  repoRootPath: string,
  mergeBase: string,
  changedFilesInput?: readonly string[]
): Promise<BuildFileContextsResult> {
  const changedFiles = changedFilesInput
    ? toDeterministicFileList(changedFilesInput)
    : toDeterministicFileList(await getChangedFiles(mergeBase));
  const contexts: FileContextItem[] = [];
  const warnings: ContextBuilderWarning[] = [];

  for (const filePath of changedFiles) {
    if (isUnsupportedFile(filePath)) {
      warnings.push(createUnsupportedWarning(filePath));
      continue;
    }

    let fullContent: string;
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

    const gitDiff = await getFileDiff(mergeBase, filePath);
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

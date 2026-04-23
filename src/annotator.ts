import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const MARKER = "[ai-review]";
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

const SLASH_COMMENT_EXTENSIONS = new Set([
  ".java",
  ".groovy",
  ".kt",
  ".scala",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
]);

const HASH_COMMENT_EXTENSIONS = new Set([
  ".yml",
  ".yaml",
  ".properties",
  ".py",
  ".rb",
  ".sh",
  ".bash",
  ".toml",
  ".cfg",
  ".ini",
  ".tf",
]);

const SQL_COMMENT_EXTENSIONS = new Set([".sql"]);
const XML_COMMENT_EXTENSIONS = new Set([".xml", ".html", ".htm"]);

type CommentKind = "slash" | "hash" | "sql" | "xml";

const ANNOTATION_LINE_PATTERNS: Readonly<Record<CommentKind, RegExp>> = {
  slash: /^[ \t]*\/\/ TODO\s+\S+\s+\S+:\s+.+\s+\[ai-review\][ \t]*$/u,
  hash: /^[ \t]*# TODO\s+\S+\s+\S+:\s+.+\s+\[ai-review\][ \t]*$/u,
  sql: /^[ \t]*-- TODO\s+\S+\s+\S+:\s+.+\s+\[ai-review\][ \t]*$/u,
  xml: /^[ \t]*<!-- TODO\s+\S+\s+\S+:\s+.+\s+\[ai-review\] -->[ \t]*$/u,
};

interface LineModel {
  readonly eol: "\n" | "\r\n";
  readonly hadTrailingNewline: boolean;
  readonly lines: string[];
}

export interface AnnotationFinding {
  readonly file: string;
  readonly line: number;
  readonly agent: string;
  readonly severity: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface ApplyAnnotationsResult {
  readonly appliedCount: number;
  readonly changedFiles: readonly string[];
  readonly skippedMissingFileCount: number;
  readonly skippedUnsupportedFileCount: number;
}

export interface CleanAnnotationsResult {
  readonly cleanedFilesCount: number;
  readonly cleanedLineCount: number;
}

export class AnnotatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnotatorError";
  }
}

function detectEol(raw: string): "\n" | "\r\n" {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function toLineModel(raw: string): LineModel {
  const normalized = raw.replace(/\r\n?/gu, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");

  if (normalized.length === 0) {
    return { eol: detectEol(raw), hadTrailingNewline, lines: [] };
  }

  let lines = normalized.split("\n");
  if (hadTrailingNewline) {
    lines = lines.slice(0, -1);
  }

  return {
    eol: detectEol(raw),
    hadTrailingNewline,
    lines,
  };
}

function fromLineModel(model: LineModel): string {
  let normalized = model.lines.join("\n");
  if (model.hadTrailingNewline) {
    normalized += "\n";
  }

  if (model.eol === "\n") {
    return normalized;
  }

  return normalized.replace(/\n/gu, "\r\n");
}

function resolveCommentKind(filePath: string): CommentKind | undefined {
  const extension = extname(filePath).toLowerCase();
  if (SLASH_COMMENT_EXTENSIONS.has(extension)) {
    return "slash";
  }
  if (HASH_COMMENT_EXTENSIONS.has(extension)) {
    return "hash";
  }
  if (SQL_COMMENT_EXTENSIONS.has(extension)) {
    return "sql";
  }
  if (XML_COMMENT_EXTENSIONS.has(extension)) {
    return "xml";
  }
  return undefined;
}

function commentText(kind: CommentKind, finding: AnnotationFinding): string {
  const suggestion = finding.suggestion?.trim();
  const suggestionPart = suggestion && suggestion.length > 0 ? ` \u2192 ${suggestion}` : "";
  const body = `TODO ${finding.agent} ${finding.severity}: ${finding.message}${suggestionPart} ${MARKER}`;

  switch (kind) {
    case "slash":
      return `// ${body}`;
    case "hash":
      return `# ${body}`;
    case "sql":
      return `-- ${body}`;
    case "xml":
      return `<!-- ${body} -->`;
  }
}

function leadingIndentation(line: string): string {
  const match = line.match(/^[ \t]*/u);
  return match ? match[0] : "";
}

function groupFindingsByFile(
  findings: readonly AnnotationFinding[]
): ReadonlyMap<string, AnnotationFinding[]> {
  const groups = new Map<string, AnnotationFinding[]>();
  for (const finding of findings) {
    const existing = groups.get(finding.file);
    if (existing) {
      existing.push(finding);
    } else {
      groups.set(finding.file, [finding]);
    }
  }

  for (const fileFindings of groups.values()) {
    fileFindings.sort((left, right) => {
      if (left.line !== right.line) {
        return right.line - left.line;
      }

      if (left.agent !== right.agent) {
        return left.agent < right.agent ? -1 : 1;
      }

      if (left.message !== right.message) {
        return left.message < right.message ? -1 : 1;
      }

      return 0;
    });
  }

  return groups;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isPathContainedWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function isGeneratedAnnotationLine(line: string, kind: CommentKind): boolean {
  return ANNOTATION_LINE_PATTERNS[kind].test(line);
}

function applyFindingToModel(
  model: LineModel,
  finding: AnnotationFinding,
  kind: CommentKind
): boolean {
  if (!Number.isInteger(finding.line) || finding.line < 1) {
    return false;
  }

  const targetIndex = Math.min(finding.line - 1, model.lines.length);
  const targetLine = targetIndex < model.lines.length ? model.lines[targetIndex] ?? "" : "";
  const indent = leadingIndentation(targetLine);
  const comment = `${indent}${commentText(kind, finding)}`;

  model.lines.splice(targetIndex, 0, comment);
  return true;
}

export async function applyAnnotations(
  findings: readonly AnnotationFinding[],
  repoRootPath: string
): Promise<ApplyAnnotationsResult> {
  const resolvedRepoRootPath = resolve(repoRootPath);
  let canonicalRepoRootPath: string;
  try {
    canonicalRepoRootPath = await realpath(resolvedRepoRootPath);
  } catch (error) {
    throw new AnnotatorError(
      `Failed to resolve repository root "${repoRootPath}" while applying annotations: ${error instanceof Error ? error.message : "Unknown error."}`
    );
  }

  const groupedByFile = groupFindingsByFile(findings);
  const changedFiles: string[] = [];
  let appliedCount = 0;
  let skippedMissingFileCount = 0;
  let skippedUnsupportedFileCount = 0;

  for (const [relativePath, fileFindings] of groupedByFile.entries()) {
    const kind = resolveCommentKind(relativePath);
    if (!kind) {
      skippedUnsupportedFileCount += fileFindings.length;
      continue;
    }

    if (isAbsolute(relativePath)) {
      throw new AnnotatorError(
        `Refusing to apply annotations to absolute path "${relativePath}".`
      );
    }

    const candidateAbsolutePath = resolve(resolvedRepoRootPath, relativePath);
    if (!isPathContainedWithinRoot(resolvedRepoRootPath, candidateAbsolutePath)) {
      throw new AnnotatorError(
        `Refusing to apply annotations to "${relativePath}" because it resolves outside repository root.`
      );
    }

    let absolutePath = candidateAbsolutePath;
    let raw: string;
    try {
      absolutePath = await realpath(candidateAbsolutePath);
      if (!isPathContainedWithinRoot(canonicalRepoRootPath, absolutePath)) {
        throw new AnnotatorError(
          `Refusing to apply annotations to "${relativePath}" because it resolves outside repository root.`
        );
      }
      raw = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (error instanceof AnnotatorError) {
        throw error;
      }
      if (isErrnoException(error) && error.code === "ENOENT") {
        skippedMissingFileCount += fileFindings.length;
        continue;
      }
      throw new AnnotatorError(
        `Failed to read "${relativePath}" while applying annotations: ${error instanceof Error ? error.message : "Unknown error."}`
      );
    }

    const model = toLineModel(raw);
    let fileAppliedCount = 0;
    for (const finding of fileFindings) {
      if (applyFindingToModel(model, finding, kind)) {
        fileAppliedCount += 1;
      }
    }

    if (fileAppliedCount > 0) {
      await writeFile(absolutePath, fromLineModel(model), "utf8");
      appliedCount += fileAppliedCount;
      changedFiles.push(relativePath);
    }
  }

  return {
    appliedCount,
    changedFiles: changedFiles.sort(),
    skippedMissingFileCount,
    skippedUnsupportedFileCount,
  };
}

async function listCleanableFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (resolveCommentKind(entry.name)) {
        files.push(absolutePath);
      }
    }
  }

  return files;
}

export async function cleanAnnotations(repoRootPath: string): Promise<CleanAnnotationsResult> {
  const candidateFiles = await listCleanableFiles(repoRootPath);
  let cleanedFilesCount = 0;
  let cleanedLineCount = 0;

  for (const absolutePath of candidateFiles) {
    const kind = resolveCommentKind(absolutePath);
    if (!kind) {
      continue;
    }

    const raw = await readFile(absolutePath, "utf8");
    if (!raw.includes(MARKER)) {
      continue;
    }

    const model = toLineModel(raw);
    const filteredLines = model.lines.filter((line) => !isGeneratedAnnotationLine(line, kind));
    const removedCount = model.lines.length - filteredLines.length;
    if (removedCount === 0) {
      continue;
    }

    cleanedFilesCount += 1;
    cleanedLineCount += removedCount;

    await writeFile(
      absolutePath,
      fromLineModel({
        ...model,
        lines: filteredLines,
      }),
      "utf8"
    );
  }

  return {
    cleanedFilesCount,
    cleanedLineCount,
  };
}


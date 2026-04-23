import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnnotatorError,
  applyAnnotations,
  cleanAnnotations,
  type AnnotationFinding,
} from "../src/annotator";

const SANDBOX_ROOT = join(process.cwd(), "test", "__annotator_sandbox__");

let sandboxCounter = 0;
let currentSandboxPath: string | undefined;

function toSandboxRelativePath(absolutePath: string): string {
  if (!currentSandboxPath) {
    throw new Error("Sandbox is not initialized.");
  }
  return relative(currentSandboxPath, absolutePath);
}

function writeSandboxFile(relativePath: string, content: string): string {
  if (!currentSandboxPath) {
    throw new Error("Sandbox is not initialized.");
  }
  const absolutePath = join(currentSandboxPath, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  return absolutePath;
}

function readSandboxFile(relativePath: string): string {
  if (!currentSandboxPath) {
    throw new Error("Sandbox is not initialized.");
  }
  return readFileSync(join(currentSandboxPath, relativePath), "utf8");
}

function createFinding(overrides: Partial<AnnotationFinding>): AnnotationFinding {
  return {
    file: join("src", "sample.ts"),
    line: 1,
    agent: "tester",
    severity: "warning",
    message: "Default finding message",
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  sandboxCounter += 1;
  currentSandboxPath = join(SANDBOX_ROOT, `case-${sandboxCounter}`);
  rmSync(currentSandboxPath, { recursive: true, force: true });
  mkdirSync(currentSandboxPath, { recursive: true });
});

afterEach(() => {
  if (currentSandboxPath) {
    rmSync(currentSandboxPath, { recursive: true, force: true });
    currentSandboxPath = undefined;
  }
});

afterAll(() => {
  rmSync(SANDBOX_ROOT, { recursive: true, force: true });
});

describe("applyAnnotations", () => {
  it("inserts comments with expected style and placement behavior", async () => {
    const targetRelativePath = join("src", "service.ts");
    const targetAbsolutePath = writeSandboxFile(
      targetRelativePath,
      "export function greet(name: string) {\r\n  return `Hello ${name}`;\r\n}\r\n"
    );

    const result = await applyAnnotations(
      [
        createFinding({
          file: toSandboxRelativePath(targetAbsolutePath),
          line: 2,
          agent: "tester",
          severity: "warning",
          message: "Handle empty names",
          suggestion: "Return early for empty input",
        }),
        createFinding({
          file: toSandboxRelativePath(targetAbsolutePath),
          line: 99,
          agent: "architect",
          severity: "info",
          message: "Add module-level documentation",
        }),
      ],
      currentSandboxPath as string
    );

    expect(result).toEqual({
      appliedCount: 2,
      changedFiles: [targetRelativePath],
      skippedMissingFileCount: 0,
      skippedUnsupportedFileCount: 0,
    });

    expect(readSandboxFile(targetRelativePath)).toBe(
      "export function greet(name: string) {\r\n" +
        "  // TODO tester warning: Handle empty names → Return early for empty input [ai-review]\r\n" +
        "  return `Hello ${name}`;\r\n" +
        "}\r\n" +
        "// TODO architect info: Add module-level documentation [ai-review]\r\n"
    );
  });

  it("tracks skipped counters for unsupported and missing files", async () => {
    const existingRelativePath = join("src", "existing.ts");
    writeSandboxFile(existingRelativePath, "export const existing = true;\n");

    const result = await applyAnnotations(
      [
        createFinding({
          file: existingRelativePath,
          line: 1,
          message: "Update existing module docs",
        }),
        createFinding({
          file: join("src", "missing.ts"),
          line: 1,
          message: "Missing file finding",
        }),
        createFinding({
          file: join("docs", "notes.md"),
          line: 1,
          message: "Unsupported extension finding",
        }),
      ],
      currentSandboxPath as string
    );

    expect(result).toEqual({
      appliedCount: 1,
      changedFiles: [existingRelativePath],
      skippedMissingFileCount: 1,
      skippedUnsupportedFileCount: 1,
    });

    expect(readSandboxFile(existingRelativePath)).toBe(
      "// TODO tester warning: Update existing module docs [ai-review]\nexport const existing = true;\n"
    );
  });

  it("rejects absolute paths with AnnotatorError", async () => {
    const targetRelativePath = join("src", "secure.ts");
    const targetAbsolutePath = writeSandboxFile(targetRelativePath, "export const secure = true;\n");

    await expect(
      applyAnnotations(
        [
          createFinding({
            file: resolve(targetAbsolutePath),
            line: 1,
            message: "Absolute path should be rejected",
          }),
        ],
        currentSandboxPath as string
      )
    ).rejects.toThrow(AnnotatorError);

    await expect(
      applyAnnotations(
        [
          createFinding({
            file: resolve(targetAbsolutePath),
            line: 1,
            message: "Absolute path should be rejected",
          }),
        ],
        currentSandboxPath as string
      )
    ).rejects.toThrow(/absolute path/u);
  });

  it("rejects path traversal attempts with AnnotatorError", async () => {
    await expect(
      applyAnnotations(
        [
          createFinding({
            file: join("..", "outside.ts"),
            line: 1,
            message: "Traversal should be rejected",
          }),
        ],
        currentSandboxPath as string
      )
    ).rejects.toThrow(AnnotatorError);

    await expect(
      applyAnnotations(
        [
          createFinding({
            file: join("..", "outside.ts"),
            line: 1,
            message: "Traversal should be rejected",
          }),
        ],
        currentSandboxPath as string
      )
    ).rejects.toThrow(/resolves outside repository root/u);
  });
});

describe("cleanAnnotations", () => {
  it("removes generated annotations and preserves non-generated lines containing the marker", async () => {
    const targetRelativePath = join("src", "cleanup.ts");
    writeSandboxFile(
      targetRelativePath,
      [
        "const keep = true;",
        "// TODO tester warning: generated one [ai-review]",
        "// NOTE keep marker [ai-review]",
        "const marker = \"[ai-review]\";",
        "// TODO architect info: generated two [ai-review]",
        "",
      ].join("\r\n")
    );

    const result = await cleanAnnotations(currentSandboxPath as string);
    expect(result).toEqual({
      cleanedFilesCount: 1,
      cleanedLineCount: 2,
    });

    expect(readSandboxFile(targetRelativePath)).toBe(
      [
        "const keep = true;",
        "// NOTE keep marker [ai-review]",
        "const marker = \"[ai-review]\";",
        "",
      ].join("\r\n")
    );
  });
});


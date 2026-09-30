import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFileContexts } from "../src/contextBuilder";
import { getChangedFiles, getFileDiff, readFileAtHead } from "../src/git";

vi.mock("../src/git", () => ({
  DEFAULT_REVIEW_SCOPE: "working-tree",
  getChangedFiles: vi.fn(),
  getFileDiff: vi.fn(),
  readFileAtHead: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn().mockImplementation(actual.readFile),
  };
});

import { readFile } from "node:fs/promises";

const mockedGetChangedFiles = vi.mocked(getChangedFiles);
const mockedGetFileDiff = vi.mocked(getFileDiff);
const mockedReadFileAtHead = vi.mocked(readFileAtHead);
const mockedReadFile = vi.mocked(readFile);

const FIXTURES_ROOT = join(process.cwd(), ".context-builder-fixtures");

function recreateFixtureDir(name: string): string {
  const fixtureRoot = join(FIXTURES_ROOT, name);
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
  return fixtureRoot;
}

beforeAll(() => {
  rmSync(FIXTURES_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURES_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURES_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  mockedGetChangedFiles.mockReset();
  mockedGetFileDiff.mockReset();
  mockedReadFileAtHead.mockReset();
  const { readFile: realReadFile } =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  mockedReadFile.mockImplementation(realReadFile);
});

describe("buildFileContexts", () => {
  it("uses explicitly provided changed files instead of querying git", async () => {
    const fixtureRoot = recreateFixtureDir("explicit-file-list");
    const filePath = "src/feature.ts";
    const fullContent = "export const value = 3;\n";
    const gitDiff = "@@ -1 +1 @@\n-export const value = 2;\n+export const value = 3;\n";

    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(join(fixtureRoot, filePath), fullContent, "utf8");

    mockedGetFileDiff.mockResolvedValue(gitDiff);

    const result = await buildFileContexts(fixtureRoot, "base-sha", [filePath]);

    expect(mockedGetChangedFiles).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
    expect(result.contexts).toEqual([
      {
        filePath,
        fullContent,
        gitDiff,
      },
    ]);
  });

  it("emits warning for unsupported file extensions", async () => {
    const fixtureRoot = recreateFixtureDir("unsupported-extension");
    mockedGetChangedFiles.mockResolvedValue(["assets/logo.png"]);

    const result = await buildFileContexts(fixtureRoot, "base-sha");

    expect(result.contexts).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      filePath: "assets/logo.png",
      code: "UNSUPPORTED_FILE_TYPE",
    });
    expect(result.warnings[0]?.message).toContain('unsupported extension ".png"');
    expect(mockedGetFileDiff).not.toHaveBeenCalled();
  });

  it("emits FILE_NOT_FOUND warning when changed file is missing (ENOENT)", async () => {
    const fixtureRoot = recreateFixtureDir("missing-file");
    mockedGetChangedFiles.mockResolvedValue(["src/missing.ts"]);

    const result = await buildFileContexts(fixtureRoot, "base-sha");

    expect(result.contexts).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      filePath: "src/missing.ts",
      code: "FILE_NOT_FOUND",
    });
    expect(result.warnings[0]?.message).toContain("does not exist in the post-change working tree");
    expect(mockedGetFileDiff).not.toHaveBeenCalled();
  });

  it("emits FILE_READ_FAILED warning when file reading fails for non-ENOENT errors", async () => {
    const fixtureRoot = recreateFixtureDir("read-failure");
    mkdirSync(join(fixtureRoot, "src", "blocked.ts"), { recursive: true });
    mockedGetChangedFiles.mockResolvedValue(["src/blocked.ts"]);

    const result = await buildFileContexts(fixtureRoot, "base-sha");

    expect(result.contexts).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      filePath: "src/blocked.ts",
      code: "FILE_READ_FAILED",
    });
    expect(result.warnings[0]?.message).toContain("could not be read");
    expect(mockedGetFileDiff).not.toHaveBeenCalled();
  });

  it("emits FILE_READ_FAILED warning on EACCES (permission denied)", async () => {
    const fixtureRoot = recreateFixtureDir("eacces");
    mockedGetChangedFiles.mockResolvedValue(["src/secret.ts"]);
    mockedReadFile.mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" })
    );

    const result = await buildFileContexts(fixtureRoot, "base-sha");

    expect(result.contexts).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      filePath: "src/secret.ts",
      code: "FILE_READ_FAILED",
    });
    expect(result.warnings[0]?.message).toContain("could not be read");
    expect(mockedGetFileDiff).not.toHaveBeenCalled();
  });

  it("builds context with empty fullContent for a zero-byte file", async () => {
    const fixtureRoot = recreateFixtureDir("empty-file");
    const filePath = "src/empty.ts";

    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(join(fixtureRoot, filePath), "", "utf8");

    mockedGetChangedFiles.mockResolvedValue([filePath]);
    mockedGetFileDiff.mockResolvedValue("");

    const result = await buildFileContexts(fixtureRoot, "base-sha");

    expect(result.warnings).toEqual([]);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]).toMatchObject({
      filePath,
      fullContent: "",
      gitDiff: "",
    });
  });

  it("assembles contexts for supported files that can be read", async () => {
    const fixtureRoot = recreateFixtureDir("successful-assembly");
    const filePath = "src/feature.ts";
    const fullContent = "export const value = 2;\n";
    const gitDiff = "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";

    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(join(fixtureRoot, filePath), fullContent, "utf8");

    mockedGetChangedFiles.mockResolvedValue([filePath]);
    mockedGetFileDiff.mockResolvedValue(gitDiff);

    const result = await buildFileContexts(fixtureRoot, "base-sha");

    expect(result.warnings).toEqual([]);
    expect(result.contexts).toEqual([
      {
        filePath,
        fullContent,
        gitDiff,
      },
    ]);
    expect(mockedGetFileDiff).toHaveBeenCalledTimes(1);
    expect(mockedGetFileDiff).toHaveBeenCalledWith("base-sha", filePath, "working-tree");
  });

  it("synthesizes a whole-file addition diff for an untracked file in working-tree scope", async () => {
    const fixtureRoot = recreateFixtureDir("untracked-file");
    const filePath = "src/new.ts";

    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(join(fixtureRoot, filePath), "const a = 1;\nconst b = 2;\n", "utf8");

    mockedGetChangedFiles.mockResolvedValue([filePath]);
    mockedGetFileDiff.mockResolvedValue("");

    const result = await buildFileContexts(fixtureRoot, "base-sha");

    expect(result.contexts[0]?.gitDiff).toBe(
      ["--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1,2 @@", "+const a = 1;", "+const b = 2;"].join("\n")
    );
  });

  it("reads content from HEAD instead of the working tree in committed scope", async () => {
    const fixtureRoot = recreateFixtureDir("committed-scope");
    const filePath = "src/feature.ts";
    const gitDiff = "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";

    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(join(fixtureRoot, filePath), "export const value = 3; // uncommitted\n", "utf8");

    mockedGetChangedFiles.mockResolvedValue([filePath]);
    mockedGetFileDiff.mockResolvedValue(gitDiff);
    mockedReadFileAtHead.mockResolvedValue("export const value = 2;\n");

    const result = await buildFileContexts(fixtureRoot, "base-sha", undefined, "committed");

    expect(mockedGetChangedFiles).toHaveBeenCalledWith("base-sha", "committed");
    expect(mockedGetFileDiff).toHaveBeenCalledWith("base-sha", filePath, "committed");
    expect(result.contexts).toEqual([
      { filePath, fullContent: "export const value = 2;\n", gitDiff },
    ]);
  });

  it("emits FILE_NOT_FOUND in committed scope when the file is absent at HEAD", async () => {
    const fixtureRoot = recreateFixtureDir("committed-missing");
    mockedGetChangedFiles.mockResolvedValue(["src/deleted.ts"]);
    mockedReadFileAtHead.mockResolvedValue(undefined);

    const result = await buildFileContexts(fixtureRoot, "base-sha", undefined, "committed");

    expect(result.contexts).toEqual([]);
    expect(result.warnings[0]).toMatchObject({ filePath: "src/deleted.ts", code: "FILE_NOT_FOUND" });
    expect(mockedGetFileDiff).not.toHaveBeenCalled();
  });
});

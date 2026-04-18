import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFileContexts } from "../src/contextBuilder";
import { getChangedFiles, getFileDiff } from "../src/git";

vi.mock("../src/git", () => ({
  getChangedFiles: vi.fn(),
  getFileDiff: vi.fn(),
}));

const mockedGetChangedFiles = vi.mocked(getChangedFiles);
const mockedGetFileDiff = vi.mocked(getFileDiff);

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

beforeEach(() => {
  mockedGetChangedFiles.mockReset();
  mockedGetFileDiff.mockReset();
});

describe("buildFileContexts", () => {
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
    expect(mockedGetFileDiff).toHaveBeenCalledWith("base-sha", filePath);
  });
});

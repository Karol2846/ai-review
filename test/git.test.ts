import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getChangedFiles, getFileDiff, GitServiceError } from "../src/git";

const FIXTURES_ROOT = join(process.cwd(), ".git-fixtures");

function recreateFixtureDir(name: string): string {
  const fixtureRoot = join(FIXTURES_ROOT, name);
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
  return fixtureRoot;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd, reject: true });
  return stdout;
}

beforeAll(() => {
  rmSync(FIXTURES_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURES_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURES_ROOT, { recursive: true, force: true });
});

describe("git service input validation", () => {
  it("throws GitServiceError when getChangedFiles receives an empty mergeBase", async () => {
    await expect(getChangedFiles("   ")).rejects.toBeInstanceOf(GitServiceError);
    await expect(getChangedFiles("   ")).rejects.toMatchObject({
      command: [],
      message: "mergeBase must not be empty.",
    });
  });

  it("throws GitServiceError when getFileDiff receives empty commitSha or filePath", async () => {
    await expect(getFileDiff("   ", "src/feature.ts")).rejects.toBeInstanceOf(GitServiceError);
    await expect(getFileDiff("base-sha", "   ")).rejects.toBeInstanceOf(GitServiceError);

    await expect(getFileDiff("   ", "src/feature.ts")).rejects.toMatchObject({
      command: [],
      message: "commitSha must not be empty.",
    });
    await expect(getFileDiff("base-sha", "   ")).rejects.toMatchObject({
      command: [],
      message: "filePath must not be empty.",
    });
  });
});

describe("git service local integration", () => {
  it("returns changed files and file diff content from a local repository history", async () => {
    const repoRoot = recreateFixtureDir("local-integration");
    const filePath = "src/feature.ts";
    const absoluteFilePath = join(repoRoot, filePath);

    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.name", "Smoke Tester"]);
    await runGit(repoRoot, ["config", "user.email", "smoke.tester@example.com"]);

    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(absoluteFilePath, "export const value = 1;\n", "utf8");
    await runGit(repoRoot, ["add", filePath]);
    await runGit(repoRoot, ["commit", "-m", "initial commit"]);

    const mergeBase = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();

    writeFileSync(absoluteFilePath, "export const value = 2;\nexport const added = true;\n", "utf8");
    await runGit(repoRoot, ["add", filePath]);
    await runGit(repoRoot, ["commit", "-m", "update feature"]);

    const previousCwd = process.cwd();
    process.chdir(repoRoot);

    try {
      const changedFiles = await getChangedFiles(mergeBase);
      const diff = await getFileDiff(mergeBase, filePath);

      expect(changedFiles).toContain(filePath);
      expect(diff).toContain("-export const value = 1;");
      expect(diff).toContain("+export const value = 2;");
      expect(diff).toContain("+export const added = true;");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

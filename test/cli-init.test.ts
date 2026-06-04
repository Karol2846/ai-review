import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INIT_TEMPLATE, runInit } from "../src/init";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ai-review-init-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeParams(overrides: Partial<Parameters<typeof runInit>[0]> = {}): Parameters<typeof runInit>[0] {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd: tmpDir,
    force: false,
    gitRepoRoot: tmpDir,
    writeStdout: (m) => stdout.push(m),
    writeStderr: (m) => stderr.push(m),
    ...overrides,
  };
}

describe("runInit", () => {
  it("creates ai-review.json with correct template shape", async () => {
    const stdout: string[] = [];
    const exitCode = await runInit(makeParams({ writeStdout: (m) => stdout.push(m) }));

    expect(exitCode).toBe(0);

    const content = await readFile(join(tmpDir, "ai-review.json"), "utf8");
    const parsed = JSON.parse(content) as unknown;

    expect(typeof (parsed as Record<string, unknown>)["model"]).toBe("string");
    expect((parsed as Record<string, unknown>)["agents"]).toBeDefined();
    const agents = (parsed as Record<string, unknown>)["agents"] as Record<string, unknown>;
    expect(agents["tester"]).toBeDefined();
    expect(agents["security"]).toBeDefined();
    expect((agents["security"] as Record<string, unknown>)["instructionsFile"]).toBeDefined();
  });

  it("reports the created file path to stdout", async () => {
    const stdout: string[] = [];
    await runInit(makeParams({ writeStdout: (m) => stdout.push(m) }));

    const targetPath = join(tmpDir, "ai-review.json");
    expect(stdout.some((m) => m.includes(targetPath))).toBe(true);
  });

  it("writes valid JSON ending with a newline", async () => {
    await runInit(makeParams());

    const content = await readFile(join(tmpDir, "ai-review.json"), "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
    expect(content.endsWith("\n")).toBe(true);
  });

  it("returns 1 and does not overwrite when file exists and force is false", async () => {
    const original = '{ "model": "original" }';
    await writeFile(join(tmpDir, "ai-review.json"), original, "utf8");

    const exitCode = await runInit(makeParams({ force: false }));

    expect(exitCode).toBe(1);
    const content = await readFile(join(tmpDir, "ai-review.json"), "utf8");
    expect(content).toBe(original);
  });

  it("reports an error message when file exists and force is false", async () => {
    await writeFile(join(tmpDir, "ai-review.json"), "{}", "utf8");
    const stderr: string[] = [];

    await runInit(makeParams({ force: false, writeStderr: (m) => stderr.push(m) }));

    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr.some((m) => /already exists/iu.test(m) || /--force/u.test(m))).toBe(true);
  });

  it("overwrites the file when force is true", async () => {
    await writeFile(join(tmpDir, "ai-review.json"), '{ "model": "old" }', "utf8");

    const exitCode = await runInit(makeParams({ force: true }));

    expect(exitCode).toBe(0);
    const content = await readFile(join(tmpDir, "ai-review.json"), "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed["model"]).not.toBe("old");
  });

  it("shows no repo-root note when cwd equals gitRepoRoot", async () => {
    const stderr: string[] = [];
    await runInit(makeParams({
      cwd: tmpDir,
      gitRepoRoot: tmpDir,
      writeStderr: (m) => stderr.push(m),
    }));

    expect(stderr.every((m) => !/repo root/iu.test(m))).toBe(true);
  });

  it("shows a repo-root note when cwd differs from gitRepoRoot", async () => {
    const repoRoot = resolve(tmpDir, "..");
    const stderr: string[] = [];
    await runInit(makeParams({
      cwd: tmpDir,
      gitRepoRoot: repoRoot,
      writeStderr: (m) => stderr.push(m),
    }));

    expect(stderr.some((m) => /repo root/iu.test(m))).toBe(true);
  });

  it("shows a repo-root note when gitRepoRoot is null (not in a git repo)", async () => {
    const stderr: string[] = [];
    await runInit(makeParams({
      gitRepoRoot: null,
      writeStderr: (m) => stderr.push(m),
    }));

    expect(stderr.some((m) => /repo root/iu.test(m))).toBe(true);
  });
});

describe("INIT_TEMPLATE", () => {
  it("has a string model field", () => {
    expect(typeof INIT_TEMPLATE.model).toBe("string");
  });

  it("has a tester agent with globs", () => {
    expect(Array.isArray(INIT_TEMPLATE.agents.tester.globs)).toBe(true);
    expect(INIT_TEMPLATE.agents.tester.globs.length).toBeGreaterThan(0);
  });

  it("has a security custom agent with instructionsFile", () => {
    expect(typeof INIT_TEMPLATE.agents.security.instructionsFile).toBe("string");
  });
});

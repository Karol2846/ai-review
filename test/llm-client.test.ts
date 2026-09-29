import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLlmClient,
  type CommandInvocation,
  type CommandOutcome,
  type CommandRunner,
} from "../src/llmClient";
import { LlmProviderError } from "../src/llmProvider";

const ok = (stdout: string): CommandOutcome => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const failed = (stderr: string, stdout = ""): CommandOutcome => ({ exitCode: 1, stdout, stderr, timedOut: false });

function fakeRunner(outcome: CommandOutcome | ((inv: CommandInvocation) => CommandOutcome)) {
  return vi.fn<CommandRunner>(async (inv) => (typeof outcome === "function" ? outcome(inv) : outcome));
}

function claudeJson(result: string, isError = false): string {
  return JSON.stringify({ type: "result", subtype: isError ? "error" : "success", is_error: isError, result });
}

async function expectProviderError(promise: Promise<unknown>, code: string): Promise<LlmProviderError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(LlmProviderError);
  expect((error as LlmProviderError).code).toBe(code);
  return error as LlmProviderError;
}

describe("createLlmClient", () => {
  it("rejects an empty prompt without spawning anything", async () => {
    const run = fakeRunner(ok(""));
    const client = createLlmClient({ provider: "claude-code" }, run);
    await expectProviderError(client.complete("   "), "INVALID_PROMPT");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports COMMAND_NOT_FOUND with an install hint when the CLI is missing", async () => {
    const run = fakeRunner({ exitCode: undefined, stdout: "", stderr: "", errorCode: "ENOENT", timedOut: false });
    const client = createLlmClient({ provider: "codex" }, run);
    const error = await expectProviderError(client.complete("review"), "COMMAND_NOT_FOUND");
    expect(error.message).toContain("npm install -g @openai/codex");
  });

  it("reports TIMEOUT when the CLI does not finish in time", async () => {
    const run = fakeRunner({ exitCode: undefined, stdout: "", stderr: "", timedOut: true });
    const client = createLlmClient({ provider: "copilot" }, run);
    await expectProviderError(client.complete("review"), "TIMEOUT");
  });

  it.each([
    ["Error: Not logged in. Please run /login", "NOT_AUTHENTICATED"],
    ["429 Too Many Requests", "RATE_LIMITED"],
    ["API Error: 529 overloaded", "SERVICE_UNAVAILABLE"],
    ["getaddrinfo ENOTFOUND api.example.com", "NETWORK_ERROR"],
    ["something unexpected", "COMMAND_FAILED"],
  ])("maps failure output %j to %s", async (stderr, code) => {
    const client = createLlmClient({ provider: "copilot" }, fakeRunner(failed(stderr)));
    await expectProviderError(client.complete("review"), code);
  });
});

describe("claude-code provider", () => {
  it("runs claude headless without tools or session persistence, prompt on stdin", async () => {
    const run = fakeRunner(ok(claudeJson("[]")));
    const client = createLlmClient({ provider: "claude-code" }, run);

    await expect(client.complete("review this diff")).resolves.toBe("[]");

    const inv = run.mock.calls[0][0];
    expect(inv.command).toBe("claude");
    expect(inv.input).toBe("review this diff");
    expect(inv.args).toContain("-p");
    expect(inv.args).toContain("--no-session-persistence");
    expect(inv.args).toContain("--strict-mcp-config");
    expect(inv.args.slice(-2)).toEqual(["--tools", ""]);
    expect(inv.args).not.toContain("--model");
  });

  it("passes the configured model", async () => {
    const run = fakeRunner(ok(claudeJson("[]")));
    await createLlmClient({ provider: "claude-code", model: "haiku" }, run).complete("x");
    const args = run.mock.calls[0][0].args;
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
  });

  it("maps an is_error JSON result to a provider error", async () => {
    const run = fakeRunner(failed("", claudeJson("Invalid API key · Please run /login", true)));
    const client = createLlmClient({ provider: "claude-code" }, run);
    const error = await expectProviderError(client.complete("x"), "NOT_AUTHENTICATED");
    expect(error.message).toContain("Invalid API key");
  });

  it("fails when stdout is not a JSON result", async () => {
    const client = createLlmClient({ provider: "claude-code" }, fakeRunner(ok("plain text")));
    await expectProviderError(client.complete("x"), "COMMAND_FAILED");
  });
});

describe("codex provider", () => {
  it("runs codex exec ephemerally in a read-only sandbox and returns the last message", async () => {
    let workDir = "";
    const run = fakeRunner((inv) => {
      workDir = inv.cwd;
      const outputFile = inv.args[inv.args.indexOf("--output-last-message") + 1];
      writeFileSync(outputFile, '[{"from":"file"}]', "utf8");
      return ok("progress noise");
    });
    const client = createLlmClient({ provider: "codex", model: "gpt-5-codex" }, run);

    await expect(client.complete("review")).resolves.toBe('[{"from":"file"}]');

    const inv = run.mock.calls[0][0];
    expect(inv.command).toBe("codex");
    expect(inv.input).toBe("review");
    expect(inv.args[0]).toBe("exec");
    expect(inv.args).toContain("--ephemeral");
    expect(inv.args[inv.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(inv.args[inv.args.indexOf("--model") + 1]).toBe("gpt-5-codex");
    expect(inv.args.at(-1)).toBe("-");
    expect(existsSync(workDir)).toBe(false);
  });
});

describe("copilot provider", () => {
  let copilotHome: string;
  let previousCopilotHome: string | undefined;

  beforeEach(() => {
    previousCopilotHome = process.env.COPILOT_HOME;
    copilotHome = mkdtempSync(join(tmpdir(), "ai-review-copilot-home-"));
    process.env.COPILOT_HOME = copilotHome;
  });

  afterEach(() => {
    if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousCopilotHome;
  });

  function sessionIdOf(inv: CommandInvocation): string {
    const arg = inv.args.find((a) => a.startsWith("--session-id="));
    return arg!.slice("--session-id=".length);
  }

  function simulateSessionState(inv: CommandInvocation): string {
    const sessionId = sessionIdOf(inv);
    mkdirSync(join(copilotHome, "session-state", sessionId, "checkpoints"), { recursive: true });
    mkdirSync(join(copilotHome, "session-state", ".session-operation-locks"), { recursive: true });
    writeFileSync(join(copilotHome, "session-state", ".session-operation-locks", `${sessionId}.lock`), "");
    return sessionId;
  }

  it("runs copilot in silent prompt mode without tools and returns stdout", async () => {
    const run = fakeRunner(ok("[]"));
    await expect(createLlmClient({ provider: "copilot" }, run).complete("-- review --")).resolves.toBe("[]");

    const inv = run.mock.calls[0][0];
    expect(inv.command).toBe("copilot");
    expect(inv.args).toContain("--prompt=-- review --");
    expect(inv.args).toContain("--silent");
    expect(inv.args.at(-1)).toBe("--available-tools");
    expect(sessionIdOf(inv)).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("deletes the session it created so it never shows up in Copilot's history", async () => {
    let sessionId = "";
    const run = fakeRunner((inv) => {
      sessionId = simulateSessionState(inv);
      return ok("[]");
    });
    await createLlmClient({ provider: "copilot" }, run).complete("review");

    expect(existsSync(join(copilotHome, "session-state", sessionId))).toBe(false);
    expect(existsSync(join(copilotHome, "session-state", ".session-operation-locks", `${sessionId}.lock`))).toBe(
      false
    );
  });

  it("deletes the session even when the call fails", async () => {
    let sessionId = "";
    const run = fakeRunner((inv) => {
      sessionId = simulateSessionState(inv);
      return failed("boom");
    });
    await expectProviderError(createLlmClient({ provider: "copilot" }, run).complete("review"), "COMMAND_FAILED");
    expect(existsSync(join(copilotHome, "session-state", sessionId))).toBe(false);
  });

  it("uses a fresh session id per call", async () => {
    const run = fakeRunner(ok("[]"));
    const client = createLlmClient({ provider: "copilot" }, run);
    await client.complete("a");
    await client.complete("b");
    expect(sessionIdOf(run.mock.calls[0][0])).not.toBe(sessionIdOf(run.mock.calls[1][0]));
  });
});

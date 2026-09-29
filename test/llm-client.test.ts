import { describe, expect, it, vi } from "vitest";

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
    const client = createLlmClient({ provider: "claude-code" }, run);
    const error = await expectProviderError(client.complete("review"), "COMMAND_NOT_FOUND");
    expect(error.message).toContain("npm install -g @anthropic-ai/claude-code");
  });

  it("reports TIMEOUT when the CLI does not finish in time", async () => {
    const run = fakeRunner({ exitCode: undefined, stdout: "", stderr: "", timedOut: true });
    const client = createLlmClient({ provider: "claude-code" }, run);
    await expectProviderError(client.complete("review"), "TIMEOUT");
  });

  it.each([
    ["Error: Not logged in. Please run /login", "NOT_AUTHENTICATED"],
    ["429 Too Many Requests", "RATE_LIMITED"],
    ["API Error: 529 overloaded", "SERVICE_UNAVAILABLE"],
    ["getaddrinfo ENOTFOUND api.example.com", "NETWORK_ERROR"],
    ["something unexpected", "COMMAND_FAILED"],
  ])("maps failure output %j to %s", async (stderr, code) => {
    const client = createLlmClient({ provider: "claude-code" }, fakeRunner(failed(stderr)));
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

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import { LlmProviderError, type LlmProviderErrorCode } from "./llmProvider";

/**
 * Coding-agent CLIs that ai-review can delegate prompts to. Each one reuses the login the user
 * already has in that tool — ai-review never handles API keys.
 */
export const PROVIDER_KINDS = ["claude-code", "codex"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderInfo {
  readonly label: string;
  readonly command: string;
  readonly installHint: string;
  readonly loginHint: string;
}

export const PROVIDER_INFO: Readonly<Record<ProviderKind, ProviderInfo>> = {
  "claude-code": {
    label: "Claude Code",
    command: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginHint: "run `claude` once and log in",
  },
  codex: {
    label: "OpenAI Codex CLI",
    command: "codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "run `codex login`",
  },
};

export interface LlmClientConfig {
  readonly provider: ProviderKind;
  /** Optional model name passed to the CLI; when omitted the CLI's own default model is used. */
  readonly model?: string;
}

/** Sends one prompt to the model and resolves with the raw text of its reply. */
export interface LlmClient {
  readonly provider: ProviderKind;
  complete(prompt: string): Promise<string>;
}

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly cwd: string;
}

export interface CommandOutcome {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn error code, e.g. "ENOENT" when the command is not installed. */
  readonly errorCode?: string;
  readonly timedOut: boolean;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandOutcome>;

const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const SYSTEM_PROMPT =
  "You are a code review engine invoked by a script. You have no tools. " +
  "Follow the instructions in the user message and reply only with the requested JSON.";

export const runCommand: CommandRunner = async (invocation) => {
  const result = await execa(invocation.command, [...invocation.args], {
    cwd: invocation.cwd,
    input: invocation.input ?? "",
    reject: false,
    timeout: COMMAND_TIMEOUT_MS,
    stripFinalNewline: true,
  });
  const errorCode = (result as { code?: unknown }).code;
  return {
    exitCode: result.exitCode,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(typeof errorCode === "string" ? { errorCode } : {}),
    timedOut: result.timedOut === true,
  };
};

const AUTH_PATTERN =
  /(not logged in|log ?in|authenticat|unauthori[sz]ed|\b401\b|invalid api key|credentials)/iu;
const RATE_LIMIT_PATTERN = /(rate.?limit|\b429\b|too many requests|usage limit|quota)/iu;
const UNAVAILABLE_PATTERN = /(overloaded|\b5\d\d\b|service unavailable)/iu;
const NETWORK_PATTERN = /(network|econnrefused|econnreset|enotfound|fetch failed)/iu;

function firstNonEmpty(...values: readonly string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "no output";
}

function classifyFailureText(detail: string): LlmProviderErrorCode {
  if (RATE_LIMIT_PATTERN.test(detail)) return "RATE_LIMITED";
  if (AUTH_PATTERN.test(detail)) return "NOT_AUTHENTICATED";
  if (UNAVAILABLE_PATTERN.test(detail)) return "SERVICE_UNAVAILABLE";
  if (NETWORK_PATTERN.test(detail)) return "NETWORK_ERROR";
  return "COMMAND_FAILED";
}

function providerError(provider: ProviderKind, code: LlmProviderErrorCode, detail: string): LlmProviderError {
  const info = PROVIDER_INFO[provider];
  const hint = code === "NOT_AUTHENTICATED" ? ` (${info.loginHint})` : "";
  return new LlmProviderError(code, `${info.label} failed${hint}: ${detail}`);
}

/** Throws a mapped LlmProviderError when the command did not complete successfully. */
function assertCommandSucceeded(provider: ProviderKind, outcome: CommandOutcome): void {
  const info = PROVIDER_INFO[provider];
  if (outcome.errorCode === "ENOENT") {
    throw new LlmProviderError(
      "COMMAND_NOT_FOUND",
      `${info.label} (\`${info.command}\`) was not found in PATH. Install it with \`${info.installHint}\`, ` +
        `then ${info.loginHint}.`
    );
  }
  if (outcome.timedOut) {
    throw new LlmProviderError("TIMEOUT", `${info.label} did not answer within ${COMMAND_TIMEOUT_MS / 1000}s.`);
  }
  if (outcome.exitCode !== 0) {
    const detail = firstNonEmpty(outcome.stderr, outcome.stdout);
    throw providerError(provider, classifyFailureText(detail), detail);
  }
}

function assertPromptNotEmpty(prompt: string): void {
  if (prompt.trim().length === 0) {
    throw new LlmProviderError("INVALID_PROMPT", "Prompt must not be empty.");
  }
}

interface ClaudeJsonResult {
  readonly is_error?: unknown;
  readonly result?: unknown;
}

function parseClaudeJson(stdout: string): ClaudeJsonResult | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeJsonResult) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `claude -p` with no tools, no MCP servers, no project settings and — most importantly —
 * `--no-session-persistence`, so reviews never show up in the user's Claude Code session history.
 */
async function completeWithClaudeCode(
  config: LlmClientConfig,
  prompt: string,
  run: CommandRunner
): Promise<string> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources",
    "user",
    "--disable-slash-commands",
    "--system-prompt",
    SYSTEM_PROMPT,
    ...(config.model ? ["--model", config.model] : []),
    // Variadic option: keep it last so it cannot swallow other arguments.
    "--tools",
    "",
  ];
  const outcome = await run({ command: "claude", args, input: prompt, cwd: tmpdir() });
  const json = parseClaudeJson(outcome.stdout);

  if (json?.is_error === true) {
    const detail = typeof json.result === "string" ? json.result : firstNonEmpty(outcome.stderr, outcome.stdout);
    throw providerError("claude-code", classifyFailureText(detail), detail);
  }
  assertCommandSucceeded("claude-code", outcome);

  if (json === undefined || typeof json.result !== "string") {
    throw new LlmProviderError("COMMAND_FAILED", "Claude Code returned output that is not a JSON result.");
  }
  return json.result;
}

/**
 * `codex exec --ephemeral` runs without persisting session files; the read-only sandbox and a
 * scratch working directory keep the agent from touching the user's repository.
 */
async function completeWithCodex(config: LlmClientConfig, prompt: string, run: CommandRunner): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "ai-review-codex-"));
  const outputFile = join(workDir, "last-message.txt");
  try {
    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-last-message",
      outputFile,
      ...(config.model ? ["--model", config.model] : []),
      "-",
    ];
    const outcome = await run({ command: "codex", args, input: prompt, cwd: workDir });
    assertCommandSucceeded("codex", outcome);

    try {
      return await readFile(outputFile, "utf8");
    } catch {
      return outcome.stdout;
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function createLlmClient(config: LlmClientConfig, run: CommandRunner = runCommand): LlmClient {
  const complete = (prompt: string): Promise<string> => {
    switch (config.provider) {
      case "claude-code":
        return completeWithClaudeCode(config, prompt, run);
      case "codex":
        return completeWithCodex(config, prompt, run);
    }
  };

  return {
    provider: config.provider,
    async complete(prompt: string): Promise<string> {
      assertPromptNotEmpty(prompt);
      return complete(prompt);
    },
  };
}

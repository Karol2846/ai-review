# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Goal                     | Command                                                                                 |
|--------------------------|-----------------------------------------------------------------------------------------|
| Build                    | `npm run build`                                                                         |
| Type-check only          | `npm run typecheck`                                                                     |
| Run all tests            | `npm run test`                                                                          |
| Single-scope test run    | `ai-review --agents "tester" --report`                                                  |
| Exclude files from review | `ai-review --exclude "**/*.generated.ts,vendor/**"`                                    |
| Install globally         | `npm run build && npm install -g .`                                                     |
| Run with terminal report | `ai-review --report`                                                                    |
| Raw JSON output          | `ai-review --json`                                                                      |
| Remove inserted comments | `ai-review --clean`                                                                     |

Tests use **Vitest** and live under `test/` (not compiled into `dist/`).

## Architecture

`ai-review` is a TypeScript/Node multi-agent diff reviewer. The four pipeline phases:

1. **Scope** (`src/cli.ts`, `src/git.ts`) — resolves repo root, base branch (auto-detects `origin/HEAD`, falls back to `main`/`master`), merge-base, and changed files.
2. **Analyze** (`src/reviewPipeline.ts`, `src/router.ts`, `src/routingTypes.ts`, `src/runner.ts`, `src/batcher.ts`, `src/promptBuilder.ts`, `src/contextBuilder.ts`, `src/llmClient.ts`, `src/llmAdapter.ts`) — routes changed files to agents via glob patterns, builds `(file × agent)` task batches, sends diff + bounded file context to the LLM via Vercel AI SDK's `generateText`, parses JSON findings from the response via `src/responseParser.ts`.
3. **Aggregate** (`src/aggregator.ts`) — deduplicates via fingerprint, applies min-severity filter, sorts by severity/file/line.
4. **Output** (`src/reporter.ts`, `src/annotator.ts`) — `--report` renders colored terminal output; default mode inserts `// TODO [ai-review]` comments into source files; `--clean` removes them.

### LLM integration (Vercel AI SDK)

`src/llmClient.ts` — `createLanguageModel(config: LlmClientConfig): LanguageModel`. Supports three provider kinds:
- `openai-compatible` (`@ai-sdk/openai`) — works with OpenAI, Groq, OpenRouter, or any OpenAI-compatible endpoint; optional `baseURL`.
- `anthropic` (`@ai-sdk/anthropic`)
- `google` (`@ai-sdk/google`)

`src/llmAdapter.ts` — `generateFindings(model, prompt): Promise<Finding[]>`. Calls Vercel AI SDK's `generateText` (with `maxRetries: 0`), then parses the JSON response via `src/responseParser.ts`. Maps SDK errors (`APICallError`, `AbortError`, etc.) to `LlmProviderError` codes.

`src/llmProvider.ts` — error types only: `LlmProviderError` class and `LlmProviderErrorCode` union. No provider interface or `sendPrompt` method.

Provider is selected by an **interactive setup wizard** in `src/setupWizard.ts`, triggered on first CLI run when no config is found. Config is stored at `~/.ai-review/.ai-review-install-provider.json` (path defined by `INSTALL_PROVIDER_CONFIG_DIR` in `src/installProviderConfig.ts`). `scripts/postinstall.js` is non-interactive — it only copies `agents/` and `skill/` into `~/.copilot/`. At runtime `src/cli.ts` reads the config via `loadInstallProviderConfig`; if missing and stdin is a TTY, the wizard runs, saves config, and returns `SETUP_COMPLETED` (sentinel) — the CLI prints instructions to set the API key env var and re-run; if missing and non-TTY (CI, Docker, `--ignore-scripts`), the CLI errors out.

### Routing and configuration

Changed files are matched to agents by glob patterns via `src/router.ts` (`routeFilesToAgents`, uses `micromatch`). Types live in `src/routingTypes.ts` (`RoutingRuntimeConfig`, `AgentGlobsMap`, `AgentName`, `CustomAgentsMap`). Default agent-to-file-glob routing is in `src/defaultConfig.ts`. Per-repo overrides via `ai-review.json` in the repo root are parsed by `src/repoConfig.ts` (`parseRepoConfig` → `RepoConfigOverride { model, agents, exclude }`). Unknown keys or agent names cause a hard-fail. A future phase may add a `severity` section.

- **`routing.agentGlobs`** — extends the **built-in** agents' globs only (unknown agent names hard-fail here; define new agents under `agents`). User globs are **appended** to the defaults (extend semantics, with dedup), merged by `mergeRoutingConfig`.
- **`model`** (phase 2) — a per-repo model override: a plain **string** naming the model to use for this repo (`UserModelConfigOverride = string`). Only the model name is overridable per repo; provider, API-key env var, and `baseURL` always come from the install config (re-run the install wizard to change those). Applied by `mergeProviderConfig` (`src/installProviderConfig.ts`), which copies the install config and swaps in the model name (`{ ...base, model }`), then in `src/cli.ts` via `resolveLanguageModel(writeStdout, modelOverride)`. A non-string or empty `model` hard-fails. Example:

  ```json
  { "model": "claude-sonnet-4-6" }
  ```

- **`agents`** (phase 3) — per-repo **custom agents** (beyond the 5 built-ins). Each entry is `{ globs, instructionsFile }`: `globs` route changed files to the agent; `instructionsFile` is a **required** repo-relative path to its `.agent.md` instruction file (no default — always explicit). The name must match `^[a-z0-9][a-z0-9-]*$` and must not collide with a built-in agent. Custom globs are folded into the routing config via `customAgentsToRoutingOverride` + `mergeRoutingConfig`; `loadAgentInstructionsFromDisk` loads a custom agent's instruction from its `instructionsFile` (skipping the directory search). A selected custom agent whose instruction cannot be loaded is a **fail-fast** config error (exit 1). Example:

  ```json
  { "agents": { "security": { "globs": ["**/*.java"], "instructionsFile": "agents/security.agent.md" } } }
  ```

- **`exclude`** (phase 4) — a flat array of glob patterns whose matching files are dropped **before routing**, so no agent (built-in or custom) reviews them. Parsed by `parseExcludeSection` (reuses `validateGlobsArray`, so an empty array hard-fails). Applied in `src/cli.ts` by `excludeChangedFiles` (uses `micromatch.isMatch` + `normalizeGlobPath`). The CLI flag `--exclude <list>` (comma-separated globs, parsed by `parseCsvList`) adds to this: the effective exclusion set is the **union** of `ai-review.json`'s `exclude` and `--exclude`, deduplicated. Example:

  ```json
  { "exclude": ["**/*.generated.ts", "vendor/**"] }
  ```

When `--agents` is **not** passed, the run includes **every configured agent** (built-in + custom); `--agents <list>` narrows the selection.

### Agent instructions

Agent prompts (`agents/*.agent.md`) are loaded from the first matching path among: `<repo>/agents/`, `<dist>/../agents/`, `~/.copilot/agents/`. YAML front matter is stripped before the instruction is sent. Five built-in agents: `clean-coder`, `tester`, `architect`, `ddd-reviewer`, `performance`. Repos can add custom agents via the `agents` section of `ai-review.json` (see Routing and configuration), whose instructions load from an explicit `instructionsFile` path rather than the directory search.

### Finding contract

Findings conform to the `Finding` interface in `src/findingSchema.ts`: `{ file, line, agent, severity, category, message, suggestion, fingerprint }` (optional: `endLine`). The LLM is prompted to return a JSON array matching this shape; `src/responseParser.ts` extracts and validates the array, dropping non-conforming records. `schemas/finding.schema.json` exists for documentation reference only — nothing in the runtime loads or validates against it.

### Annotation lifecycle

Inserted comments must contain `[ai-review]`. Cleanup (`--clean`) removes every line containing this marker. Insertions are applied bottom-up by line number to avoid shifting target positions.

## Key conventions

- **Diff-first scope**: review always operates on `merge-base(origin/<base>, HEAD)..HEAD`, never the whole repo.
- **Structured output via prompt + parser**: `generateText` sends a JSON-format instruction; `src/responseParser.ts` extracts and validates the response. Non-conforming records are dropped silently. Transient LLM errors are retried by `src/runner.ts` (not by the SDK — `generateText` runs with `maxRetries: 0`).
- **`CliRuntimeDependencies` interface** (`src/cli.ts`): all I/O and side-effectful operations are injected through this interface, making `runCli` fully unit-testable without mocking globals.
- **Transient error retry**: `src/runner.ts` retries on `LlmProviderError` codes marked transient in `src/llmProvider.ts` (`COMMAND_FAILED`, `RATE_LIMITED`, `NETWORK_ERROR`, `TIMEOUT`, `SERVICE_UNAVAILABLE`).
- **CLI args module**: `src/cliArgs.ts` (`parseCliArgs`, `formatCliUsage`, `CliArgsError`) — argument parsing is fully extracted from the CLI entrypoint.
- **Public API barrel**: `src/index.ts` re-exports all public types and functions for library consumers.

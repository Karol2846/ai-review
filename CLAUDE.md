# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Goal                     | Command                                                                                 |
|--------------------------|-----------------------------------------------------------------------------------------|
| Build                    | `npm run build`                                                                         |
| Type-check only          | `npm run typecheck`                                                                     |
| Run all tests            | `npm run test`                                                                          |
| Single-scope test run    | `ai-review --agents "tester" --files "src/main/java/com/example/MyClass.java" --report` |
| Install globally         | `npm run build && npm install -g .`                                                     |
| Run with terminal report | `ai-review --report`                                                                    |
| Raw JSON output          | `ai-review --json`                                                                      |
| Remove inserted comments | `ai-review --clean`                                                                     |

Tests use **Vitest** and live under `test/` (not compiled into `dist/`).

## Architecture

`ai-review` is a TypeScript/Node multi-agent diff reviewer. The four pipeline phases:

1. **Scope** (`src/cli.ts`, `src/git.ts`) — resolves repo root, base branch (auto-detects `origin/HEAD`, falls back to `main`/`master`), merge-base, and changed files.
2. **Analyze** (`src/reviewPipeline.ts`, `src/router.ts`, `src/routingTypes.ts`, `src/runner.ts`, `src/batcher.ts`, `src/promptBuilder.ts`, `src/contextBuilder.ts`, `src/llmClient.ts`, `src/llmAdapter.ts`) — routes changed files to agents via glob patterns, builds `(file × agent)` task batches, sends diff + bounded file context to the LLM via Vercel AI SDK's `generateObject`, returns Zod-validated findings arrays.
3. **Aggregate** (`src/aggregator.ts`) — deduplicates via fingerprint, applies min-severity filter, sorts by severity/file/line.
4. **Output** (`src/reporter.ts`, `src/annotator.ts`) — `--report` renders colored terminal output; default mode inserts `// TODO [ai-review]` comments into source files; `--clean` removes them.

### LLM integration (Vercel AI SDK)

`src/llmClient.ts` — `createLanguageModel(config: LlmClientConfig): LanguageModel`. Supports four provider kinds:
- `openai-compatible` (`@ai-sdk/openai`) — works with OpenAI, Groq, OpenRouter, or any OpenAI-compatible endpoint; optional `baseURL`.
- `anthropic` (`@ai-sdk/anthropic`)
- `google` (`@ai-sdk/google`)
- `bedrock` (`@ai-sdk/amazon-bedrock`)

`src/llmAdapter.ts` — `generateFindings(model, prompt): Promise<Finding[]>`. Wraps Vercel AI SDK's `generateObject`, passing the Zod `findingsSchema` for structured output. Maps SDK errors (`APICallError`, `NoObjectGeneratedError`, `TypeValidationError`, `AbortError`) to `LlmProviderError` codes.

`src/llmProvider.ts` — error types only: `LlmProviderError` class and `LlmProviderErrorCode` union. No provider interface or `sendPrompt` method.

Provider is selected by an **interactive setup wizard** in `src/setupWizard.ts`, triggered on first CLI run when no config is found. Config is stored at `~/.ai-review/.ai-review-install-provider.json` (path defined by `INSTALL_PROVIDER_CONFIG_DIR` in `src/installProviderConfig.ts`). `scripts/postinstall.js` is non-interactive — it only copies `agents/` and `skill/` into `~/.copilot/`. At runtime `src/cli.ts` reads the config via `loadInstallProviderConfig`; if missing and stdin is a TTY, the wizard runs and exits asking the user to set the API key env var and re-run; if missing and non-TTY (CI, Docker, `--ignore-scripts`), the CLI errors out.

### Routing and configuration

Changed files are matched to agents by glob patterns via `src/router.ts` (`routeFilesToAgents`, uses `micromatch`). Types live in `src/routingTypes.ts` (`RoutingRuntimeConfig`, `AgentGlobsMap`, `AgentName`). Default agent-to-file-glob routing is in `src/defaultConfig.ts`. Users can override glob patterns per-agent in `.ai-reviewrc.json` at their repo root (only `agentGlobs` key is supported). Config is loaded by `src/config.ts` and merged over the defaults.

### Agent instructions

Agent prompts (`agents/*.agent.md`) are loaded from the first matching path among: `<repo>/agents/`, `<dist>/../agents/`, `~/.copilot/agents/`. YAML front matter is stripped before the instruction is sent. Five agents: `clean-coder`, `tester`, `architect`, `ddd-reviewer`, `performance`.

### Finding contract

Findings conform to the Zod schema in `src/findingSchema.ts`: `{ file, line, agent, severity, category, message, suggestion, fingerprint }` (optional: `endLine`). The exported `findingSchema` and `findingsSchema` are passed directly to `generateObject` — the LLM is forced to return structured output matching the schema. `schemas/finding.schema.json` exists for documentation/tooling. Non-conforming output surfaces as `NoObjectGeneratedError` (mapped to `COMMAND_FAILED`).

### Annotation lifecycle

Inserted comments must contain `[ai-review]`. Cleanup (`--clean`) removes every line containing this marker. Insertions are applied bottom-up by line number to avoid shifting target positions.

## Key conventions

- **Diff-first scope**: review always operates on `merge-base(origin/<base>, HEAD)..HEAD`, never the whole repo.
- **Structured output via Zod**: `generateObject` + `findingsSchema` enforces valid findings from the LLM; non-conforming output maps to `COMMAND_FAILED` and retries if transient.
- **`CliRuntimeDependencies` interface** (`src/cli.ts`): all I/O and side-effectful operations are injected through this interface, making `runCli` fully unit-testable without mocking globals.
- **Transient error retry**: `src/runner.ts` retries on `LlmProviderError` codes marked transient in `src/llmProvider.ts` (`COMMAND_FAILED`, `RATE_LIMITED`, `NETWORK_ERROR`, `TIMEOUT`, `SERVICE_UNAVAILABLE`).
- **CLI args module**: `src/cliArgs.ts` (`parseCliArgs`, `formatCliUsage`, `CliArgsError`) — argument parsing is fully extracted from the CLI entrypoint.
- **Public API barrel**: `src/index.ts` re-exports all public types and functions for library consumers.

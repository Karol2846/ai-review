# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Goal | Command |
|------|---------|
| Build | `npm run build` |
| Type-check only | `npm run typecheck` |
| Run all tests | `npm run test` |
| Single-scope test run | `ai-review --agents "tester" --files "src/main/java/com/example/MyClass.java" --report` |
| Install globally | `npm run build && npm install -g .` |
| Run with terminal report | `ai-review --report` |
| Raw JSON output | `ai-review --json` |
| Remove inserted comments | `ai-review --clean` |

Tests use **Vitest** and live under `test/` (not compiled into `dist/`).

## Architecture

`ai-review` is a TypeScript/Node multi-agent diff reviewer. The four pipeline phases:

1. **Scope** (`src/cli.ts`, `src/git.ts`) — resolves repo root, base branch (auto-detects `origin/HEAD`, falls back to `main`/`master`), merge-base, and changed files.
2. **Analyze** (`src/reviewPipeline.ts`, `src/runner.ts`, `src/batcher.ts`, `src/promptBuilder.ts`, `src/contextBuilder.ts`) — builds `(file × agent)` task batches, sends diff + bounded file context to the LLM provider, parses JSON findings.
3. **Aggregate** (`src/aggregator.ts`) — deduplicates via fingerprint, applies min-severity filter, sorts by severity/file/line.
4. **Output** (`src/reporter.ts`, `src/annotator.ts`) — `--report` renders colored terminal output; default mode inserts `// TODO [ai-review]` comments into source files; `--clean` removes them.

### Provider abstraction (`src/llmProvider.ts`)

The `LlmProvider` interface has a single method: `sendPrompt(prompt: string): Promise<string>`. Two implementations exist:

- **`CopilotProvider`** (`src/copilot.ts`) — shells out to the `copilot` CLI.
- **`OllamaProvider`** (`src/ollamaProvider.ts`) — calls Ollama Cloud at `https://ollama.com` with model `qwen3-coder:480b-cloud`. Requires `OLLAMA_API_KEY` in the environment. The URL and model are locked to cloud-only values; passing any other value throws.

Provider is selected **at install time** by `scripts/postinstall.js`, stored as `.ai-review-install-provider.json` next to the compiled binary. At runtime `src/installProviderConfig.ts` reads this file; if missing/invalid, falls back to `ollama`.

### Routing and configuration

- Default agent-to-file-glob routing is in `src/defaultConfig.ts`.
- Users can override glob patterns per-agent in `.ai-reviewrc.json` at their repo root (only `agentGlobs` key is supported). Config is loaded by `src/config.ts` and merged over the defaults.

### Agent instructions

Agent prompts (`agents/*.agent.md`) are loaded from the first matching path among: `<repo>/agents/`, `<dist>/../agents/`, `~/.copilot/agents/`. YAML front matter is stripped before the instruction is sent. Five agents: `clean-coder`, `tester`, `architect`, `ddd-reviewer`, `performance`.

### Finding contract

Findings are JSON objects: `{ file, line, agent, severity, category, message, suggestion, fingerprint }` (optional: `endLine`). The canonical schema is `schemas/finding.schema.json`. Agents must return a JSON array only; invalid output falls back to `[]`.

### Annotation lifecycle

Inserted comments must contain `[ai-review]`. Cleanup (`--clean`) removes every line containing this marker. Insertions are applied bottom-up by line number to avoid shifting target positions.

## Key conventions

- **Diff-first scope**: review always operates on `merge-base(origin/<base>, HEAD)..HEAD`, never the whole repo.
- **Graceful parser fallback**: non-JSON agent output silently produces `[]` rather than failing the run.
- **`CliRuntimeDependencies` interface** (`src/cli.ts`): all I/O and side-effectful operations are injected through this interface, making `runCli` fully unit-testable without mocking globals.
- **Transient error retry**: `src/runner.ts` retries on `LlmProviderError` codes marked transient in `src/llmProvider.ts` (`COMMAND_FAILED`, `RATE_LIMITED`, `NETWORK_ERROR`, `TIMEOUT`, `SERVICE_UNAVAILABLE`).

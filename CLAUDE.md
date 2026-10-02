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
| Exclude agents from review | `ai-review --exclude-agents "ddd-reviewer,performance"`                               |
| Install globally         | `npm run build && npm install -g .`                                                     |
| Run with terminal report | `ai-review --report`                                                                    |
| Raw JSON output          | `ai-review --json`                                                                      |
| Review only commits      | `ai-review --committed-only`                                                            |
| Remove inserted comments | `ai-review --clean`                                                                     |
| Scaffold `ai-review.json` | `ai-review init` (`--force` to overwrite)                                              |

Tests use **Vitest** and live under `test/` (not compiled into `dist/`).

## Architecture

`ai-review` is a TypeScript/Node multi-agent diff reviewer. The four pipeline phases:

1. **Scope** (`src/cli.ts`, `src/git.ts`) — resolves repo root, base branch (auto-detects `origin/HEAD`, falls back to `main`/`master`), merge-base, and changed files. The `ReviewScope` (`src/git.ts`) decides which changes count: `working-tree` (default) diffs the merge-base against the working tree and adds untracked non-ignored files; `committed` (`--committed-only`) diffs `merge-base..HEAD`. `src/contextBuilder.ts` reads file content from the same snapshot as the diff (working tree, or `git show HEAD:<path>` for `committed`) and synthesizes a whole-file addition diff for untracked files.
2. **Analyze** (`src/reviewPipeline.ts`, `src/router.ts`, `src/routingTypes.ts`, `src/runner.ts`, `src/batcher.ts`, `src/promptBuilder.ts`, `src/contextBuilder.ts`, `src/llmClient.ts`, `src/llmAdapter.ts`) — routes changed files to agents via glob patterns, packs each agent's files into batches of at most 14 000 chars (`src/batcher.ts`; oversized files are split into chunks), sends diff + bounded file context to the user's coding-agent CLI (Claude Code / Copilot CLI / Codex) run headless, parses JSON findings from the response via `src/responseParser.ts`.
3. **Aggregate** (`src/aggregator.ts`) — applies min-severity filter, deduplicates via fingerprint (SHA-256 of file, line range, category and message), sorts by severity/file/line.
4. **Output** (`src/reporter.ts`, `src/annotator.ts`) — `--report` renders colored terminal output; default mode inserts `// TODO [ai-review]` comments into source files; `--clean` removes them.

### LLM integration (coding-agent CLIs)

There are no API keys or HTTP clients: every prompt is delegated to a coding-agent CLI the user already has installed and logged in, spawned via `execa`.

`src/llmClient.ts` — `createLlmClient(config: LlmClientConfig, run?: CommandRunner): LlmClient`, where `LlmClient` is `{ provider, complete(prompt): Promise<string> }`. `PROVIDER_KINDS` = `claude-code | copilot | codex`; `PROVIDER_INFO` holds each one's label, command, install hint and login hint. The `CommandRunner` parameter (default `runCommand`, execa with a 5-minute timeout) is the test seam. Every call runs in a scratch cwd with **no tools**, and must never leave a session in the agent's history:
- `claude-code` — `claude -p --output-format json --no-session-persistence --strict-mcp-config --setting-sources user --disable-slash-commands --system-prompt … [--model m] --tools ""`, prompt on stdin; the reply is the `result` field of the JSON (`is_error: true` → error).
- `codex` — `codex exec --ephemeral --sandbox read-only --skip-git-repo-check --color never --output-last-message <tmpfile> [--model m] -`, prompt on stdin; the reply is read from the tmpfile.
- `copilot` — `copilot --prompt=… --silent --session-id=<uuid> … --available-tools` (no flag to skip persistence), then `<COPILOT_HOME or ~/.copilot>/session-state/<uuid>` and its lock file are deleted in a `finally`.

Failures map to `LlmProviderError` codes: `ENOENT` → `COMMAND_NOT_FOUND` (with install hint), timeout → `TIMEOUT`, and non-zero exit output is classified by regex into `NOT_AUTHENTICATED` (with login hint), `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `NETWORK_ERROR`, or `COMMAND_FAILED`.

`src/llmAdapter.ts` — `generateFindings(client, prompt): Promise<Finding[]>`. Calls `client.complete`, wraps non-`LlmProviderError` failures as `COMMAND_FAILED`, then parses the reply via `src/responseParser.ts`.

`src/llmProvider.ts` — error types only: `LlmProviderError` class and `LlmProviderErrorCode` union.

Provider is selected by an **interactive setup wizard** in `src/setupWizard.ts`, triggered on first CLI run when no valid config is found. It asks a single question — which agent CLI — marking those found in `PATH` (`<cmd> --version`) as installed. Config (`{ provider, model? }`) is stored at `~/.ai-review/.ai-review-install-provider.json` (path defined by `INSTALL_PROVIDER_CONFIG_DIR` in `src/installProviderConfig.ts`); `model` is optional and omitted means the CLI's default model. `scripts/postinstall.js` is non-interactive — it only copies `agents/` and `skill/` into `~/.copilot/`. At runtime `src/cli.ts` reads the config via `loadInstallProviderConfig` inside `resolveLlmClient`; if missing/invalid (including configs from the old API-key era) and stdin is a TTY, the wizard runs, saves config, and the review continues immediately; if non-TTY (CI, Docker), the CLI errors out.

### Routing and configuration

Changed files are matched to agents by glob patterns via `src/router.ts` (`routeFilesToAgents`). All glob matching (agent globs and `exclude`) goes through `matchesGlobs` in `src/globMatch.ts`: a path matches when it matches at least one positive pattern and none of the `!`-negated ones, regardless of order (plain `micromatch.isMatch` would OR them, so a negation would match almost everything). Matching uses `dot: true`, so `**`/`*` also match dotfiles and dot-directories such as `.github/`. A file can go to several agents; a file matching no selected agent is not reviewed. By design agents review code, not config/Dockerfiles/CI files, but such files are not silently dropped: `findUnroutedFiles` collects them into `RunReviewPipelineResult.unroutedFiles` and `src/cli.ts` lists them on stderr after the run (stdout and `--json` output are unaffected). Types live in `src/routingTypes.ts` (`RoutingRuntimeConfig`, `AgentGlobsMap`, `AgentName`, `AgentDefinition`, `AgentsMap`). Default agent-to-file-glob routing is in `src/defaultConfig.ts`. Per-repo overrides via `ai-review.json` in the repo root are parsed by `src/repoConfig.ts` (`parseRepoConfig` → `RepoConfigOverride { model, agents, exclude, excludeAgents }`). The file is read only from the repo root. Unknown keys (including the removed `routing` section) or agent names cause a hard-fail. `ai-review init` (`src/init.ts`, `runInit`) writes `INIT_TEMPLATE` as an example `ai-review.json` into the current directory, refuses to overwrite without `--force`, and warns on stderr when the current directory is not the repo root. A future phase may add a `severity` section.

- **`model`** (phase 2) — a per-repo model override: a plain **string** naming the model to use for this repo (`UserModelConfigOverride = string`), passed to the agent CLI's `--model`. Only the model name is overridable per repo; the provider always comes from the install config (re-run the setup wizard to change it). Applied by `mergeProviderConfig` (`src/installProviderConfig.ts`), which copies the install config and swaps in the model name (`{ ...base, model }`), then in `src/cli.ts` via `resolveLlmClient(writeStdout, modelOverride)`. A non-string or empty `model` hard-fails. Example:

  ```json
  { "model": "haiku" }
  ```

- **`agents`** (phase 3) — unified section for **both** overriding built-in agents and defining custom ones. Two modes distinguished by the agent name:

  - **Built-in override** (name is one of the 5 built-ins): allowed keys are `globs` (required) and `replace` (optional boolean, default `false`). `instructionsFile` is forbidden — built-in instructions always load from the `agents/` directory. `replace: false` (default) **appends** your globs to the defaults (dedup); `replace: true` **replaces** them entirely. Merging is done by `mergeRoutingConfig` (`src/repoConfig.ts`).

    ```json
    { "agents": { "tester": { "globs": ["**/*.spec.ts"] } } }
    { "agents": { "tester": { "globs": ["**/*.spec.ts"], "replace": true } } }
    ```

  - **Custom agent** (any other name, must match `^[a-z0-9][a-z0-9-]*$`): `globs` (required) and `instructionsFile` (required — repo-relative path to its `.agent.md`). `replace` is forbidden. Custom agents and `replace: true` overrides must include at least one non-negated glob (a negation-only list is allowed only when extending a built-in's defaults). The agent is folded into routing via `agentsToRoutingOverride` + `mergeRoutingConfig`; its instruction is loaded directly from `instructionsFile`, skipping the directory search. A selected custom agent whose instruction cannot be loaded is a **fail-fast** config error (exit 1).

    ```json
    { "agents": { "security": { "globs": ["**/*.java"], "instructionsFile": "agents/security.agent.md" } } }
    ```

- **`exclude`** (phase 4) — a flat array of glob patterns whose matching files are dropped **before routing**, so no agent (built-in or custom) reviews them. Parsed by `parseExcludeSection` (reuses `validateGlobsArray`, so an empty array hard-fails). Applied in `src/cli.ts` by `excludeChangedFiles` (uses `matchesGlobs`, so `!` re-includes files). The CLI flag `--exclude <list>` (comma-separated globs, parsed by `parseCsvList`) adds to this: the effective exclusion set is the **union** of `ai-review.json`'s `exclude` and `--exclude`, deduplicated. Example:

  ```json
  { "exclude": ["**/*.generated.ts", "vendor/**"] }
  ```

- **`excludeAgents`** (phase 5) — a flat array of agent names (built-in or custom) to permanently disable for this repo. Parsed by `parseExcludeAgentsSection` in `src/repoConfig.ts`; reuses `validateGlobsArray` for the non-empty-array-of-non-empty-strings constraint, then validates each name against the **known set** (built-ins ∪ names from `agents`). Unknown names hard-fail with `RepoConfigError`. Duplicate entries are deduplicated. Applied in `src/cli.ts`: the effective excluded-agents set is the **union** of `ai-review.json`'s `excludeAgents` and the `--exclude-agents` CLI flag (comma-separated, parsed by `parseCsvList`); agents in this set are filtered out of the default run. Three conflict/error rules: **(1)** `--agents` and `--exclude-agents` are mutually exclusive (CLI error). **(2)** If `--agents` explicitly names an agent that `ai-review.json`'s `excludeAgents` excludes, the CLI exits 1 with a clear message. **(3)** `--exclude-agents` names are validated against the known agent list — an unknown name is a **hard error** (exit 1). Example:

  ```json
  { "excludeAgents": ["ddd-reviewer", "performance"] }
  ```

When `--agents` is **not** passed, the run includes **every configured agent** (built-in + custom) **minus those in the effective `excludeAgents` set**; `--agents <list>` narrows the selection (whitelist, subject to conflict rule 2 if config also excludes the agent).

**CLI agent-selection errors** (all exit 1): unknown agent name in `--agents`, unknown agent name in `--exclude-agents`, no agents remaining after filtering (e.g. all excluded).

### Agent instructions

Agent prompts (`agents/*.agent.md`) are loaded by `loadAgentInstructionsFromDisk` (`src/cli.ts`) from the first matching path among: `<repo>/agents/`, `<dist>/../agents/` (the package's bundled copy), `~/.copilot/agents/` — so a repo-local file overrides the bundled one, while `~/.copilot/agents/` is only reached when the bundled file is missing. YAML front matter is stripped before the instruction is sent. Five built-in agents: `clean-coder`, `tester`, `architect`, `ddd-reviewer`, `performance`. Repos can add custom agents via the `agents` section of `ai-review.json` (see Routing and configuration), whose instructions load from an explicit `instructionsFile` path rather than the directory search.

### Finding contract

Findings conform to the `Finding` interface in `src/findingSchema.ts`: `{ file, line, agent, severity, category, message, suggestion }` (optional: `endLine`, `fingerprint`). The LLM is prompted to return a JSON array without `fingerprint`; `src/aggregator.ts` (`buildFindingFingerprint`) sets it on every `AggregatedFinding`; `src/responseParser.ts` extracts and validates the array, dropping non-conforming records. `schemas/finding.schema.json` exists for documentation reference only — nothing in the runtime loads or validates against it.

### Annotation lifecycle

Inserted comments have the form `<comment-prefix> TODO <agent> <severity>: <message> → <suggestion> [ai-review]` (prefix `//`, `#`, `--` or `<!-- … -->` chosen by file extension in `src/annotator.ts`; findings in other file types are not annotated). Cleanup (`--clean`) walks the whole repo (skipping `.git/` and `node_modules/`) and removes only lines that match this generated format for the file's comment style — a hand-written line that merely mentions `[ai-review]` is kept. Insertions are applied bottom-up by line number to avoid shifting target positions.

## Key conventions

- **Diff-first scope**: review always operates on changes since `merge-base(origin/<base>, HEAD)` — working tree by default, `..HEAD` with `--committed-only` — never the whole repo.
- **Structured output via prompt + parser**: the prompt carries a JSON-format instruction; `src/responseParser.ts` extracts and validates the agent CLI's reply. Non-conforming records are dropped silently. Transient LLM errors are retried by `src/runner.ts`.
- **`CliRuntimeDependencies` interface** (`src/cli.ts`): all I/O and side-effectful operations are injected through this interface, making `runCli` fully unit-testable without mocking globals.
- **Transient error retry**: `src/runner.ts` retries once (500 ms delay, `DEFAULT_RETRY` in `src/cli.ts`) on `LlmProviderError` codes marked transient in `src/llmProvider.ts` (`COMMAND_FAILED`, `RATE_LIMITED`, `NETWORK_ERROR`, `TIMEOUT`, `SERVICE_UNAVAILABLE`).
- **CLI args module**: `src/cliArgs.ts` (`parseCliArgs`, `formatCliUsage`, `CliArgsError`) — argument parsing is fully extracted from the CLI entrypoint.
- **Public API barrel**: `src/index.ts` re-exports all public types and functions for library consumers.

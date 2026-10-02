# ai-review 🔍

Multi-agent code review powered by the coding agent you already use — **Claude Code**, **GitHub Copilot CLI**, or **OpenAI Codex CLI**.  
Run **before creating a PR** (or when reviewing someone else's branch) to get focused AI critique from 5 specialized agents — each looking at your diff through a different lens.  
No API keys, no endpoints: ai-review runs the agent CLI in headless mode and reuses the login you already have there.

---

## Prerequisites

| Tool        | Required | Notes                                                                    |
|-------------|----------|--------------------------------------------------------------------------|
| `git`       | Yes      | Diff computation                                                         |
| `node`      | Yes      | Runtime for the CLI (v20.12+)                                            |
| `npm`       | Yes      | Package manager                                                          |
| Agent CLI   | Yes      | One of `claude`, `copilot`, `codex` — installed and logged in            |

---

## Install

```bash
npm install -g @karol2846/ai-review
```

The `npm install -g` step is non-interactive — it only copies bundled agents/skills into `~/.copilot/`. On the **first invocation of `ai-review`** in an interactive terminal, a one-question setup asks which agent CLI to use (the ones found in your `PATH` are marked as installed), saves the choice to `~/.ai-review/.ai-review-install-provider.json`, and goes straight on with the review.

| Provider      | CLI       | How it is called                                                                          |
|---------------|-----------|-------------------------------------------------------------------------------------------|
| `claude-code` | `claude`  | `claude -p --no-session-persistence --tools ""` (prompt on stdin)                         |
| `copilot`     | `copilot` | `copilot --prompt=… --silent --available-tools` — the session it creates is deleted afterwards |
| `codex`       | `codex`   | `codex exec --ephemeral --sandbox read-only` (prompt on stdin)                            |

Reviews never show up in the agent's own session history: Claude Code and Codex are run with their "don't persist this session" flags, and for Copilot CLI (which has no such flag) ai-review deletes the session it created right after each call. Every call runs in a scratch directory with no tools, so the agent cannot touch your repository.

The model is whatever the agent CLI uses by default. To pick one, add `"model"` to the config file (e.g. `{ "provider": "claude-code", "model": "haiku" }`) or to a repo's `ai-review.json`.

If `ai-review` is invoked without a TTY (CI, Docker) before the config exists, it errors with a message asking you to run it in an interactive terminal first.

To switch provider later, delete the config file and re-run `ai-review`:
```bash
rm ~/.ai-review/.ai-review-install-provider.json
ai-review
```

---

## Development

```bash
npm install
npm run typecheck
npm run build
npm run test
```

`npm run test` runs the Vitest suite from `test/` (kept outside production build output).

- Source entrypoint: `src/cli.ts` (CLI) and `src/index.ts` (library consumers)
- Package CLI entrypoint: `dist/cli.js` (`package.json#bin.ai-review`)
- Provider is selected via the first-run setup wizard (`src/setupWizard.ts`) — no CLI provider flags.

---

## Quick Start

```bash
cd /path/to/your/repo

ai-review                          # insert TODO comments into files (default)
ai-review --report                 # + print terminal report
ai-review --clean                  # remove TODO comments
ai-review init                     # scaffold an example ai-review.json (see Per-repo config)
```

---

## How It Works

```
ai-review
  │
  ├─ 1. SCOPE
  │      git diff $(git merge-base HEAD origin/<base>)   (commits + uncommitted)
  │      + untracked files (git ls-files --others --exclude-standard)
  │      → list of changed files   (--committed-only: ..HEAD, commits only)
  │      minus files matching `exclude` / --exclude
  │
  ├─ 2. ANALYZE  (parallel, up to --parallel agent CLI calls at once)
  │      Files routed to agents by glob; each agent's files packed into batches
  │      Each batch carries: diff + bounded file context
  │      Agent CLI (claude / copilot / codex) runs headless → JSON response
  │      Response parsed and validated per-record; invalid records dropped
  │
  ├─ 3. AGGREGATE
  │      Merge all findings, filter by min severity,
  │      deduplicate by fingerprint, sort: critical → warning → info
  │
  ├─ 4a. ANNOTATE (default)
  │       Insert TODO comments above flagged lines (bottom-up to preserve line numbers)
  │
  └─ 4b. REPORT (--report, optional)
          Colored terminal output grouped by file
```

---

## Agents

| Agent            | Focus                                                                                                        |
|------------------|--------------------------------------------------------------------------------------------------------------|
| **architect**    | Missing exception handlers, HTTP status codes, layer violations, coupling, SQS idempotency, hardcoded config |
| **clean-coder**  | SOLID, naming, method length, code smells, readability                                                       |
| **ddd-reviewer** | Anemic domain, aggregate boundaries, Value Objects, Domain Events, ubiquitous language                       |
| **performance**  | N+1 queries, blocking async, missing pagination, resource leaks, lazy loading                                |
| **tester**       | Missing tests, uncovered edge cases, Spock patterns, test isolation                                          |

All agents are critical and pragmatic — they name exact classes and methods, and return `[]` only when code is genuinely clean.

---

## Output

### Terminal report (`--report`, optional)
```
━━━ src/main/java/com/example/CreatorFacade.java ━━━

  ● critical [architect/missing-exception-handler] L1
    No @ControllerAdvice found. Uncaught exceptions will expose stack traces.
    → Add a @RestControllerAdvice class with @ExceptionHandler methods.

  ● warning [ddd-reviewer/anemic-domain] L34
    CreatorFacade.create() contains business logic that belongs in the aggregate.
    → Move validation into ReferenceCode.create() factory method.

─────────────────────────────────────────
3 findings across 2 files from 3 agents  (critical: 1  warning: 2)
```

### TODO annotation (default)
Each finding becomes a comment inserted directly above the flagged line, with the line's indentation:
```java
// TODO architect critical: No @ControllerAdvice found. Uncaught exceptions will expose stack traces. → Add a @RestControllerAdvice class with @ExceptionHandler methods. [ai-review]
public class CreatorController {}
```

Comment syntax per file type:
| Extension | Comment prefix |
|-----------|---------------|
| `.java`, `.groovy`, `.kt`, `.scala`, `.ts`, `.tsx`, `.js`, `.jsx`, `.go`, `.rs`, `.c`, `.cpp`, `.h` | `//` |
| `.yml`, `.yaml`, `.properties`, `.py`, `.rb`, `.sh`, `.bash`, `.toml`, `.cfg`, `.ini`, `.tf` | `#` |
| `.sql` | `--` |
| `.xml`, `.html`, `.htm` | `<!-- -->` |
| other | skipped (the finding still shows up in `--report` / `--json`) |

`--clean` scans the repository (skipping `.git/` and `node_modules/`) and removes only lines that match this generated format, so your own comments that merely mention `[ai-review]` are left alone.

---

## Options

```
Usage: ai-review [OPTIONS]
       ai-review init [--force]

init                    Scaffold an example ai-review.json in the current directory
-h, --help              Show usage
--base <branch>         Base branch for diff (default: auto-detect origin/HEAD, then main, master)
--committed-only        Review only commits (default: also uncommitted and untracked changes)
--agents <list>         Comma-separated agent list (default: all)
--exclude-agents <list> Comma-separated agents to skip (default: none)
--severity <min>        Minimum severity: critical, warning, info (default: info)
--exclude <list>        Comma-separated glob patterns to exclude from review
--report                Also print a terminal report (files are still annotated)
--clean                 Remove previous [ai-review] TODO comments
--json                  Print findings as a JSON array on stdout (no annotations)
--explain-routing       Show which agents would review each changed file and why, then exit
--parallel <n>          Max parallel agent invocations (default: 5)
--debug                 Print diagnostics (base branch, merge-base, scope, warnings) to stderr
--force                 Overwrite an existing ai-review.json (with init)
```

`--base` is always resolved against the remote: `--base develop` diffs against `origin/develop`.

---

## Common Workflows

### Before pushing
```bash
ai-review                          # add TODO comments in changed files
ai-review --severity warning       # skip info-level noise
ai-review --report                 # optionally also show terminal report
ai-review --clean                  # remove markers before push
```

By default the review covers everything since the merge-base: commits, staged and unstaged edits,
and new untracked files — so you can review before committing. Pass `--committed-only` to review
just the commits (`merge-base..HEAD`).

### Reviewing someone else's PR
```bash
git fetch origin
git checkout pr-branch
ai-review --base main
```

### Focus on a specific lens
```bash
ai-review --agents "architect"                           # only architecture issues
ai-review --exclude "**/*.generated.ts,vendor/**"        # skip generated/vendored files
ai-review --exclude-agents "ddd-reviewer,performance"    # run all except these agents
```

### Debug when something seems wrong
```bash
ai-review --debug --agents "architect"
# Prints the resolved base branch, merge-base, review scope, changed-file count,
# loaded ai-review.json overrides and pipeline warnings (failed batches,
# skipped files, missing agent instructions) on stderr
```

### Check which agent reviews which file
```bash
ai-review --explain-routing
# For each changed file: the agents that would review it and the glob that matched,
# agents whose `!` glob removed it, or why nobody reviews it (no matching glob,
# `exclude`, binary/lock file). Reads no file contents and calls no agent CLI —
# handy while tuning ai-review.json. Combine with --agents / --exclude / --json.
```

### CI / scripting
```bash
# Fail build if any critical issues found
ai-review --json --severity critical | jq -e 'length == 0'
```


---

## JSON Schema

`--json` prints an array of findings. Each finding:
```json
{
  "file": "src/main/java/com/example/CreatorFacade.java",
  "line": 42,
  "endLine": 48,
  "agent": "architect",
  "severity": "critical | warning | info",
  "category": "missing-exception-handler",
  "message": "No @ControllerAdvice found. Uncaught exceptions expose stack traces.",
  "suggestion": "Add a @RestControllerAdvice class.",
  "fingerprint": "3f9c1e…"
}
```

`endLine` is optional. `fingerprint` is a SHA-256 hex digest of the file, line range, category and message, used to deduplicate findings.

---

## File Structure

```
ai-review/
├── agents/
│   ├── architect.agent.md
│   ├── clean-coder.agent.md
│   ├── ddd-reviewer.agent.md
│   ├── performance.agent.md
│   └── tester.agent.md
├── src/
│   ├── index.ts               # Public API barrel — re-exports all modules
│   ├── cli.ts                 # CLI runtime entrypoint + orchestration
│   ├── cliArgs.ts             # CLI argument parsing (parseCliArgs, CliArgsError)
│   ├── reviewPipeline.ts      # Analyze + aggregate pipeline orchestration
│   ├── router.ts              # File-to-agent routing via globs
│   ├── globMatch.ts           # matchesGlobs — micromatch with `!` negations and dotfiles
│   ├── routingTypes.ts        # Types: RoutingRuntimeConfig, AgentGlobsMap, etc.
│   ├── runner.ts              # Parallel batch execution with retry
│   ├── batcher.ts             # Build (file × agent) task batches
│   ├── promptBuilder.ts       # Assemble per-batch prompts
│   ├── contextBuilder.ts      # Load file content + git diffs
│   ├── aggregator.ts          # Deduplicate, filter, sort findings
│   ├── reporter.ts            # Colored terminal report rendering
│   ├── annotator.ts           # Insert / remove TODO comments
│   ├── git.ts                 # git merge-base and changed-files helpers
│   ├── defaultConfig.ts       # Default agent-to-glob routing config
│   ├── repoConfig.ts          # Load + validate + merge per-repo ai-review.json
│   ├── init.ts                # `ai-review init` — scaffolds an example ai-review.json
│   ├── llmProvider.ts         # LlmProviderError class + error code types
│   ├── llmClient.ts           # createLlmClient — runs claude / copilot / codex headless
│   ├── llmAdapter.ts          # generateFindings — LlmClient.complete + response parsing
│   ├── responseParser.ts      # parseModelResponse — extracts JSON findings from LLM text
│   ├── installProviderConfig.ts  # Read/validate ~/.ai-review/.ai-review-install-provider.json
│   ├── setupWizard.ts         # First-run interactive provider setup
│   └── findingSchema.ts       # Finding TypeScript interface
├── test/                  # Vitest suite (not compiled into dist/)
├── dist/                  # compiled JS + d.ts (npm/CLI runtime)
├── schemas/
│   └── finding.schema.json  # documentation only — not used at runtime
├── skill/
│   └── SKILL.md           # Copilot skill, copied to ~/.copilot/skills/ai-review on install
├── scripts/
│   └── postinstall.js     # Non-interactive: copies agents/skills to ~/.copilot/
├── package.json
└── README.md
```

---

## Stack

**LLM**: the agent CLI you already use (Claude Code, GitHub Copilot CLI or OpenAI Codex CLI), spawned in headless mode via `execa`. Each call sends a structured JSON prompt; findings are extracted and validated by a hand-rolled response parser.

Agents are tuned for: **Java 17+, Spring Boot, Spock/Groovy tests, PostgreSQL, MongoDB, SQS/SNS, DDD, REST APIs**.

Agent instructions are loaded from the first of these that has `<agent>.agent.md`:

1. `agents/` in the root of the repository being reviewed
2. `agents/` bundled with the installed package
3. `~/.copilot/agents/`

To customize a built-in agent for one repo, put your version at `agents/<agent>.agent.md` in that repo's root — it takes precedence over the bundled one. Since the package always ships its own `agents/`, editing `~/.copilot/agents/` has no effect on ai-review (that copy is for Copilot CLI's own use). To add a new reviewer, define a custom agent in `ai-review.json` (below).

---

## Per-repo config (`ai-review.json`)

Create `ai-review.json` in your repository root (it is only read from there) to adapt ai-review to the repo. `ai-review init` writes an example to the current directory (`--force` overwrites an existing one). Allowed top-level keys: `model`, `agents`, `exclude`, `excludeAgents`.

```json
{
  "model": "claude-haiku-4-5",
  "agents": {
    "ddd-reviewer": { "globs": ["**/internal/core/**/*.java"] },
    "clean-coder":  { "globs": ["legacy/**/*.ts"], "replace": true },
    "security":     { "globs": ["**/*.java"], "instructionsFile": "agents/security.agent.md" }
  },
  "exclude": ["**/*.generated.ts", "vendor/**"],
  "excludeAgents": ["performance"]
}
```

### Model

`model` is a non-empty string passed to the agent CLI's `--model` for reviews of this repo. Only the model can be overridden per repo — the agent CLI itself always comes from the setup config.

### Agents

The `agents` object both tunes the built-in agents and adds new ones:

- **Built-in agent** (`clean-coder`, `tester`, `architect`, `ddd-reviewer`, `performance`): `globs` (required) are **appended** to the default globs (with dedup); set `"replace": true` to use only your globs instead. `instructionsFile` is not allowed.
- **Custom agent** (any other name matching `^[a-z0-9][a-z0-9-]*$`): `globs` and `instructionsFile` (a repo-relative path to its `.agent.md`) are both required; `replace` is not allowed. If a selected custom agent's instructions file cannot be read, the run fails with exit code 1.

Every agent — built-in and custom — runs by default; use `--agents` / `--exclude-agents` / `excludeAgents` to narrow the selection.

### Files no agent reviews

Changed files that match **no** selected agent's globs (config files, `Dockerfile`, CI workflows, …) are not reviewed — agents focus on code. They are listed on stderr after the run so you can see what was skipped (and extend the globs if a file should be reviewed):

```
Not reviewed (no agent's globs match) — 2 files:
  Dockerfile
  package.json
```

Binary and lock files (images, fonts, `.jar`, `.class`, `.lock`) and files deleted on the branch are skipped before routing and are not listed (`--debug` shows them as warnings).

### Excluding files

Add an `exclude` array of glob patterns to drop matching files **before routing** — no agent reviews them. Useful for generated, vendored, or snapshot files:

```json
{
  "exclude": ["**/*.generated.ts", "vendor/**"]
}
```

The `--exclude` CLI flag (comma-separated globs) adds to this list: the effective set is the **union** of `ai-review.json` and `--exclude`, deduplicated.

### Glob patterns

Agent `globs` and `exclude` use [micromatch](https://github.com/micromatch/micromatch) syntax, matched against repo-relative paths; `*` and `**` also match dotfiles and dot-directories, so `**/*.yml` covers `.github/workflows/ci.yml`. A pattern prefixed with `!` **removes** files the other patterns in the list would match — negations win regardless of their position:

```json
{
  "agents": { "tester": { "globs": ["!**/fixtures/**"] } },
  "exclude": ["vendor/**", "!vendor/patched/**"]
}
```

Here the `tester` defaults still apply but skip `fixtures/`, and `vendor/` is excluded except for `vendor/patched/`. A custom agent, or a built-in one with `"replace": true`, must list at least one pattern without `!`.

### Excluding agents

Add an `excludeAgents` array to permanently disable specific agents for this repo. Useful when a repo doesn't follow DDD, has no tests yet, etc.:

```json
{
  "excludeAgents": ["ddd-reviewer", "performance"]
}
```

The `--exclude-agents <list>` CLI flag (comma-separated agent names) adds to this: the effective set is the **union** of `ai-review.json`'s `excludeAgents` and `--exclude-agents`, deduplicated.

> **Notes on agent selection (all exit 1):**
> - `--agents` and `--exclude-agents` cannot be used together.
> - An unknown agent name in `--agents` or `--exclude-agents` is an error — a list of available agents is printed.
> - If `--agents` explicitly names an agent that is excluded in `ai-review.json`, the CLI errors out with a clear message.
> - If no agents remain after filtering (e.g. all excluded), the CLI exits 1 with `Error: No agents selected.`

Unknown keys or agent names cause a hard-fail with a clear error message — including the old `routing.agentGlobs` section, whose entries now go under `agents`. If the file is absent, defaults apply unchanged.

---

## Uninstall

```bash
npm uninstall -g @karol2846/ai-review
rm -rf ~/.copilot/skills/ai-review
rm ~/.copilot/agents/{clean-coder,tester,architect,ddd-reviewer,performance}.agent.md
```

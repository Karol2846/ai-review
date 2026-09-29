# ai-review 🔍

Multi-agent code review powered by the coding agent you already use — **Claude Code** or **OpenAI Codex CLI**.  
Run **before creating a PR** (or when reviewing someone else's branch) to get focused AI critique from 5 specialized agents — each looking at your diff through a different lens.  
No API keys, no endpoints: ai-review runs the agent CLI in headless mode and reuses the login you already have there.

---

## Prerequisites

| Tool        | Required | Notes                                                                    |
|-------------|----------|--------------------------------------------------------------------------|
| `git`       | Yes      | Diff computation                                                         |
| `node`      | Yes      | Runtime for the CLI (v20.12+)                                            |
| `npm`       | Yes      | Package manager                                                          |
| Agent CLI   | Yes      | `claude` or `codex` — installed and logged in                            |

---

## Install

```bash
npm install -g @karol2846/ai-review
```

The `npm install -g` step is non-interactive — it only copies bundled agents/skills into `~/.copilot/`. On the **first invocation of `ai-review`** in an interactive terminal, a one-question setup asks which agent CLI to use (the ones found in your `PATH` are marked as installed), saves the choice to `~/.ai-review/.ai-review-install-provider.json`, and goes straight on with the review.

| Provider      | CLI       | How it is called                                                                          |
|---------------|-----------|-------------------------------------------------------------------------------------------|
| `claude-code` | `claude`  | `claude -p --no-session-persistence --tools ""` (prompt on stdin)                         |
| `codex`       | `codex`   | `codex exec --ephemeral --sandbox read-only` (prompt on stdin)                            |

Reviews never show up in the agent's own session history: Claude Code and Codex are run with their "don't persist this session" flags. Every call runs in a scratch directory with no tools, so the agent cannot touch your repository.

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
```

---

## How It Works

```
ai-review
  │
  ├─ 1. SCOPE
   │      git diff $(merge-base HEAD origin/main)..HEAD
   │      → list of changed files
   │
  ├─ 2. ANALYZE  (parallel batched calls per file × agent)
   │      Each agent receives: diff + bounded file context
   │      Agent CLI (claude / codex) runs headless → JSON response
   │      Response parsed and validated per-record; invalid records dropped
   │
  ├─ 3. AGGREGATE
   │      Merge all JSONs, deduplicate by fingerprint,
   │      filter by min severity, sort: critical → warning → info
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
```java
public class CreatorController {}
```

Comment syntax per file type:
| Extension | Comment prefix |
|-----------|---------------|
| `.java`, `.groovy`, `.kt`, `.ts`, `.js`, `.go` | `//` |
| `.yml`, `.yaml`, `.properties`, `.py`, `.sh`, `.tf` | `#` |
| `.sql` | `--` |
| `.xml`, `.html` | `<!-- -->` |
| other | skipped |

---

## Options

```
-h, --help              Show usage
--base <branch>         Base branch for diff (default: auto-detect)
--agents <list>         Comma-separated agent list (default: all)
--exclude-agents <list> Comma-separated agents to skip (default: none)
--severity <min>        Minimum severity: critical, warning, info (default: info)
--exclude <list>        Comma-separated glob patterns to exclude from review
--report                Print terminal report (annotations are default)
--clean                 Remove previous [ai-review] TODO comments
--json                  Output raw JSON findings
--parallel <n>          Max parallel agent invocations (default: 5)
--debug                 Show raw agent output and timings for debugging
```

---

## Common Workflows

### Before pushing
```bash
ai-review                          # add TODO comments in changed files
ai-review --severity warning       # skip info-level noise
ai-review --report                 # optionally also show terminal report
ai-review --clean                  # remove markers before push
```

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
# Shows parser/pipeline warnings and annotation stats on stderr
```

### CI / scripting
```bash
# Fail build if any critical issues found
ai-review --json --severity critical | jq -e 'length == 0'
```


---

## JSON Schema

Each finding:
```json
{
  "file": "src/main/java/com/example/CreatorFacade.java",
  "line": 42,
  "agent": "architect",
  "severity": "critical | warning | info",
  "category": "missing-exception-handler",
  "message": "No @ControllerAdvice found. Uncaught exceptions expose stack traces.",
  "suggestion": "Add a @RestControllerAdvice class.",
  "fingerprint": "src/...java:42:missing-exception-handler:No @ControllerAdvice"
}
```

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
│   ├── router.ts              # File-to-agent routing via micromatch globs
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
│   ├── llmProvider.ts         # LlmProviderError class + error code types
│   ├── llmClient.ts           # createLlmClient — runs claude / codex headless
│   ├── llmAdapter.ts          # generateFindings — LlmClient.complete + response parsing
│   ├── responseParser.ts      # parseModelResponse — extracts JSON findings from LLM text
│   ├── installProviderConfig.ts  # Read/validate ~/.ai-review/.ai-review-install-provider.json
│   ├── setupWizard.ts        # First-run interactive provider setup
│   └── findingSchema.ts       # Finding TypeScript interface
├── dist/                  # compiled JS + d.ts (npm/CLI runtime)
├── schemas/
│   └── finding.schema.json
├── scripts/
│   └── postinstall.js     # Non-interactive: copies agents/skills to ~/.copilot/
├── package.json
└── README.md
```

---

## Stack

**LLM**: the agent CLI you already use (Claude Code or OpenAI Codex CLI), spawned in headless mode via `execa`. Each call sends a structured JSON prompt; findings are extracted and validated by a hand-rolled response parser.

Agents are tuned for: **Java 17+, Spring Boot, Spock/Groovy tests, PostgreSQL, MongoDB, SQS/SNS, DDD, REST APIs**.

To customize an agent's instructions, edit the corresponding file in `agents/` in the project directory or `~/.copilot/agents/` (copied there during install).

---

## Per-repo config (`ai-review.json`)

Create `ai-review.json` in your project root to extend the default routing for your repo's structure. Currently supports `routing.agentGlobs` — your globs are **appended** to the defaults for each agent (extend semantics, with dedup). Agents not listed are unchanged.

```json
{
  "routing": {
    "agentGlobs": {
      "ddd-reviewer": ["**/internal/core/**/*.java"],
      "performance":  ["**/infra/cache/**/*.java"]
    }
  }
}
```

**Allowed agent names:** `clean-coder`, `tester`, `architect`, `ddd-reviewer`, `performance`

### Excluding files

Add an `exclude` array of glob patterns to drop matching files **before routing** — no agent reviews them. Useful for generated, vendored, or snapshot files:

```json
{
  "exclude": ["**/*.generated.ts", "vendor/**"]
}
```

The `--exclude` CLI flag (comma-separated globs) adds to this list: the effective set is the **union** of `ai-review.json` and `--exclude`, deduplicated.

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

Unknown keys or agent names cause a hard-fail with a clear error message. If the file is absent, defaults apply unchanged.

---

## Uninstall

```bash
npm uninstall -g ai-review
rm -rf ~/.copilot/skills/ai-review
rm ~/.copilot/agents/{clean-coder,tester,architect,ddd-reviewer,performance}.agent.md
```

# ai-review 🔍

Multi-agent code review powered by the **Vercel AI SDK**.  
Run **before creating a PR** (or when reviewing someone else's branch) to get focused AI critique from 5 specialized agents — each looking at your diff through a different lens.  
Supports OpenAI-compatible endpoints (OpenAI, Groq, OpenRouter, etc.), Anthropic, and Google.

---

## Prerequisites

| Tool        | Required | Notes                                                                    |
|-------------|----------|--------------------------------------------------------------------------|
| `git`       | Yes      | Diff computation                                                         |
| `node`      | Yes      | Runtime for the CLI (v20.12+)                                            |
| `npm`       | Yes      | Package manager                                                          |
| LLM API key | Yes      | Env var name configured during install (e.g. `OPENAI_API_KEY`)          |

---

## Install

```bash
npm install -g ai-review
```

The `npm install -g` step is non-interactive — it only copies bundled agents/skills into `~/.copilot/`. The provider setup wizard runs on the **first invocation of `ai-review`** in an interactive terminal and prompts for:
1. **Provider kind**: `openai-compatible`, `anthropic`, or `google`
2. **Model name**: e.g. `gpt-4o-mini` (OpenAI), `llama-3.3-70b-versatile` (Groq), `claude-sonnet-4-6` (Anthropic), `gemini-2.0-flash` (Google)
3. **API key env var name**: the environment variable that holds your API key (e.g. `OPENAI_API_KEY`)
4. **Base URL** (openai-compatible only, optional): for Groq, OpenRouter, or self-hosted endpoints

The wizard writes `~/.ai-review/.ai-review-install-provider.json`. After the wizard saves the config, set the chosen API key env var in your shell and re-run `ai-review`. If `ai-review` is invoked without a TTY (CI, Docker, `npm install --ignore-scripts`) before the config exists, it errors with a message asking you to run it in an interactive terminal first.

Before running, export the API key you configured:
```bash
export OPENAI_API_KEY=sk-...   # or whatever variable name you chose
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
   │      Vercel AI SDK generateText sends prompt → JSON response
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
-h, --help         Show usage
--base <branch>    Base branch for diff (default: auto-detect)
--agents <list>    Comma-separated agent list (default: all)
--severity <min>   Minimum severity: critical, warning, info (default: info)
--files <glob>     Filter changed files by glob pattern
--report           Print terminal report (annotations are default)
--clean            Remove previous [ai-review] TODO comments
--json             Output raw JSON findings
--parallel <n>     Max parallel agent invocations (default: 5)
--debug            Show raw agent output and timings for debugging
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
ai-review --agents "architect"              # only architecture issues
ai-review --agents "tester" --files "*.java"
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
│   ├── llmProvider.ts         # LlmProviderError class + error code types
│   ├── llmClient.ts           # createLanguageModel — Vercel AI SDK factory
│   ├── llmAdapter.ts          # generateFindings — wraps generateText + response parsing
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

**LLM**: [Vercel AI SDK](https://sdk.vercel.ai/) (`ai` package) with provider adapters `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`. Uses `generateText` with a structured JSON prompt; findings are extracted and validated by a hand-rolled response parser.

Agents are tuned for: **Java 17+, Spring Boot, Spock/Groovy tests, PostgreSQL, MongoDB, SQS/SNS, DDD, REST APIs**.

To customize an agent, edit the corresponding file in `agents/` in the project directory or `~/.copilot/agents/` (copied there during install).

---

## Uninstall

```bash
npm uninstall -g ai-review
rm -rf ~/.copilot/skills/ai-review
rm ~/.copilot/agents/{clean-coder,tester,architect,ddd-reviewer,performance}.agent.md
```

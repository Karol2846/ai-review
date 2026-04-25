# ai-review 🔍

Multi-agent local code review powered by GitHub Copilot CLI.  
Run **before creating a PR** (or when reviewing someone else's branch) to get focused AI critique from 5 specialized agents — each looking at your diff through a different lens.

---

## Prerequisites

| Tool                           | Required | Notes                                         |
|--------------------------------|----------|-----------------------------------------------|
| `copilot` (GitHub Copilot CLI) | ✅        | Must be logged in (`/login`)                 |
| `git`                          | ✅        | Diff computation                             |
| `node`                         | ✅        | Runtime for the CLI                          |
| `npm`                          | ✅        | Build/install workflow                       |

---

## Install

```bash
cd ~/ai-review
bash install.sh
```

`install.sh` installs npm dependencies, builds the TypeScript CLI, then creates symlinks:

Creates symlinks:
- `~/.local/bin/ai-review` → `dist/cli.js` CLI entry point
- `~/.copilot/agents/*.agent.md` → agent personas
- `~/.copilot/skills/ai-review/` → Copilot skill

> Make sure `~/.local/bin` is in your `$PATH`.

---

## Runtime (Phase 6 complete)

The runtime now uses the TypeScript/Node CLI:
- source entrypoint: `src/cli.ts`
- package CLI entrypoint: `dist/cli.js` (`package.json#bin.ai-review`)
- orchestration/reporting/annotation logic lives in `src/` modules

```bash
npm install
npm run typecheck
npm run build
npm run test
```

`npm run test` runs the Vitest suite from `test/` (kept outside production build output).

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
   │      Returns: JSON array of findings
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
3 findings across 2 files from 3 agents
```

### TODO annotation (default)
```java
// TODO architect critical: No @ControllerAdvice found. → Add @RestControllerAdvice. [ai-review]
public class CreatorController {
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
--base <branch>    Base branch for diff (default: auto-detect main/master)
--agents <list>    Comma-separated agents (default: all 5)
--severity <min>   Minimum severity: critical, warning, info (default: info)
--files <glob>     Filter changed files by glob pattern
--report           Print terminal report (annotations are default)
--clean            Remove all [ai-review] TODO comments
--json             Raw JSON output only (for scripting / CI, no annotations)
--parallel <n>     Max parallel copilot calls (default: 5)
--debug            Show per-agent findings, timings, stderr logs
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
~/ai-review/
├── agents/
│   ├── architect.agent.md
│   ├── clean-coder.agent.md
│   ├── ddd-reviewer.agent.md
│   ├── performance.agent.md
│   └── tester.agent.md
├── src/
│   ├── cli.ts             # CLI runtime entrypoint + orchestration
│   ├── reviewPipeline.ts  # analyze + aggregate pipeline
│   ├── aggregator.ts      # dedup + severity filtering + sorting
│   ├── reporter.ts        # colored terminal report rendering
│   └── annotator.ts       # insert / remove TODO comments
├── dist/                  # compiled JS + d.ts (npm/CLI runtime)
├── schemas/
│   └── finding.schema.json
├── skill/
│   └── SKILL.md           # Copilot CLI skill descriptor
├── package.json
├── install.sh
└── README.md
```

---

## Stack

Agents are tuned for: **Java 17+, Spring Boot, Spock/Groovy tests, PostgreSQL, MongoDB, SQS/SNS, DDD, REST APIs**.

To customize an agent, edit the corresponding file in `~/ai-review/agents/`.

---

## Uninstall

```bash
rm ~/.local/bin/ai-review
rm ~/.copilot/skills/ai-review
rm ~/.copilot/agents/{clean-coder,tester,architect,ddd-reviewer,performance}.agent.md
rm -rf ~/ai-review
```

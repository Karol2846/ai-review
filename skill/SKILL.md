---
name: ai-review
description: "Runs the TypeScript/Node ai-review CLI to analyze git diff changes using specialized reviewer agents (clean-coder, tester, architect, ddd-reviewer, performance), annotate files with TODO comments by default, and optionally print a terminal report."
allowed-tools: shell, view, edit
---

# ai-review — Multi-Agent Code Review Skill

When invoked, run `ai-review` from PATH. If unavailable, run `node dist/cli.js` from this repository root.

## How It Works

1. **Scope**: Determines changed files via `git diff` against the base branch (merge-base).
2. **Analyze**: Routes files to selected agents and runs parallel Copilot prompts in the Node runtime.
3. **Aggregate**: Collects findings, applies severity filtering, deduplicates by fingerprint, and sorts.
4. **Output**: Annotates source files with TODO comments by default, and optionally prints a terminal report (`--report`).

## Usage

Run directly from terminal:
```bash
ai-review                              # annotate current branch vs base (default)
ai-review --report                     # also print terminal report
ai-review --agents "tester,ddd-reviewer"  # only specific agents
ai-review --base develop               # compare against specific branch
ai-review --clean                      # remove previous [ai-review] TODOs
ai-review --severity warning           # only warning+critical
ai-review --json                       # raw JSON output
```

## Review Agents

| Agent        | Focus                                                      |
|--------------|------------------------------------------------------------|
| clean-coder  | SOLID, naming, readability, code smells                    |
| tester       | Test coverage, edge cases, Spock patterns                  |
| architect    | Module coupling, REST API, inter-service communication     |
| ddd-reviewer | Aggregates, Value Objects, Domain Events, Bounded Contexts |
| performance  | N+1, pagination, caching, async, resource leaks            |

## Finding Format

Each agent returns:
```json
[{
  "file": "src/main/java/...",
  "line": 42,
  "agent": "agent-name",
  "severity": "critical|warning|info",
  "category": "category-code",
  "message": "Problem description",
  "suggestion": "How to fix"
}]
```

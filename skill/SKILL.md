---
name: ai-review
description: "Orchestrates multi-agent local code review. Analyzes git diff changes using specialized reviewer agents (clean-coder, tester, architect, ddd-reviewer, performance) and produces a consolidated report or annotates files with TODO comments. Use when asked to review code, run code review, or ai-review."
allowed-tools: shell, view, edit
---

# ai-review — Multi-Agent Code Review Skill

When invoked, run the `ai-review` script from this skill's base directory.

## How It Works

1. **Scope**: Determines changed files via `git diff` against the base branch (merge-base).
2. **Analyze**: Runs each reviewer agent in parallel against each changed file. Each agent returns a JSON array of structured findings.
3. **Aggregate**: Collects all findings, deduplicates by fingerprint, sorts by severity.
4. **Output**: Either prints a terminal report (default) or annotates source files with TODO comments (`--annotate`).

## Usage

Run directly from terminal:
```bash
ai-review                              # review current branch vs base
ai-review --annotate                   # also insert TODO comments
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

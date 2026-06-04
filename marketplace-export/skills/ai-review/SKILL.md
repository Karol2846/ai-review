---
name: ai-review
description: "Run a multi-agent code review of the changes on the current branch and annotate the changed files in place with `// TODO ... [ai-review]` comments. Use when the user asks to review my changes, review the current branch."
allowed-tools: shell, edit, agent
---

# ai-review — Multi-Agent Code Review

Use this skill when the user wants their branch changes reviewed. It runs entirely inside Copilot —
there is nothing to install and no API keys to configure.

## How to run

Delegate the whole job to the **`ai-review` orchestrator agent**. It:

1. **Scopes** the review to the current branch's diff against its base
   (`git merge-base HEAD origin/<base>` → `git diff --name-only <mergeBase>..HEAD`).
2. **Routes** each changed file to the relevant reviewer subagents by file-path globs.
3. **Delegates** to the five specialist reviewers and collects their findings.
4. **Aggregates** — filters by severity, deduplicates, sorts.
5. **Annotates** — inserts `// TODO <agent> <severity>: <message> → <suggestion> [ai-review]`
   comments into the source files (comment syntax chosen per file type; inserted just above the
   flagged line).

To remove previously inserted comments, ask for a **clean**: every line containing the
`[ai-review]` marker is deleted.

## Review agents

| Agent        | Focus                                                      |
|--------------|------------------------------------------------------------|
| clean-coder  | SOLID, naming, readability, code smells                    |
| tester       | Test coverage, edge cases, Spock patterns                  |
| architect    | Module coupling, REST API, inter-service communication     |
| ddd-reviewer | Aggregates, Value Objects, Domain Events, Bounded Contexts |
| performance  | N+1, pagination, caching, async, resource leaks            |

## Finding format

Each reviewer returns a JSON array of findings:

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

The orchestrator turns those findings into the inline `[ai-review]` comments described above.

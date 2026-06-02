# ai-review — Copilot marketplace bundle

A self-contained **GitHub Copilot CLI** packaging of the `ai-review` multi-agent code review,
ready to publish to a Copilot-based marketplace.

Unlike the standalone `ai-review` CLI, this bundle has **no external dependencies**: no npm install,
no LLM provider configuration, and no API keys. The review runs entirely on Copilot's own engine —
Copilot performs the review and writes the results back into the source files as inline comments.

## What's inside

```
marketplace-export/
  agents/
    ai-review.agent.md       # orchestrator — scopes, routes, delegates, aggregates, annotates
    clean-coder.agent.md     # reviewer subagent — Clean Code / SOLID / readability
    tester.agent.md          # reviewer subagent — test coverage & quality
    architect.agent.md       # reviewer subagent — architecture, REST/event contracts
    ddd-reviewer.agent.md    # reviewer subagent — Domain-Driven Design
    performance.agent.md     # reviewer subagent — DB access, N+1, caching, async
  skills/
    ai-review/
      SKILL.md               # entry point: "review my changes" → invoke the orchestrator
```

The **orchestrator** (`ai-review`) is the only agent a user interacts with. It delegates each
changed file to the relevant **reviewer subagents** via Copilot's `agent` tool, aggregates the
findings, and inserts `// TODO <agent> <severity>: <message> → <suggestion> [ai-review]` comments
into the changed files (comment syntax is chosen per file extension; the comment goes just above the
flagged line). Asking for a *clean* removes every line containing the `[ai-review]` marker.

## How it works (pipeline)

1. **Scope** — current branch diff vs. base: `git merge-base HEAD origin/<base>` then
   `git diff --name-only <mergeBase>..HEAD`. Base is auto-detected (`origin/HEAD`, falling back to
   `main`/`master`).
2. **Route** — each changed file is matched to reviewers by file-path globs (see the table in
   `agents/ai-review.agent.md`).
3. **Delegate** — matched reviewer subagents return findings as JSON.
4. **Aggregate** — severity filter, dedupe, sort.
5. **Annotate** — findings become inline `[ai-review]` comments.

## Installing locally (for testing in Copilot CLI)

Copy the bundle into your personal Copilot directory:

```bash
cp marketplace-export/agents/*.agent.md            ~/.copilot/agents/
cp -r marketplace-export/skills/ai-review          ~/.copilot/skills/
```

Then, from a repo with branch changes, ask Copilot to "review my changes" (or invoke the
`ai-review` agent directly) and check that it inserts `// TODO ... [ai-review]` comments.

Project-scoped installation works too: place the files under `.github/agents/` and
`.github/skills/ai-review/` in the target repository.

## Publishing to the marketplace

Upload the `agents/` and `skills/` contents through your marketplace's normal flow. The bundle
follows the standard GitHub Copilot CLI conventions:

- **Agents** — `*.agent.md` with YAML front matter (`name`, `description`, `tools`, and `infer` on
  the orchestrator). The orchestrator declares the `agent` tool to delegate to subagents.
- **Skill** — `SKILL.md` with `name`, `description`, `allowed-tools`, living in a directory named
  after the skill (`ai-review/`).

If your marketplace requires an additional manifest or a different layout, adapt it on top of this
bundle — the agent/skill files themselves are the portable, reusable part.

### Format references

- https://docs.github.com/en/copilot/reference/custom-agents-configuration
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
- https://github.com/github/copilot-cli-for-beginners/blob/main/04-agents-custom-instructions/README.md

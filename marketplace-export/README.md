# ai-review — multi-agent code review for Copilot

`ai-review` is a **GitHub Copilot CLI** plugin that reviews the changes on your current branch and
writes the feedback straight into your source files as inline `// TODO ... [ai-review]` comments.

It's built for **Java / Kotlin / Spring** codebases. Five specialized reviewers look at your diff
from different angles — code quality, tests, architecture, domain design, and performance — and the
result is a set of concrete, located comments you can act on or clear out with a single ask.

Everything runs on Copilot's own engine. There's nothing to install beyond dropping the bundle in
place, no LLM provider to configure, and no API keys to manage.

## What it does

1. **Scopes** the review to your branch's diff against its base
   (`git merge-base HEAD origin/<base>` → `git diff --name-only <mergeBase>..HEAD`). The base branch
   is auto-detected (`origin/HEAD`, falling back to `main`/`master`).
2. **Routes** each changed file to the relevant reviewers by file-path globs.
3. **Reviews** — the matched reviewer agents inspect each file and report findings.
4. **Aggregates** — filters by severity, removes duplicates, sorts by severity and location.
5. **Annotates** — inserts a comment just above each flagged line:
   `// TODO <agent> <severity>: <message> → <suggestion> [ai-review]`
   (comment syntax is chosen per file type — `//`, `#`, `--`, or `<!-- -->`).

Ask for a **clean** and every line containing the `[ai-review]` marker is removed.

## The reviewers

| Agent        | Focus                                                      |
|--------------|------------------------------------------------------------|
| clean-coder  | Clean Code / SOLID, naming, readability, code smells       |
| tester       | Test coverage, edge cases, Spock/JUnit patterns            |
| architect    | Module coupling, REST API & event contracts, error handling|
| ddd-reviewer | Aggregates, Value Objects, Domain Events, Bounded Contexts |
| performance  | N+1 queries, pagination, caching, async, resource leaks    |

A single orchestrator agent (`ai-review`) drives the whole pipeline and delegates to these reviewers
as subagents — it's the only agent you interact with.

## Per-agent models (cost tiering)

Each agent pins its own model via the `model:` field in its front matter. In the Copilot CLI a
custom agent's own `model` has the **highest precedence** (above `--model`, `COPILOT_MODEL`,
`settings.json`, and the default), and every subagent runs on the model from its own definition — so
the heavy-reasoning lanes use a stronger model while the mechanical lanes use a cheaper, faster one:

| Agent              | Model               | Why |
|--------------------|---------------------|-----|
| ai-review (orchestrator) | `claude-sonnet-4.5` | Routing, aggregation, and precise in-place edits |
| architect          | `claude-sonnet-4.5` | Contracts, coupling, failure modes — needs reasoning |
| ddd-reviewer       | `claude-sonnet-4.5` | Nuanced domain-design judgment |
| clean-coder        | `claude-haiku-4.5`  | Style / readability — pattern-level, cheap |
| tester             | `claude-haiku-4.5`  | Coverage gaps — pattern-level, cheap |
| performance        | `claude-haiku-4.5`  | Loop/query smells — pattern-level, cheap |

Notes:
- The value must be a **string** (e.g. `model: claude-haiku-4.5`); array syntax breaks agent loading
  in the CLI.
- Available model slugs depend on your org/plan — run `copilot help` to see the exact list (e.g. you
  can promote `architect`/`ddd-reviewer` to a `*-opus-*` model for max quality).

## What's inside

```
agents/
  ai-review.agent.md       # orchestrator — scopes, routes, delegates, aggregates, annotates
  clean-coder.agent.md     # reviewer — Clean Code / SOLID / readability
  tester.agent.md          # reviewer — test coverage & quality
  architect.agent.md       # reviewer — architecture, REST/event contracts
  ddd-reviewer.agent.md    # reviewer — Domain-Driven Design
  performance.agent.md     # reviewer — DB access, N+1, caching, async
skills/
  ai-review/
    SKILL.md               # entry point: "review my changes" → runs the orchestrator
```

## Installing

Drop the bundle into your personal Copilot directory:

```bash
cp agents/*.agent.md      ~/.copilot/agents/
cp -r skills/ai-review    ~/.copilot/skills/
```

Or scope it to a single repository by placing the files under `.github/agents/` and
`.github/skills/ai-review/`.

Then, from a repo with branch changes, ask Copilot to **"review my changes"** (or invoke the
`ai-review` agent directly). It inserts `// TODO ... [ai-review]` comments into the changed files;
ask it to **clean** them when you're done.

## Publishing to a marketplace

Upload the `agents/` and `skills/` contents through your marketplace's normal flow. The bundle
follows standard GitHub Copilot CLI conventions:

- **Agents** — `*.agent.md` with YAML front matter (`name`, `description`, `tools`, and `infer` on
  the orchestrator, which declares the `agent` tool to delegate to the reviewers).
- **Skill** — `SKILL.md` with `name`, `description`, `allowed-tools`, in a directory named after the
  skill (`ai-review/`).

If your marketplace requires an extra manifest or a different layout, add it on top of this bundle —
the agent and skill files themselves are the portable, reusable part.

### Format references

- https://docs.github.com/en/copilot/reference/custom-agents-configuration
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
- https://github.com/github/copilot-cli-for-beginners/blob/main/04-agents-custom-instructions/README.md

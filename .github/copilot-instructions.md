# Copilot Instructions for `ai-review`

## Build, test, and lint commands

This repository does **not** define a separate build/lint/test pipeline (no `package.json`, `Makefile`, Gradle/Maven, or test runner config in-repo). Use the CLI itself as the executable workflow.

| Goal                                                       | Command                                                                                 |
|------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| Install locally (symlinks CLI, agents, and skill)          | `bash install.sh`                                                                       |
| Full run on current branch diff                            | `ai-review`                                                                             |
| Full run + terminal report                                 | `ai-review --report`                                                                    |
| Raw JSON output (for scripting/CI)                         | `ai-review --json`                                                                      |
| Clean inserted TODO comments                               | `ai-review --clean`                                                                     |
| **Single-scope run** (closest equivalent to a single test) | `ai-review --agents "tester" --files "src/main/java/com/example/MyClass.java" --report` |

## High-level architecture

`ai-review` is a Bash-orchestrated, multi-agent diff reviewer with four phases:

1. **Scope/orchestration (`bin/ai-review`)**
   - Resolves repo root, base branch (`origin/HEAD` or fallback `main`/`master`), merge-base, and changed files.
   - Creates a temp workdir and runs analyze → aggregate → output.
2. **Per-file/per-agent analysis (`bin/analyze.sh`)**
   - Builds one task per `(changed file × selected agent)`.
   - For each task, loads agent instructions from `agents/*.agent.md`, sends diff + first 300 lines of current file to `copilot -p -s`, and stores JSON results.
   - Uses GNU `parallel` when available, otherwise `xargs -P`.
3. **Aggregation (`bin/aggregate.sh`)**
   - Merges all raw JSON arrays, applies min-severity filtering, deduplicates via fingerprint logic, and sorts by severity/file/line.
4. **Output (`bin/report.sh`, `bin/annotate.sh`)**
   - `--report`: colored grouped terminal output.
   - Default mode: injects TODO comments into source files; `--clean` removes prior `[ai-review]` markers.

Install/integration surface:
- `install.sh` symlinks `bin/ai-review` to `~/.local/bin/ai-review`, `agents/*.agent.md` to `~/.copilot/agents/`, and `skill/` to `~/.copilot/skills/ai-review`.
- `skill/SKILL.md` defines `/ai-review` skill behavior for Copilot CLI.

## Key conventions in this codebase

1. **Structured finding contract is strict**
   - Findings are JSON objects with stable fields (`file`, `line`, `agent`, `severity`, `category`, `message`, `suggestion`; optional `endLine`, generated `fingerprint`).
   - Canonical schema is in `schemas/finding.schema.json`.
2. **Agent identity and scope are fixed**
   - Supported agents: `clean-coder`, `tester`, `architect`, `ddd-reviewer`, `performance`.
   - Agent prompts live in `agents/*.agent.md` and are expected to return a JSON array only.
3. **Graceful parser fallback is intentional**
   - If agent output is not valid JSON array, analyzer falls back to `[]` rather than failing the run.
4. **Annotation lifecycle depends on `[ai-review]` marker**
   - Inserted comments must keep `[ai-review]`; cleanup removes lines containing this marker.
   - Insertions happen bottom-up by line number to preserve target locations.
5. **Diff-first review model**
   - Review scope is always changed files between `merge-base(origin/<base>, HEAD)` and `HEAD`, not whole-repo scanning.
6. **Shell implementation assumes Unix-like tooling**
   - Scripts rely on Bash + common Unix utilities (`jq`, `git`, `python3`, optional GNU `parallel`) and temporary dirs under `/tmp`.

# Copilot Instructions for `ai-review`

## Build, test, and lint commands

This repository uses a TypeScript/Node runtime with npm scripts for build, typecheck, and tests.

| Goal                                                       | Command                                                                                 |
|------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| Install locally (builds CLI + symlinks CLI, agents, skill) | `bash install.sh`                                                                      |
| Type-check TS runtime                                      | `npm run typecheck`                                                                     |
| Build runtime                                               | `npm run build`                                                                         |
| Run tests                                                   | `npm run test`                                                                          |
| Full run on current branch diff                            | `ai-review`                                                                             |
| Full run + terminal report                                 | `ai-review --report`                                                                    |
| Raw JSON output (for scripting/CI)                         | `ai-review --json`                                                                      |
| Clean inserted TODO comments                               | `ai-review --clean`                                                                     |
| **Single-scope run** (closest equivalent to a single test) | `ai-review --agents "tester" --files "src/main/java/com/example/MyClass.java" --report` |

## High-level architecture

`ai-review` is a TypeScript/Node multi-agent diff reviewer with four phases:

1. **Scope/orchestration (`src/cli.ts`, `src/git.ts`)**
   - Resolves repo root, base branch (`origin/HEAD` or fallback `main`/`master`), merge-base, and changed files.
2. **Per-file/per-agent analysis (`src/reviewPipeline.ts`, `src/runner.ts`)**
   - Builds one task per `(changed file × selected agent)` based on routing config.
   - Loads agent instructions from `agents/*.agent.md`, sends diff + bounded file context to Copilot, and parses JSON findings.
3. **Aggregation (`src/aggregator.ts`)**
   - Applies min-severity filtering, deduplicates via fingerprint logic, and sorts by severity/file/line.
4. **Output (`src/reporter.ts`, `src/annotator.ts`)**
   - `--report`: colored grouped terminal output.
   - Default mode: injects TODO comments into source files; `--clean` removes prior `[ai-review]` markers.

Install/integration surface:
- `install.sh` builds `dist/cli.js`, symlinks it to `~/.local/bin/ai-review`, and symlinks `agents/*.agent.md` plus `skill/` into Copilot directories.
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
6. **Node runtime + shell integration**
   - Runtime logic is in TypeScript modules under `src/`; shell usage is limited to installation and external tool execution (`git`, `copilot`) via Node.

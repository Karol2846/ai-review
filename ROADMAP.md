# Migration Roadmap: Vercel AI SDK

This document captures architectural decisions and notes from design review. It is not an implementation spec — it is a directional record to guide future work.

## Goal

Replace the current dual-provider model (Ollama cloud, GitHub Copilot CLI) with a universal LLM layer built on **Vercel AI SDK v6** (`ai` package). The result should support any major commercial provider through a single, unified interface while preserving the existing UX pattern: configure once at install time, optionally override per project.

## Verified API surface (Vercel AI SDK v6)

All of the following exist in the official SDK:

| Item | Package | Notes |
|------|---------|-------|
| `generateObject` | `ai` | Accepts `model`, Zod `schema`, `prompt`/`messages` |
| `LanguageModel` | `ai` | Public type; internals are `LanguageModelV3` in v6, but `LanguageModel` is the correct type to reference |
| `createOpenAI` | `@ai-sdk/openai` | Accepts optional `baseURL` — covers OpenAI, Groq, OpenRouter, any OpenAI-compatible endpoint |
| `createAnthropic` | `@ai-sdk/anthropic` | Standard factory |
| `createGoogleGenerativeAI` | `@ai-sdk/google` | **Verify exact name at implementation time** — `createGoogle` is a possible alternative |
| `createAmazonBedrock` | `@ai-sdk/amazon-bedrock` | Separate npm package, follows the same factory pattern. Note: `@ai-sdk/google-vertex` also exists for Vertex AI — pick the right one |

Zod is the schema library integrated with `generateObject`. No custom schema format is needed.

## Configuration design

### Install-time (global)

During `npm install -g`, the postinstall wizard (`scripts/postinstall.js`) asks:

1. Provider choice: `openai-compatible` | `anthropic` | `google` | `bedrock`
2. Model name (free text input)
3. Environment variable name for the API key (e.g. `AI_REVIEW_API_KEY`)
4. *(only for `openai-compatible`)* Optional `baseURL` override — explain in the prompt that this enables Groq, OpenRouter, etc.

The wizard writes a global config file next to the binary. It must **never** write the API key itself — only the env var name.

### Per-project override

Users can override any of the above in `.ai-reviewrc.json` at the repo root. The existing `agentGlobs` key stays. New top-level keys to add:

```json
{
  "provider": "openai-compatible",
  "model": "gpt-4o",
  "apiKeyEnv": "OPENAI_API_KEY",
  "baseURL": "https://api.groq.com/openai/v1"
}
```

`baseURL` is optional and only meaningful for `openai-compatible`. `config.ts` should validate and warn on unknown keys (it already does this for `agentGlobs`).

## Architectural notes for the implementation

### Provider factory (`src/llmProvider.ts`)

Replace the current `LlmProvider` interface and its two implementations with a `createLlmClient(config)` factory that returns a `LanguageModel`. The factory reads `process.env[config.apiKeyEnv]` at call time. It must throw a clear, actionable error if the env var is missing — not silently fail downstream.

### Structured output replaces the response parser

`generateObject` + Zod eliminates `src/responseParser.ts` entirely. The Zod schema should mirror `schemas/finding.schema.json`. The correct place for the `generateObject` call is **not inside `runner.ts`** — runner is an orchestration layer and should not know about the output schema. Instead, create a thin adapter (e.g. `src/llmAdapter.ts`) that:

- accepts a `LanguageModel` and a prompt string
- calls `generateObject` with the Zod findings schema
- returns `Finding[]`
- maps SDK errors to the existing `LlmProviderError` codes so runner's retry logic stays unchanged

`BatchRunSuccess.rawOutput: string` will need to change type — either to `readonly findings: Finding[]` or to a discriminated union — before the pipeline can drop the parser cleanly.

### Retry: avoid doubling up

Vercel AI SDK's `generateObject` has its own internal retry via the `maxRetries` parameter. `runner.ts` already has retry logic with transient/non-transient error classification and configurable delay. Running both simultaneously produces up to `(sdkRetries + 1) × (runnerRetries + 1)` attempts and unpredictable backoff behavior.

**Decision:** keep retry in `runner.ts`, set `maxRetries: 0` in `generateObject`. Map SDK-level rate-limit errors (`429`) to `LlmProviderError` with code `RATE_LIMITED` in the adapter so runner's existing transient retry kicks in.

### Concurrency

`runner.ts` already accepts `concurrency` as a configurable parameter passed through `p-map`. Do not hardcode a value inside the implementation. Add `5` as the default value written by the install wizard into the config file — users can override it in `.ai-reviewrc.json` if needed.

## Files to remove

Once the new provider layer is in place:

- `src/ollamaProvider.ts`
- `src/copilot.ts`
- `src/responseParser.ts`
- Corresponding test files for the above

## Files to keep / modify

- `src/runner.ts` — minimal changes: accept `Finding[]` from the adapter instead of `rawOutput: string`
- `src/reviewPipeline.ts` — remove the `parseSuccessfulBatch` step; findings come out of the runner already typed
- `src/config.ts` — add provider config keys alongside existing `agentGlobs` parsing
- `src/installProviderConfig.ts` — this is a **runtime parser**, not the wizard; keep it or repurpose it for the new config shape
- `scripts/postinstall.js` — this is where the interactive wizard lives; update questions here

## What this migration does not change

- Git diff scope (`merge-base..HEAD`)
- Agent instruction loading (`agents/*.agent.md`)
- Batching logic (`src/batcher.ts`)
- Aggregation and deduplication (`src/aggregator.ts`)
- Output modes (`--report`, `--clean`, annotation lifecycle)
- The `CliRuntimeDependencies` injection pattern in `src/cli.ts`

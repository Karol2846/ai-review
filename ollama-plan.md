# Local LLM Provider Support (Ollama) — Feasibility & Plan

## Current State Summary
- The runtime invokes **GitHub Copilot CLI** directly via `src/copilot.ts` using a single command (`copilot -p ... -s`).
- The review pipeline depends on that single provider (`runCopilotPrompt` is used by the runner).
- Installation is via `npm install -g ai-review` with a postinstall step that copies agents/skills into `~/.copilot/`, and docs/skill text reference Copilot.
- Configuration (`.ai-reviewrc.json`) is currently limited to **routing** (agent globs), not model/provider settings.
- Output parsing assumes a strict JSON-array response, with fallback parsing for malformed output.

## Difficulty Assessment
**Overall difficulty: Medium.**
- **Moderate scope:** requires introducing a provider abstraction and new configuration surfaces without breaking existing behavior.
- **Integration risk:** local models may not consistently comply with the strict JSON output format.
- **Operational concerns:** timeouts, concurrency, and prompt size limits may need tuning for smaller local models.
- **Docs + install changes:** current postinstall flow assumes Copilot; must be made conditional.

## Plan (High-Level)
1. **Provider Abstraction**
   - Define a provider layer between the runner and the model invocation.
   - Keep Copilot as the default provider to preserve backward compatibility.
   - Standardize error handling so provider-specific failures map to existing warning/error reporting.

2. **Configuration & CLI Surface**
   - Extend configuration to support provider selection and model settings.
   - Add CLI options for provider, model name, and endpoint (with environment variable fallbacks).
   - Validate inputs early so failures are clear and actionable.

3. **Ollama Provider Integration**
   - Add a provider that targets Ollama’s local API.
   - Support model selection, host/port overrides, and request timeouts.
   - Ensure prompts preserve the current agent instruction + batch structure.

4. **Pipeline Wiring & UX**
   - Route all model calls through the provider layer.
   - Preserve existing retry behavior and debug output.
   - Update the skill docs to mention provider selection if needed.

5. **Documentation & Install Updates**
   - Update README with usage examples for local models.
   - Make Copilot setup optional in the npm postinstall step when a non-Copilot provider is chosen.
   - Document requirements for Ollama (running server, model availability).

6. **Validation Strategy**
   - Add tests for configuration parsing and provider selection.
   - Add integration-style tests using mocked provider responses.
   - Sanity-check JSON output handling with a small local model.

## Open Questions / Risks
- Which Ollama API endpoint to use (chat vs generate) for best JSON adherence.
- Whether prompt size limits must be reduced for local models.
- How strict the JSON validation should be for non-Copilot outputs.
- Expected performance impact under parallel load.

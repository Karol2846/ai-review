# Local LLM Provider Support (Ollama) — Feasibility & Plan

## Current State Summary
- The runtime invokes **GitHub Copilot CLI** directly via `src/copilot.ts` using a single command (`copilot -p ... -s`).
- The review pipeline depends on that single provider (`runCopilotPrompt` is used by the runner).
- Installation is via `npm install -g ai-review` with a postinstall step that copies agents/skills into `~/.copilot/`, and docs/skill text reference Copilot.
- Configuration (`.ai-reviewrc.json`) is currently limited to **routing** (agent globs), not model/provider settings.
- Output parsing assumes a strict JSON-array response, with fallback parsing for malformed output.

## Difficulty Assessment
**Overall difficulty: Low → Medium (phase 1).**
- **Small initial scope:** add a minimal Ollama execution path with a fixed model (`gemma4`), keeping Copilot as the default.
- **Integration risk:** local models may not consistently comply with the strict JSON output format.
- **Operational concerns:** timeouts, concurrency, and prompt size limits may need tuning for smaller local models.
- **Docs + install changes:** current postinstall flow assumes Copilot; must be made conditional.

## Plan (High-Level)
1. **Phase 1: Minimal Ollama Path (gemma4 only)**
   - Add a small toggle (CLI flag or env var) to switch from Copilot to Ollama without a full provider abstraction.
   - Keep Copilot as the default provider to preserve backward compatibility.
   - Call Ollama with a fixed model name (`gemma4`) to keep configuration minimal.
   - Allow only basic host/timeout overrides if needed; defer additional config knobs.

2. **Pipeline Wiring & UX**
   - Route the toggle to a simple Ollama call path while preserving current retry/logging behavior.
   - Ensure prompts preserve the current agent instruction + batch structure.
   - Update the skill docs to mention the simple toggle if needed.

3. **Documentation & Install Updates**
   - Update README with usage examples for the Ollama `gemma4` path.
   - Make Copilot setup optional in the npm postinstall step when Ollama is used.
   - Document requirements for Ollama (running server, model availability).

4. **Validation Strategy**
   - Add tests for the toggle parsing and Ollama path selection.
   - Add integration-style tests using mocked Ollama responses.
   - Sanity-check JSON output handling with the `gemma4` model.

5. **Phase 2 (Later): Provider Abstraction + Model Config**
   - Introduce a provider layer once the minimal Ollama path is stable.
   - Add model selection and broader configuration surfaces.

## Open Questions / Risks
- Which Ollama API endpoint to use (chat vs generate) for best JSON adherence.
- Whether prompt size limits must be reduced for local models.
- How strict the JSON validation should be for non-Copilot outputs.
- Expected performance impact under parallel load.

# Plan: uproszczenie per-repo configu `ai-review.json` (v2)

## Context

Per-repo konfig `ai-review.json` ma 4 sekcje (`routing`, `model`, `agents`, `exclude`)
z niespójnościami obciążającymi UX:
- Dwie sekcje na "globs agenta": `routing.agentGlobs.<name>` dla built-inów, `agents.<name>` dla customów.
- `model` powiela 1:1 install-wizard z subtelną logiką merge (dziedziczenie `baseURL`).
- Brak `ai-review init` — pierwsza znajomość z konfiguracją to czytanie README.

Akceptujemy **breaking change** (major bump), bo projekt ma mało użytkowników.

## Decyzje projektowe

1. **Jedna sekcja `agents`** — rozróżnienie built-in vs custom po `instructionsFile` (custom) / nazwie z `AGENT_NAMES` (built-in).
2. **`instructionsFile` wymagany dla customów** — bez konwencji domyślnej ścieżki (user może trzymać agenty gdzie chce).
3. **Tryb merge globów**: domyślnie **extend** (append+dedup), opcjonalny per-agent `"replace": true` tylko dla built-inów.
4. **`model` → prosty string** (hard change). Tylko nazwa modelu; provider/apiKeyEnv/baseURL tylko z wizarda.
5. **`exclude`** bez zmian w kodzie — tylko doc clarification (union z `--exclude`).
6. **`ai-review init`** scaffolduje minimalny `ai-review.json` (bez JSON Schema).

## Docelowy kształt `ai-review.json`

```json
{
  "model": "claude-haiku-4-5",
  "agents": {
    "tester": { "globs": ["**/*.spec.ts"] },
    "clean-coder": { "globs": ["legacy/**/*.ts"], "replace": true },
    "security": {
      "globs": ["**/*.java"],
      "instructionsFile": "agents/security.agent.md"
    }
  },
  "exclude": ["**/*.generated.ts", "vendor/**"]
}
```

Reguły:
- Nazwa z `AGENT_NAMES` → built-in; `globs` wymagane; `replace?: boolean` dozwolony; `instructionsFile` **zabroniony**.
- Nazwa spoza `AGENT_NAMES` → custom; `globs` wymagane; `instructionsFile` **wymagany**; `replace` **zabroniony**.
- Pusty `globs` → hard-fail.
- Klucz `routing` w roocie → hard-fail z migration hint.

---

## Faza A — Unifikacja sekcji `agents` (usunięcie `routing`)

**Pliki:**
- `src/routingTypes.ts` — `CustomAgentDefinition` → `AgentDefinition`: `{ globs: readonly string[]; instructionsFile?: string; replace?: boolean }`. Alias `CustomAgentsMap` → `AgentsMap`.
- `src/repoConfig.ts`:
  - Usuń `parseRoutingSection`, `ALLOWED_ROUTING_KEYS`, `routing` z `ALLOWED_ROOT_KEYS`.
  - Przebuduj `parseAgentsSection`: akceptuje built-iny (brak `instructionsFile`, opcjonalny `replace`) i customy (wymagany `instructionsFile`). Klucz `routing` → hard-fail z hintem migracyjnym.
  - `customAgentsToRoutingOverride` → `agentsToRoutingOverride(agents)` z obsługą trybu replace.
  - `mergeRoutingConfig` — obsłuż `replace` per-agent.
- `src/cli.ts:383-411, 452-483` — usuń `customAgents` jako osobny byt; podział na built-in/custom przy budowaniu `instructionFileOverrides` wyłącznie po `AGENT_NAMES`.
- `src/index.ts` — zaktualizuj re-exporty.

**Testy:**
- `test/repoConfig.test.ts` — usuń sekcję `routing`, dodaj testy: built-in z globs, built-in z `replace: true`, custom wymaga `instructionsFile`, built-in z `instructionsFile` → fail, `routing` w roocie → fail z migration hint, `mergeRoutingConfig` z trybem replace.

---

## Faza B — `model` jako string

**Pliki:**
- `src/installProviderConfig.ts` — `UserModelConfigOverride = string | null`. `mergeProviderConfig(base, override: string | null)`: jeśli string → kopiuj base, podmień tylko `model`. Cała logika `baseURL` inheritance znika.
- `src/repoConfig.ts` — `parseModelSection`: jeśli nie string lub pusty → hard-fail z hintem (`"v2: model is now a string. Re-run wizard to change provider."`). Usuń `ALLOWED_MODEL_KEYS`.
- `src/cli.ts` — typ `modelOverride: string | null`.
- `src/index.ts` — usuń eksport `UserModelConfigOverride`.

**Testy:**
- `test/repoConfig.test.ts:138-207` — przepisz: zaakceptuj string, odrzuć obiekt z hintem.
- `test/install-provider-config.test.ts:143-212` — uproszczone testy `mergeProviderConfig`.

---

## Faza C — `ai-review init`

**Pliki:**
- `src/cliArgs.ts:153` — `allowPositionals: true`; dodaj `positionals` do `CliOptions`; zaktualizuj `formatCliUsage` o "Commands: init".
- `src/cli.ts` — sprawdź `options.positionals[0] === "init"` przed resolve repo root; deleguj do `runInit`. Plik istnieje bez `--force` → exit 1.
- Nowy plik `src/init.ts` — pisze minimalny `ai-review.json`. Wzorzec I/O: `fs.writeFileSync(path, JSON.stringify(template, null, 2) + "\n", "utf8")` (jak `setupWizard.ts:104`).

Szablon wyjściowy:
```json
{
  "exclude": ["**/*.generated.ts", "vendor/**"],
  "agents": {
    "tester": { "globs": ["**/*.spec.ts"] }
  }
}
```

**Testy:**
- Nowy `test/cli-init.test.ts` — fake fs przez tmp dir, sprawdź treść pliku, exit 1 bez `--force`, nadpisanie z `--force`.
- `test/cli-args.test.ts` — testy parsowania positionals.

---

## Faza D — dokumentacja + migration note

**Pliki:**
- `README.md:279-308` — przepisz sekcję "Per-repo config": nowy schemat v2, union dla `exclude`, sekcja "Quick start" z `ai-review init`.
- `README.md` — tabela migracji v1→v2.
- `CLAUDE.md:43-65` — przepisz "Routing and configuration".
- `package.json` — major version bump.

---

## Weryfikacja end-to-end

Po każdej fazie:
```bash
npm run typecheck && npm run test
```

Manualnie po całości:
1. `ai-review init` — tworzy plik.
2. `ai-review --report` z configiem v2 — built-iny i custom odpala poprawnie.
3. Config z `"model": "claude-haiku-4-5"` + `--debug` — widać override.
4. Legacy `routing.agentGlobs` w configu → migration hint, nie cichy fail.

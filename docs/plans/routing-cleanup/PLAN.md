# Plan: porządki w routingu — martwy kod, `unmatchedFilesPolicy`, kompilacja matcherów raz

> **Zanim zaczniesz:** plan zakłada, że na `main` są już
> [#21](https://github.com/Karol2846/ai-review/pull/21) i [#22](https://github.com/Karol2846/ai-review/pull/22)
> (`explainGlobMatch`/`explainRouting` z #22 też trzeba objąć krokiem 3). Jeśli równolegle trwa praca nad
> `docs/plans/code-file-coverage/PLAN.md`, ten plan dotyka innych plików (`router.ts`, `globMatch.ts`, `routingTypes.ts`),
> więc da się je robić niezależnie — konflikty możliwe tylko w `CLAUDE.md`.
> Sekcję „Pytania do właściciela” rozstrzygnij z użytkownikiem przed kodem.

## Kontekst

Po serii zmian w routingu (#17–#19, #21, #22) zostały resztki i nieefektywności:

1. **Martwy kod w `routeFilesToAgents` (`src/router.ts`).** Zmienna `matched` i blok
   `if (!matched && config.unmatchedFilesPolicy === "skip") { continue; }` na końcu pętli niczego nie robią
   (`continue` jako ostatnia instrukcja iteracji).
2. **`unmatchedFilesPolicy` nic nie znaczy.** Pole `RoutingRuntimeConfig.unmatchedFilesPolicy` (typ `UnmatchedFilesPolicy = "skip"`,
   `src/routingTypes.ts`) ma jedną możliwą wartość i jest czytane tylko w martwym kodzie z pkt 1. Faktyczne zachowanie
   („nie review'uj, ale wypisz na stderr”) realizują `findUnroutedFiles` + `src/cli.ts` (#18). Pole jest częścią
   publicznego typu `RoutingRuntimeConfig` (eksportowanego z `src/index.ts`; sam `UnmatchedFilesPolicy` nie jest eksportowany)
   i pojawia się w testach: `test/router.test.ts` (`createConfig` + test „skips unmatched files when unmatchedFilesPolicy is 'skip'”),
   `test/repoConfig.test.ts` („preserves unmatchedFilesPolicy from base”), fixture'y w `test/cli-runtime.test.ts` i `test/review-pipeline.smoke.test.ts`.
3. **Globy są kompilowane przy każdym dopasowaniu.** `matchesGlobs` (`src/globMatch.ts`) przy każdym wywołaniu filtruje wzorce
   i woła `micromatch.isMatch`, które za każdym razem kompiluje regex (picomatch nie cache'uje). Router woła to
   `pliki × agenci`, `--explain-routing` dodatkowo per wzorzec. Pomiar na domyślnym configu: **2000 plików ≈ 250 ms,
   z prekompilowanymi matcherami ≈ 8 ms**. W skali review (minuty na LLM) to pomijalne — zysk jest głównie porządkowy,
   ale to też najprostszy sposób, by `matchesGlobs` i `explainGlobMatch` miały jedną implementację.
4. **Zduplikowane helpery.** `[...new Set(files)].sort()` jest w `src/router.ts`
   (`toDeterministicUniqueList`), `src/contextBuilder.ts` (`toDeterministicFileList`), `src/batcher.ts` i `src/routingExplanation.ts` (#22).
   Do tego `src/batcher.ts` powtarza logikę kolejności agentów z `toDeterministicAgentList` w routerze (najpierw `AGENT_NAMES`, potem custom alfabetycznie).

## Cel

- Usunąć martwy kod i (po decyzji) zbędne pole konfiguracji.
- Jedna implementacja dopasowania globów, kompilowana raz na listę wzorców, używana przez routing, `exclude` i `--explain-routing`.
- Zero zmian zachowania widocznych dla użytkownika CLI (te same pliki do tych samych agentów, ten sam output).

## Poza zakresem

- Zmiany domyślnych globów (to `docs/plans/code-file-coverage/PLAN.md`).
- Zmiana semantyki negacji (`!` wygrywa niezależnie od kolejności — zostaje).

## Pytania do właściciela

1. **Usunąć `unmatchedFilesPolicy` z `RoutingRuntimeConfig`?**
   *Rekomendacja:* tak. Pole nie ma znaczenia, a jego obecność sugeruje konfigurowalność, której nie ma. To zmiana typu publicznego API
   (`src/index.ts` eksportuje `RoutingRuntimeConfig`) — przy małej liczbie użytkowników akceptowalne, ale
   wymaga wpisu w changelogu/README i ewentualnie bumpa wersji (projekt już robił breaking change w config v2).
   *Alternatywa:* zostawić pole jako `@deprecated` (opcjonalne), usunąć tylko martwy kod.
2. **Czy wspólny helper „unikalne + posortowane” ma iść do nowego `src/collections.ts`, czy wystarczy eksport z `router.ts`?**
   *Rekomendacja:* mały moduł `src/collections.ts` (`uniqueSorted`) — `contextBuilder`/`batcher` nie powinny importować z routera.

## Kroki implementacji

1. **Martwy kod** (`src/router.ts`): usuń `matched` i końcowy `if … continue`. Commit sam w sobie.
2. **`unmatchedFilesPolicy`** (wg pyt. 1):
   - `src/routingTypes.ts`: usuń pole i typ `UnmatchedFilesPolicy` (albo oznacz `@deprecated` i zrób opcjonalnym).
   - `src/defaultConfig.ts` i testy wymienione w „Kontekście”, pkt 2 (+ `test/routing-explanation.test.ts` z #22) — usuń pole z fixture'ów;
     test „skips unmatched files…” przemianuj na „does not route files no agent matches”, test „preserves unmatchedFilesPolicy” usuń.
   - `rg unmatchedFilesPolicy` musi zwrócić 0 trafień (poza ewentualną notką w changelogu).
3. **Kompilacja matcherów raz** (`src/globMatch.ts`):
   - Dodaj `compileGlobs(patterns: readonly string[]): CompiledGlobs`, gdzie `CompiledGlobs` ma
     `matches(path): boolean` i `explain(path): GlobMatchExplanation | null`. W środku: rozdział na pozytywne/negacje raz,
     `micromatch.matcher(pattern, GLOB_MATCH_OPTIONS)` per wzorzec (jest w micromatch 4, bez nowej zależności),
     `normalizeGlobPath` na wejściu.
   - `matchesGlobs`/`explainGlobMatch` zostają jako cienkie wrappery (`compileGlobs(p).matches(path)`) — publiczne API się nie zmienia.
   - `src/router.ts`: w `routeFilesToAgents`, `explainRouting` skompiluj raz na agenta przed pętlą po plikach.
   - `src/cli.ts` `excludeChangedFiles` i `src/routingExplanation.ts`: skompiluj `exclude` raz.
   - Zachowaj semantykę: pusta lista → nic nie pasuje; same negacje → „wszystko oprócz”; `!(…)` to extglob (pozytywny).
4. **Helpery** (wg pyt. 2): jeden `uniqueSorted`, użyty w czterech miejscach z „Kontekstu”, pkt 4; kolejność agentów —
   jedna funkcja (np. `orderAgents(names)` obok `AGENT_NAMES` w `src/routingTypes.ts` albo w `src/collections.ts`), użyta w routerze i batcherze.
   Sprawdź, że kolejność batchy w `test/batcher-prompt.test.ts` się nie zmienia.
5. **Dokumentacja:** `CLAUDE.md` (akapit routingu: `compileGlobs`; usunięcie wzmianki o polityce, jeśli jest), README tylko jeśli
   pole było tam opisane (sprawdź `rg unmatchedFilesPolicy README.md`).

## Testy

- Istniejące testy `test/glob-match.test.ts` (w tym test zgodności `explainGlobMatch` ↔ `matchesGlobs`) przechodzą bez zmian.
- Nowe: `compileGlobs(p).matches(x) === matchesGlobs(x, p)` i `.explain(x)` równe `explainGlobMatch(x, p)` dla macierzy
  ścieżek × list wzorców (pusta, same negacje, mieszana, extglob `!(…)`, ścieżki z `\`, dotfile'e).
- Router/CLI/explain: wszystkie istniejące testy przechodzą bez modyfikacji asercji (poza usunięciem `unmatchedFilesPolicy` z fixture'ów).
- Opcjonalnie: prosty test wydajności nie jest potrzebny — wystarczy w opisie PR zmierzony czas przed/po (skrypt jak w „Kontekście”, pkt 3).

## Weryfikacja

- `npm run typecheck`, `npm run build`, `npm test`.
- `node dist/cli.js --explain-routing --base main` i `--json` dają identyczny output przed i po (porównaj `diff`).

## Kryteria akceptacji

- Brak martwego kodu w routerze; `unmatchedFilesPolicy` usunięte (lub zdeprecjonowane wg decyzji).
- Każda lista wzorców kompilowana raz na wywołanie routingu/wykluczania/wyjaśniania.
- Zero zmian zachowania CLI (ten sam routing, ten sam tekst i JSON `--explain-routing`).
- Najlepiej 2 PR-y: (1) martwy kod + `unmatchedFilesPolicy` + `uniqueSorted`, (2) `compileGlobs`.

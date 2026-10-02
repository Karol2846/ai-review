# Plan: wspólna lista rozszerzeń i pełniejsze pokrycie plików z kodem w domyślnym routingu

> **Zanim zaczniesz:** plan zakłada, że na `main` są już
> [#21](https://github.com/Karol2846/ai-review/pull/21) (`TEST_FILE_GLOBS`, testy tylko do `tester`, zawężony `architect`)
> i [#22](https://github.com/Karol2846/ai-review/pull/22) (`--explain-routing`). Jeśli nie są — poczekaj albo zacznij od ich gałęzi.
> Sekcja „Pytania do właściciela” musi zostać rozstrzygnięta przed implementacją (zapytaj użytkownika).

## Kontekst

Domyślny routing (`src/defaultConfig.ts`) ma dwa problemy.

**1. Lista rozszerzeń jest wklejona ręcznie kilkanaście razy.** `{ts,tsx,js,jsx,java,kt,groovy,go,py}` powtarza się w każdym globie każdego agenta (a po #21 także w `TEST_FILE_GLOBS`). Dodanie jednego języka = edycja kilkunastu stringów; łatwo pominąć jeden i dostać niespójny routing (np. `tester` widzi `.mjs`, a `clean-coder` nie).

**2. Spore klasy plików z kodem nie trafiają do żadnego agenta.** `clean-coder` łapie kod tylko pod `src/`, `lib/`, `app/` i `packages/*/src/`. Sprawdzone na `main` (`findUnroutedFiles` z domyślnym configiem) — **nikt nie review'uje**:

| Plik | Dlaczego |
|---|---|
| `cmd/server/main.go`, `internal/order/service.go`, `pkg/client/http.go` | standardowy layout Go (`cmd/`, `internal/`, `pkg/`) — brak katalogu `src/` |
| `mypkg/core.py` | pakiet Pythona w korzeniu repo |
| `scripts/build.mjs`, `src/index.mts` | brak `mjs`/`cjs`/`mts`/`cts` na liście rozszerzeń |
| `src/App.vue` (`.svelte` analogicznie) | brak SFC |
| `src/Order.cs`, `src/lib.rs`, `app/models/order.rb`, `src/Order.scala` | brak tych języków |
| `index.ts` w korzeniu repo | poza `src/`/`lib/`/`app/` |

Od #18 takie pliki są przynajmniej wypisywane na stderr („Not reviewed …”), a od #22 `ai-review --explain-routing` pokazuje dlaczego — ale dalej nikt ich nie przegląda.

**Ważne ograniczenie:** instrukcje agentów (`agents/*.agent.md`) są pisane pod **Java 17+/Spring Boot/Groovy-Spock** (sekcje „Stack: …”). Wysłanie im pliku `.rs` czy `.cs` zadziała technicznie, ale jakość review jest niepewna, a każdy plik to dodatkowe wywołanie LLM.

## Cel

1. Jedno źródło prawdy dla rozszerzeń „plików z kodem” w `src/defaultConfig.ts`; wszystkie globy budowane z niego.
2. `clean-coder` dostaje każdy plik z kodem (wg rozszerzenia), niezależnie od katalogu — z wyjątkiem testów (#21), plików generowanych/zbudowanych i vendorowanych.
3. Rozszerzenie listy języków zgodnie z decyzją właściciela (patrz pytania).

## Poza zakresem

- Zmiana treści instrukcji agentów pod inne stacki (osobny temat; patrz pytanie 2).
- Routing plików konfiguracyjnych/Dockerfile/CI — świadomie nie są review'owane (decyzja z #18).
- Zmiany w semantyce globów (`src/globMatch.ts`) — tylko konfiguracja.

## Pytania do właściciela (rozstrzygnąć przed kodem)

1. **Zakres `clean-coder`: katalogi czy rozszerzenia?**
   *Rekomendacja:* rozszerzenia — `**/*.{CODE}` minus testy, minus `**/{dist,build,out,target,node_modules,vendor,third_party,generated}/**`, `**/*.min.js`, `**/*.d.ts`, `**/*.generated.*`. Naprawia Go/Python/root-level jednym ruchem. Koszt: więcej plików w review (skrypty, `*.config.ts`).
   *Alternatywa:* dopisać katalogi (`cmd`, `internal`, `pkg`, `scripts`, …) — bardziej zachowawcze, ale wiecznie niekompletne.
2. **Które języki dodać?**
   *Rekomendacja:* (a) od razu warianty już obsługiwanych języków: `mjs`, `cjs`, `mts`, `cts`, `vue`, `svelte`, `kts` (Kotlin script poza `build.gradle.kts`); (b) nowe języki (`cs`, `rs`, `rb`, `php`, `scala`, `swift`) **tylko** jeśli właściciel akceptuje, że prompty są Java-centryczne — inaczej zostawić je jako „not reviewed” (widoczne dzięki #18) i dodać razem z przepisaniem instrukcji agentów.
3. **Czy `*.d.ts` i `*.config.{js,ts}` mają iść do `clean-coder`?** *Rekomendacja:* `*.d.ts` — nie; `*.config.*` — tak (to kod), `tester` i tak dostaje configi frameworków testowych.

## Decyzje projektowe (po odpowiedziach — uzupełnij)

- Stałe w `src/defaultConfig.ts` (nieeksportowane, chyba że testy potrzebują):
  - `CODE_EXTENSIONS: readonly string[]` — lista rozszerzeń bez kropek, jedno źródło prawdy.
  - helper `codeGlob(prefix: string): string` → `` `${prefix}*.{${CODE_EXTENSIONS.join(",")}}` `` (uwaga: dla jednego elementu brace expansion `{ts}` też działa w micromatch, ale lepiej nie generować pustej listy).
  - `NON_SOURCE_GLOBS` — katalogi/pliki budowane, vendorowane i generowane (pyt. 1), dodawane jako negacje tak jak `TEST_FILE_GLOBS` w `excludingTestFiles`.
- Konfiguracja (`ai-review.json`, `exclude`) **nie zmienia się** — to wyłącznie zmiana domyślnych globów.
- `architect`/`ddd-reviewer`/`performance` dalej katalogowo/nazwowo (są specjalistami), ale ich rozszerzenia też z `CODE_EXTENSIONS`. Pliki `yml/yaml/json/properties` u `architect` zostają jako osobna lista.

## Kroki implementacji

1. `src/defaultConfig.ts`
   - Dodaj `CODE_EXTENSIONS` i helper(y); przepisz **wszystkie** globy (łącznie z `TEST_FILE_GLOBS`) na budowane z helpera. Wynik ma być semantycznie równy obecnemu dla obecnych rozszerzeń.
   - Commit 1 (czysty refaktor): tylko podmiana na stałą — **zero zmian zachowania** (test w kroku 3 to pilnuje).
   - Commit 2: nowy kształt `clean-coder` (pyt. 1) + `NON_SOURCE_GLOBS` + nowe rozszerzenia (pyt. 2/3).
2. `src/contextBuilder.ts` — sprawdź, czy `UNSUPPORTED_EXTENSIONS` nie koliduje z nowymi rozszerzeniami (nie powinno — to lista binarek).
3. Testy (`test/default-config.test.ts`, istnieje od #21):
   - Test „refaktor bez zmian”: przed commitem 1 zrzuć wynik `explainRouting` dla zestawu ścieżek z obecnych testów i porównaj po refaktorze (albo po prostu: wszystkie istniejące testy przechodzą bez modyfikacji).
   - Nowe przypadki: wszystkie pliki z tabeli w „Kontekście” trafiają do `clean-coder` (w zakresie zatwierdzonych języków); `dist/app.js`, `vendor/x.go`, `src/types.d.ts`, `src/api.generated.ts`, `app.min.js` — nie trafiają; testy nadal tylko do `tester`.
   - Test spójności: każdy glob w `defaultRoutingConfig` zawierający listę rozszerzeń zawiera **wszystkie** `CODE_EXTENSIONS` (łapie przyszłe ręczne wklejki).
4. Dokumentacja
   - `README.md`: sekcja „Agents” — jedno zdanie, które pliki dostaje `clean-coder`; lista obsługiwanych rozszerzeń.
   - `CLAUDE.md`: akapit „Routing and configuration” — `CODE_EXTENSIONS` jako źródło prawdy.

## Weryfikacja

- `npm run typecheck`, `npm run build`, `npm test`.
- `node dist/cli.js --explain-routing --base main` na tym repo oraz na sztucznym repo z layoutem Go (`git init`, kilka plików w `cmd/`, `internal/`, `pkg/`) — wszystkie pliki `.go` (poza `*_test.go`) idą do `clean-coder`.

## Kryteria akceptacji

- Lista rozszerzeń występuje w `src/defaultConfig.ts` dokładnie raz.
- Żaden plik z tabeli „Kontekst” (dla zatwierdzonych języków) nie ląduje w „Not reviewed”.
- Pliki budowane/vendorowane/generowane nie trafiają do agentów.
- Osobne PR-y (lub co najmniej osobne commity): refaktor bez zmian zachowania vs. zmiana pokrycia.

## Ryzyka

- **Koszt:** szerszy `clean-coder` = więcej wywołań LLM na dużych diffach. Złagodzenie: `exclude` w `ai-review.json`, `--explain-routing` do podglądu.
- **Jakość dla nie-JVM języków** — patrz pytanie 2.
- **Fałszywe trafienia `NON_SOURCE_GLOBS`** (np. katalog `build/` z kodem źródłowym w niektórych projektach). Użytkownik może je obejść przez `"replace": true` dla `clean-coder` — opisać w README.

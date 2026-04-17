# Plan Migracji: ai-review (Bash ➔ TypeScript / Node.js)

**Cel główny:** Przepisanie narzędzia na TypeScript, wyeliminowanie zależności od plików tymczasowych i skryptów bashowych (`jq`, `parallel`) oraz drastyczna redukcja zużycia tokenów poprzez grupowanie (batching) i inteligentny routing plików do agentów.

## Faza 1: Fundamenty Projektu i Narzędzia (Setup)
*Celem tej fazy jest przygotowanie środowiska TS oraz podstawowych funkcji komunikujących się z systemem.*

* **Zadanie 1.1: Inicjalizacja projektu Node.js**
    * Utworzenie `package.json` w głównym katalogu projektu.
    * Instalacja zależności: `typescript`, `@types/node`, `execa` (do wywoływania procesów), `chalk` (do kolorowania konsoli), `minimatch` lub `micromatch` (do obsługi wzorców plików), `p-map` (do kontroli zrównoleglenia).
    * Konfiguracja `tsconfig.json` (target: ES2022, module: CommonJS lub ESM).
* **Zadanie 1.2: Serwis Git (`src/git.ts`)**
    * Napisanie funkcji `getMergeBase(baseBranch: string): Promise<string>`.
    * Napisanie funkcji `getChangedFiles(mergeBase: string): Promise<string[]>`.
    * Napisanie funkcji `getFileDiff(commitSha: string, filePath: string): Promise<string>`.
* **Zadanie 1.3: Serwis Copilot (`src/copilot.ts`)**
    * Napisanie adaptera, który używa `execa` do wywołania `copilot -p "<prompt>" -s`.
    * Dodanie obsługi błędów (np. gdy Copilot CLI wyrzuci błąd lub użytkownik nie jest zalogowany).

## Faza 2: Inteligentny Routing i Konfiguracja
*Wdrożenie logiki przypisującej konkretne pliki do konkretnych agentów bez użycia AI.*

* **Zadanie 2.1: Domyślna konfiguracja**
    * Utworzenie pliku `src/defaultConfig.ts`.
    * Zdefiniowanie domyślnego mapowania (obiekt, gdzie kluczem jest nazwa agenta, a wartością tablica wzorców glob).
* **Zadanie 2.2: Wczytywanie konfiguracji użytkownika (`.ai-reviewrc.json`)**
    * Napisanie modułu `src/config.ts`, który szuka pliku konfiguracyjnego w korzeniu sprawdzanego repozytorium.
    * Scalenie (deep merge) reguł z pliku użytkownika z domyślną konfiguracją.
* **Zadanie 2.3: Silnik Routingu (`src/router.ts`)**
    * Napisanie funkcji `routeFilesToAgents(changedFiles, config)`.
    * Zwrócenie przypisań w formacie `Map<AgentName, string[]>`.

## Faza 3: Paczkowanie (Batching) i Prompty
*Kluczowy krok dla oszczędności tokenów: pakowanie plików w paczki.*

* **Zadanie 3.1: Algorytm paczkowania (`src/batcher.ts`)**
    * Napisanie funkcji `createBatches(files, diffSizes, maxLinesPerBatch)`.
    * Podział plików tak, aby jedna paczka nie przekroczyła ustalonego limitu wielkości diffa (np. 500 linii).
* **Zadanie 3.2: Generator Promptów (`src/promptBuilder.ts`)**
    * Napisanie funkcji łączącej instrukcję agenta z treścią przydzielonych mu diffów.
    * Wyraźne oddzielanie plików w prompcie znacznikami (np. `=== DIFF: src/path.ts ===`).

## Faza 4: Orkiestracja i Agregacja
*Zastąpienie skryptów `analyze.sh` i `aggregate.sh`.*

* **Zadanie 4.1: Asynchroniczny Runner (`src/runner.ts`)**
    * Przekształcenie paczek na "Zadania" i uruchomienie ich przez `p-map` (z zachowaniem np. `concurrency: 5`).
* **Zadanie 4.2: Bezpieczne parsowanie JSON**
    * Ekstrakcja struktury JSON z surowej odpowiedzi modelu (odporność na formatowanie markdown).
* **Zadanie 4.3: Agregator w pamięci (`src/aggregator.ts`)**
    * Zebranie odpowiedzi, wygenerowanie `fingerprint` dla deduplikacji.
    * Posortowanie po priorytecie (critical -> warning -> info) i numerze linii.

## Faza 5: Wyjście i CLI
*Zastąpienie skryptu głównego `ai-review` oraz skryptów raportujących.*

* **Zadanie 5.1: Parser Argumentów CLI**
    * Wdrożenie parsera (np. `commander`) dla flag `--report`, `--clean`, `--base`, `--agents`, `--debug`.
* **Zadanie 5.2: Kolorowy Raport w Terminalu (`src/reporter.ts`)**
    * Odtworzenie i ulepszenie formatowania za pomocą biblioteki `chalk`.
* **Zadanie 5.3: Annotator (Komentarze TODO) (`src/annotator.ts`)**
    * `applyAnnotations`: wstawianie komentarzy w plikach źródłowych z zachowaniem poprawnych prefixów zależnych od rozszerzenia.
    * `cleanAnnotations`: skanowanie plików i usuwanie starych znaczników `[ai-review]`.

## Faza 6: Integracja i Sprzątanie
*Końcowe poprawki ułatwiające dystrybucję.*

* **Zadanie 6.1: Składanie flow w `src/index.ts`**
    * Połączenie wszystkich modułów: Parse Args -> Git Diff -> Router -> Batcher -> Runner -> Aggregator -> Output.
* **Zadanie 6.2: Budowanie i instalacja**
    * Dodanie skryptu w `package.json` kompilującego projekt do pojedynczego pliku wykonywalnego (np. używając `esbuild`).
    * Aktualizacja instalatora instalującego wersję TS.
* **Zadanie 6.3: Sprzątanie starych plików**
    * Usunięcie katalogu `bin/` wraz ze starymi skryptami Bash.
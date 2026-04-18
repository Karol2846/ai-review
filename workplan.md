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

## Faza 3: Zbieranie Pełnego Kontekstu i Paczkowanie (Batching)
*Kluczowy krok dla jakości AI: Agent musi widzieć PEŁEN kod zmienianego pliku, aby rozumieć zależności, a diff służy mu jedynie jako wskaźnik tego, co dokładnie ocenia.
Paczkowanie jest konieczne, aby optymalizować koszty.*

* **Zadanie 3.1: Ekstrakcja Kontekstu Hybrydowego (`src/contextBuilder.ts`)**
  * Napisanie funkcji pobierającej dla każdego zmienionego pliku:
    1. Pełną zawartość pliku z dysku (stan po zmianach).
    2. Wyizolowany Diff dla tego konkretnego pliku (jako mapa zmian).
* **Zadanie 3.2: Algorytm paczkowania z limitem tokenów (`src/batcher.ts`)**
  * Napisanie funkcji `createBatches(routedFiles, maxCharLimit)`.
  * Ponieważ wysyłamy pełne pliki, paczkowanie musi opierać się na przybliżonym rozmiarze plików (np. max 30 000 znaków na paczkę), a nie na ilości linii diffa.
  * Zabezpieczenie przed gigantycznymi plikami (jeśli jeden plik przekracza limit, musi iść w oddzielnym prompcie).
* **Zadanie 3.3: Generator Promptów (`src/promptBuilder.ts`)**
  * Zbudowanie ustrukturyzowanego prompta dla paczki, wyraźnie separującego pliki.
  * Struktura powinna wyglądać następująco:
    1. [Instrukcja systemowa Agenta]
    2. "Oto pliki do weryfikacji wraz z ich pełnym kontekstem i listą zmian:"
    3. Dla każdego pliku w paczce:
       `<file path="src/...">`
       `<full_content>...cały plik...</full_content>`
       `<git_diff>...tylko zmiany...</git_diff>`
       `</file>`

## Faza 4: Orkiestracja i Agregacja
*Zastąpienie skryptów `analyze.sh` i `aggregate.sh` solidnym mechanizmem w Node.js.*

* **Zadanie 4.1: Asynchroniczny Runner (`src/runner.ts`)**
  * Przekształcenie paczek na "Zadania" i uruchomienie ich przez `p-map` (np. `concurrency: 5`, aby nie zabić rate-limitów Copilota).
  * Dodanie retry-mechanizmu w przypadku błędów API lub timeoutów.
* **Zadanie 4.2: Odporne parsowanie wyjścia JSON**
  * Ekstrakcja struktury JSON z surowej odpowiedzi modelu (odporność na halucynacje, formatowanie markdown ` ```json ` lub dodatkowy tekst generowany przez model).
* **Zadanie 4.3: Agregator w pamięci (`src/aggregator.ts`)**
  * Zebranie wszystkich odpowiedzi od agentów.
  * Wygenerowanie unikalnego `fingerprint` (plik + linia + kategoria) dla deduplikacji.
  * Posortowanie po priorytecie (critical -> warning -> info) i numerze linii.

## Faza 5: Wyjście i CLI
*Zastąpienie skryptu głównego `ai-review` oraz skryptów raportujących.*

* **Zadanie 5.1: Parser Argumentów CLI**
  * Wdrożenie parsera (np. wbudowane `util.parseArgs` w Node lub `commander`) dla flag `--report`, `--clean`, `--base`, `--agents`, `--debug`.
* **Zadanie 5.2: Kolorowy Raport w Terminalu (`src/reporter.ts`)**
  * Odtworzenie i ulepszenie czytelności formatowania (użycie `chalk` do kolorowania severity).
* **Zadanie 5.3: Annotator (Komentarze TODO w kodzie) (`src/annotator.ts`)**
  * `applyAnnotations`: inteligentne wstawianie komentarzy nad odpowiednią linią z zachowaniem właściwych prefixów (np. `//` dla TS/Java, `#` dla YAML).
  * `cleanAnnotations`: regexowe skanowanie plików i usuwanie starych znaczników `[ai-review]`.

## Faza 6: Integracja i CLI
*Końcowe poprawki ułatwiające dystrybucję i odcięcie się od Basha.*

* **Zadanie 6.1: Składanie głównego Pipeline (`src/index.ts`)**
  * Integracja: Parse Args ➔ Git Diff ➔ Router (Heurystyki) ➔ Context & Batcher ➔ Runner ➔ Aggregator ➔ Annotator/Reporter.
* **Zadanie 6.2: Budowanie (Build Step)**
  * Skonfigurowanie bundlera (np. `esbuild` lub po prostu kompilacja `tsc`), aby aplikacja działała jako szybki skrypt CLI (z dodaniem `#!/usr/bin/env node`).
* **Zadanie 6.3: Sprzątanie repozytorium**
  * Usunięcie katalogu `bin/` wraz ze starymi skryptami Bash.
  * Aktualizacja `install.sh` / `README.md`, aby odzwierciedlały użycie Node.js.
# Ocena trudności: Odłączenie od GitHub Copilot CLI → wsparcie dowolnego LLM

## TL;DR

**Trudność: ŁATWA (2–4h roboty).** Architektura jest już prawie gotowa. Coupling z Copilotem to **1 plik, 1 funkcja, 73 linie kodu**. Lokalna Ollama czy zdalny serwer — to ta sama zmiana, różnica to tylko URL.

---

## Analiza obecnego stanu

### Punkt styku z Copilotem

Cała komunikacja z LLM-em przechodzi przez **jedną** funkcję:

```
copilot.ts:52 → execa("copilot", ["-p", prompt, "-s"])
```

Kontrakt: `(prompt: string) → Promise<string>` — wysyłasz tekst, dostajesz tekst.

### Mapa zależności LLM

```
copilot.ts          ← jedyny plik rozmawiający z LLM
  ↑
runner.ts           ← jedyny konsument copilot.ts (import runCopilotPrompt)
  ↑
reviewPipeline.ts   ← orchestrator (nie wie o LLM bezpośrednio)
  ↑
cli.ts              ← entry point
```

### Co jest już LLM-agnostyczne (nie wymaga zmian)

| Moduł | Rola | Wymaga zmian? |
|---|---|---|
| `promptBuilder.ts` | Buduje prompt tekstowy (markdown-like) | ❌ — generyczny tekst |
| `responseParser.ts` | Parsuje JSON z surowego tekstu | ❌ — ma już fallbacki |
| `aggregator.ts` | Filtruje/deduplikuje findingi | ❌ |
| `batcher.ts` | Dzieli pliki na batche | ❌ |
| `contextBuilder.ts` | Czyta pliki + diff | ❌ |
| `router.ts` | Przypisuje pliki do agentów | ❌ |
| `annotator.ts` | Wstawia TODO komentarze | ❌ |
| `reporter.ts` | Drukuje raport w terminalu | ❌ |
| `config.ts` | Ładuje `.ai-reviewrc.json` | ❌ (rozszerzymy o pole `provider`) |

---

## Co trzeba zrobić

### Krok 1: Interfejs `LlmProvider`

```typescript
interface LlmProvider {
  sendPrompt(prompt: string): Promise<string>;
}
```

### Krok 2: `CopilotProvider` (opakowuje istniejący `copilot.ts`)

Bez zmian w logice — tylko refactor do klasy/obiektu spełniającego interfejs.

### Krok 3: `OllamaProvider`

HTTP POST na Ollama API (`/api/generate`):

```json
{
  "model": "gemma3:27b",
  "prompt": "...(cały prompt jak do Copilota)...",
  "stream": false
}
```

Node 18+ ma natywny `fetch` — **zero nowych zależności**.

### Krok 4: Inject provider do `runner.ts`

Obecnie `runner.ts` hard-importuje `runCopilotPrompt`. Zmiana: `runAgentBatches` przyjmuje `LlmProvider` jako argument.

### Krok 5: CLI flag lub config

- `--provider ollama` / `--provider copilot` (domyślnie copilot)
- `--model gemma3:27b` — nazwa modelu w Ollama
- `--api-url http://localhost:11434` — URL serwera (lokalny lub zdalny)
- Lub w `.ai-reviewrc.json`:
  ```json
  {
    "provider": "ollama",
    "ollamaModel": "gemma3:27b",
    "ollamaUrl": "http://localhost:11434"
  }
  ```

---

## Lokalna Ollama vs zdalny serwer — co się zmienia?

### Krótka odpowiedź: **prawie nic**

Ollama API jest identyczne niezależnie od tego, czy serwer stoi na `localhost:11434` czy na `gpu-beast.mycompany.com:11434`. Z perspektywy kodu to **ten sam `fetch()`**, różni się tylko URL.

```
Lokalna:  fetch("http://localhost:11434/api/generate", ...)
Zdalna:   fetch("https://gpu-server.example.com:11434/api/generate", ...)
```

### Co **dodaje** scenariusz zdalny

| Kwestia | Lokalna Ollama | Zdalna Ollama / własny serwer | Wpływ na kod |
|---|---|---|---|
| URL | Hardcoded `localhost:11434` | Konfigurowalny | Minimalne — parametr `--api-url` |
| Autentykacja | Brak (localhost) | Może wymagać API key / bearer token | Mały — opcjonalny header `Authorization` |
| HTTPS / TLS | Niepotrzebne | Prawdopodobnie tak, mogą być self-signed certy | Mały — opcja `--tls-reject-unauthorized false` lub env var |
| Timeouty | Milisekundy latencji | Wyższe latencje sieciowe | Mały — konfigurowalny `--timeout` (np. 120s) |
| Retry | Przy crashu modelu | + problemy sieciowe (DNS, timeout, 502) | Minimalne — retry logic już istnieje w `runner.ts` |
| Bezpieczeństwo kodu | Kod nie opuszcza maszyny | Kod leci przez sieć | Brak wpływu na kod — to kwestia decyzji usera |

### Dodatkowe parametry konfiguracji (mały nakład)

```typescript
interface OllamaProviderConfig {
  readonly url: string;              // http://localhost:11434 (domyślny)
  readonly model: string;            // gemma3:27b
  readonly apiKey?: string;          // opcjonalny Bearer token
  readonly timeoutMs?: number;       // domyślnie 120_000 (2 min)
  readonly tlsRejectUnauthorized?: boolean; // domyślnie true
}
```

CLI:
```bash
# Lokalna Ollama
ai-review --provider ollama --model gemma3:27b

# Zdalna Ollama
ai-review --provider ollama --model gemma3:27b \
          --api-url https://gpu-server.example.com:11434 \
          --api-key sk-my-secret-key

# Zdalny własny serwer (OpenAI-compatible API)
ai-review --provider openai-compat \
          --api-url https://my-llm.internal.company.com/v1 \
          --api-key sk-my-key \
          --model my-fine-tuned-reviewer
```

### Bonus: OpenAI-compatible provider

Wiele self-hosted LLM-ów (vLLM, text-generation-inference, LM Studio, LocalAI) wystawia **OpenAI-compatible API**. Jeden dodatkowy provider pokryłby je wszystkie:

```typescript
// POST /v1/chat/completions
{
  "model": "gemma3:27b",
  "messages": [{ "role": "user", "content": "...(prompt)..." }],
  "temperature": 0.1
}
```

To +50 linii kodu, ale daje kompatybilność z każdym serwisem który mówi "OpenAI API".

---

## Ryzyka i wyzwania

### 1. Jakość odpowiedzi lokalnych/zdalnych modeli (ŚREDNIE ryzyko)

Copilot (GPT-4/Claude za fasadą) doskonale trzyma się formatu JSON. Mniejsze lokalne modele mogą:
- Wygenerować markdown zamiast czystego JSON
- Dodać komentarze przed/po tablicy
- Zwrócić niepełny JSON

**Mitygacja:** `responseParser.ts` **już** obsługuje te przypadki — szuka JSON wewnątrz code-fence'ów, wyciąga tablice z tekstu, fallbackuje na `[]`. To największa siła obecnej architektury.

### 2. Okno kontekstu (NISKIE ryzyko)

Obecny `maxCharLimit = 14_000` znaków — to ok. 3.5K tokenów. Nawet małe modele (8B) mają 8K+ okno. Gemma 3 27B ma 128K. Nie powinno być problemem.

### 3. Czas odpowiedzi (NISKIE → ŚREDNIE ryzyko przy zdalnym serwerze)

- Lokalna Ollama na GPU: sekundy
- Zdalna Ollama / własny serwer: zależy od sieci i obciążenia
- `pMap` z concurrency już obsługuje paralelizm
- **Potrzebny:** konfigurowalny timeout (domyślnie 2 min zamiast domyślnego fetch timeout)

### 4. Autentykacja na zdalnym serwerze (NISKIE ryzyko)

Opcjonalny `Authorization: Bearer <key>` header. Jeden `if` w providerze. API key z CLI flaga, env var, lub config.

### 5. TLS / self-signed certs (NISKIE ryzyko)

Wewnętrzne serwery firmowe często mają self-signed certy. Rozwiązanie: env var `NODE_TLS_REJECT_UNAUTHORIZED=0` lub dedykowana flaga. Standardowa praktyka Node.js.

### 6. Zero nowych zależności (BRAK ryzyka)

Ollama API i OpenAI API to prosty REST. Node 18+ `fetch` wystarczy. Nic nie trzeba doinstalowywać.

---

## Estymacja nakładu pracy

| Zadanie | Estymowany wysiłek |
|---|---|
| Interfejs `LlmProvider` + refactor `runner.ts` | Mały |
| `CopilotProvider` (opakowanie istniejącego kodu) | Mały |
| `OllamaProvider` (HTTP fetch, konfigurowalne URL/auth/timeout) | Mały |
| `OpenAiCompatProvider` (opcjonalny bonus) | Mały |
| CLI flags / config rozszerzenie | Mały |
| Testy jednostkowe nowych providerów | Mały-Średni |
| Testy integracyjne (manual z lokalną/zdalną Ollamą) | Średni |
| **ŁĄCZNIE** | **Łatwe zadanie** |

## Podsumowanie

Architektura jest **czysta i dobrze sfaktoryzowana**. Coupling z Copilotem to dosłownie jedna linia `execa("copilot", ...)`. Reszta pipeline'u jest już LLM-agnostyczna.

**Lokalna vs zdalna Ollama — z perspektywy kodu to ta sama zmiana.** Różnica to konfiguracja: URL, opcjonalny API key, timeout. Dodatkowy nakład na obsługę zdalnego serwera to ~20 linii kodu (auth header + timeout + TLS config).

Jeśli chcesz maksymalnej elastyczności, warto od razu dodać `OpenAiCompatProvider` (+50 linii) — pokryje nie tylko Ollamę, ale też vLLM, text-generation-inference, LM Studio, i każdy serwis z OpenAI-compatible API.

Jedynym realnym wyzwaniem jest jakość outputu lokalnych modeli, ale `responseParser.ts` jest na to przygotowany.

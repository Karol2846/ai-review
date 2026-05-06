import { LlmProviderError, type LlmProvider } from "./llmProvider";

//TODO: wokr started - prompt:
// Hej, w tym projekcie mam @src\ollamaProvider.ts - ten plik służy do komunikacji z lokalną ollamą,
// ale myślę że lepiej przejść na model chmurowy - qwen3-coder:480b-cloud. api_key mam z zmiennej
// środowiskowej OLLAMA_API_KEY. Zadaj mi szczegółowe pytania na temat migracji z lokalnej ollamy na chmurowy model

export interface OllamaProviderConfig {
  readonly url?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

interface OllamaGenerateResponse {
  readonly response?: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3.6:27b";

function validateStringField(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LlmProviderError("COMMAND_FAILED", `"${fieldName}" must not be empty.`);
  }
  return trimmed;
}

export function normalizeOllamaUrl(url: string): string {
  const trimmed = validateStringField(url, "url");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LlmProviderError("COMMAND_FAILED", `Invalid Ollama URL: "${trimmed}".`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LlmProviderError(
      "COMMAND_FAILED",
      `Invalid Ollama URL protocol "${parsed.protocol}". Expected http or https.`
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/+$/u, "");
}

function buildGenerateEndpoint(baseUrl: string): string {
  return `${baseUrl}/api/generate`;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LlmProviderError(
      "COMMAND_FAILED",
      `"timeoutMs" must be a positive finite number. Received: ${timeoutMs}`
    );
  }

  return timeoutMs;
}

function toStatusFailure(status: number, statusText: string): LlmProviderError {
  const detail = statusText.trim().length > 0 ? `${status} ${statusText}` : `${status}`;

  if (status === 401 || status === 403) {
    return new LlmProviderError("NOT_AUTHENTICATED", `Ollama request was not authenticated (${detail}).`);
  }

  if (status === 429) {
    return new LlmProviderError("RATE_LIMITED", `Ollama request was rate-limited (${detail}).`);
  }

  if (status >= 500) {
    return new LlmProviderError(
      "SERVICE_UNAVAILABLE",
      `Ollama service is unavailable or failing (${detail}).`
    );
  }

  return new LlmProviderError("COMMAND_FAILED", `Ollama request failed (${detail}).`);
}

function isAbortLikeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function parseOllamaResponseText(rawBody: string): string {
  let parsed: OllamaGenerateResponse;
  try {
    parsed = JSON.parse(rawBody) as OllamaGenerateResponse;
  } catch {
    throw new LlmProviderError("COMMAND_FAILED", "Ollama returned a non-JSON response body.");
  }

  if (typeof parsed !== "object" || parsed === null || !("response" in parsed)) {
    throw new LlmProviderError("COMMAND_FAILED", 'Ollama response is missing required "response" field.');
  }

  if (typeof parsed.response !== "string") {
    throw new LlmProviderError("COMMAND_FAILED", 'Ollama response field "response" must be a string.');
  }

  return parsed.response;
}

export function createOllamaProvider(config: OllamaProviderConfig = {}): LlmProvider {
  const baseUrl = normalizeOllamaUrl(config.url ?? DEFAULT_OLLAMA_URL);
  const model = validateStringField(config.model ?? DEFAULT_OLLAMA_MODEL, "model");
  const timeoutMs = normalizeTimeout(config.timeoutMs);
  const endpoint = buildGenerateEndpoint(baseUrl);
  const apiKey = config.apiKey?.trim();

  return {
    async sendPrompt(prompt: string): Promise<string> {
      if (prompt.trim().length === 0) {
        throw new LlmProviderError("INVALID_PROMPT", "Ollama prompt must not be empty.");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw toStatusFailure(response.status, response.statusText);
        }

        const responseText = await response.text();
        return parseOllamaResponseText(responseText);
      } catch (error) {
        if (error instanceof LlmProviderError) {
          throw error;
        }

        if (isAbortLikeError(error)) {
          throw new LlmProviderError(
            "TIMEOUT",
            `Ollama request timed out after ${timeoutMs}ms while calling ${endpoint}.`
          );
        }

        const detail = error instanceof Error ? error.message : "Unknown network failure.";
        throw new LlmProviderError(
          "NETWORK_ERROR",
          `Failed to reach Ollama endpoint ${endpoint}: ${detail}`
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

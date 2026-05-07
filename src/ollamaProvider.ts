import { Ollama } from "ollama";

import { LlmProviderError, type LlmProvider } from "./llmProvider";

export interface OllamaProviderConfig {
  readonly apiKey?: string;
}

interface OllamaGenerateResponse {
  readonly response?: unknown;
}

interface OllamaResponseErrorShape {
  readonly status_code: number;
  readonly error?: unknown;
  readonly message?: unknown;
}

const OLLAMA_API_KEY_ENV = "OLLAMA_API_KEY";
const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_OLLAMA_URL = "https://ollama.com";
export const DEFAULT_OLLAMA_MODEL = "qwen3-coder:480b-cloud";

function validateStringField(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LlmProviderError("COMMAND_FAILED", `"${fieldName}" must not be empty.`);
  }
  return trimmed;
}

function resolveApiKey(configApiKey: string | undefined): string {
  if (configApiKey !== undefined) {
    return validateStringField(configApiKey, "apiKey");
  }

  const envValue = process.env[OLLAMA_API_KEY_ENV];
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim();
  }

  throw new LlmProviderError(
    "NOT_AUTHENTICATED",
    `Missing required environment variable "${OLLAMA_API_KEY_ENV}" for Ollama Cloud authentication.`
  );
}

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const upstreamSignal = init?.signal;
    const abortFromUpstream = () => {
      controller.abort();
    };

    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        controller.abort();
      } else {
        upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
      }
    }

    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
  };
}

function parseOllamaGenerateResponse(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || !("response" in raw)) {
    throw new LlmProviderError("COMMAND_FAILED", 'Ollama response is missing required "response" field.');
  }

  const response = (raw as OllamaGenerateResponse).response;
  if (typeof response !== "string") {
    throw new LlmProviderError("COMMAND_FAILED", 'Ollama response field "response" must be a string.');
  }

  return response;
}

function toStatusFailure(status: number, detailMessage: string | undefined): LlmProviderError {
  const normalizedDetail = detailMessage?.trim();
  const detail = normalizedDetail && normalizedDetail.length > 0 ? `${status}: ${normalizedDetail}` : `${status}`;

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

function isOllamaResponseError(error: unknown): error is OllamaResponseErrorShape {
  return (
    typeof error === "object" &&
    error !== null &&
    "status_code" in error &&
    typeof (error as { status_code?: unknown }).status_code === "number"
  );
}

function toResponseErrorMessage(error: OllamaResponseErrorShape): string | undefined {
  if (typeof error.error === "string" && error.error.trim().length > 0) {
    return error.error;
  }

  if (typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }

  return undefined;
}

export function createOllamaProvider(config: OllamaProviderConfig = {}): LlmProvider {
  const apiKey = resolveApiKey(config.apiKey);
  const client = new Ollama({
    host: DEFAULT_OLLAMA_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    fetch: createTimeoutFetch(DEFAULT_TIMEOUT_MS),
  });

  return {
    async sendPrompt(prompt: string): Promise<string> {
      if (prompt.trim().length === 0) {
        throw new LlmProviderError("INVALID_PROMPT", "Ollama prompt must not be empty.");
      }

      try {
        const response = await client.generate({
          model: DEFAULT_OLLAMA_MODEL,
          prompt,
          stream: false,
        });
        return parseOllamaGenerateResponse(response);
      } catch (error) {
        if (error instanceof LlmProviderError) {
          throw error;
        }

        if (isOllamaResponseError(error)) {
          throw toStatusFailure(error.status_code, toResponseErrorMessage(error));
        }

        if (isAbortLikeError(error)) {
          throw new LlmProviderError(
            "TIMEOUT",
            `Ollama request timed out after ${DEFAULT_TIMEOUT_MS}ms while calling ${DEFAULT_OLLAMA_URL}.`
          );
        }

        const detail = error instanceof Error ? error.message : "Unknown network failure.";
        throw new LlmProviderError("NETWORK_ERROR", `Failed to reach Ollama endpoint ${DEFAULT_OLLAMA_URL}: ${detail}`);
      }
    },
  };
}

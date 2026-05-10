import { generateText, APICallError } from "ai";
import type { LanguageModel } from "ai";
import { LlmProviderError } from "./llmProvider";
import { parseModelResponse } from "./responseParser";
import type { Finding } from "./findingSchema";

export async function generateFindings(model: LanguageModel, prompt: string): Promise<Finding[]> {
  try {
    const result = await generateText({ model, prompt, maxRetries: 0 });
    const { findings } = parseModelResponse(result.text);
    return findings;
  } catch (error) {
    throw mapSdkError(error);
  }
}

function mapSdkError(error: unknown): LlmProviderError {
  if (error instanceof APICallError) {
    const status = error.statusCode;
    if (status === 429) return new LlmProviderError("RATE_LIMITED", error.message);
    if (status === 401 || status === 403) return new LlmProviderError("NOT_AUTHENTICATED", error.message);
    if (status !== undefined && status >= 500) return new LlmProviderError("SERVICE_UNAVAILABLE", error.message);
    return new LlmProviderError("COMMAND_FAILED", error.message);
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (error.name === "AbortError" || msg.includes("aborted")) {
      return new LlmProviderError("TIMEOUT", error.message);
    }
    if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("econnrefused")) {
      return new LlmProviderError("NETWORK_ERROR", error.message);
    }
  }

  return new LlmProviderError("COMMAND_FAILED", String(error));
}

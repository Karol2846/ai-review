import { generateObject, APICallError, NoObjectGeneratedError, TypeValidationError } from "ai";
import type { LanguageModel } from "ai";
import { LlmProviderError } from "./llmProvider";
import { findingsSchema, type Finding } from "./findingSchema";

export async function generateFindings(model: LanguageModel, prompt: string): Promise<Finding[]> {
  try {
    const result = await generateObject({
      model,
      schema: findingsSchema,
      prompt,
      maxRetries: 0,
    });
    return result.object;
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

  if (error instanceof NoObjectGeneratedError || error instanceof TypeValidationError) {
    return new LlmProviderError("COMMAND_FAILED", (error as Error).message);
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

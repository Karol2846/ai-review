import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { LlmProviderError } from "./llmProvider";

export const PROVIDER_KINDS = ["openai-compatible", "anthropic", "google"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface LlmClientConfig {
  provider: ProviderKind;
  model: string;
  apiKeyEnv: string;
  baseURL?: string;
}

export function createLanguageModel(config: LlmClientConfig): LanguageModel {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new LlmProviderError(
      "NOT_AUTHENTICATED",
      `Environment variable ${config.apiKeyEnv} is not set`
    );
  }

  switch (config.provider) {
    case "openai-compatible":
      return createOpenAI({
        apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      })(config.model);

    case "anthropic":
      return createAnthropic({ apiKey })(config.model);

    case "google":
      return createGoogleGenerativeAI({ apiKey })(config.model);
  }
}

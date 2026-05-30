import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLanguageModel, type LlmClientConfig } from "../src/llmClient";
import { LlmProviderError } from "../src/llmProvider";

const TEST_ENV_VAR = "AI_REVIEW_TEST_KEY";

const baseConfig: LlmClientConfig = {
  provider: "openai-compatible",
  model: "gpt-4o",
  apiKeyEnv: TEST_ENV_VAR,
};

beforeEach(() => {
  process.env[TEST_ENV_VAR] = "test-key-value";
});

afterEach(() => {
  delete process.env[TEST_ENV_VAR];
});

describe("createLanguageModel", () => {
  it("throws NOT_AUTHENTICATED when env var is missing", () => {
    delete process.env[TEST_ENV_VAR];
    expect(() => createLanguageModel(baseConfig)).toThrow(LlmProviderError);
    try {
      createLanguageModel(baseConfig);
    } catch (e) {
      expect(e).toBeInstanceOf(LlmProviderError);
      expect((e as LlmProviderError).code).toBe("NOT_AUTHENTICATED");
      expect((e as LlmProviderError).message).toContain(TEST_ENV_VAR);
    }
  });

  it("returns a LanguageModel for openai-compatible", () => {
    const model = createLanguageModel(baseConfig);
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("returns a LanguageModel for openai-compatible with custom baseURL", () => {
    const model = createLanguageModel({
      ...baseConfig,
      baseURL: "https://api.groq.com/openai/v1",
    });
    expect(model).toBeDefined();
  });

  it("returns a LanguageModel for anthropic", () => {
    const model = createLanguageModel({ ...baseConfig, provider: "anthropic", model: "claude-3-5-haiku-20241022" });
    expect(model).toBeDefined();
  });

  it("returns a LanguageModel for google", () => {
    const model = createLanguageModel({ ...baseConfig, provider: "google", model: "gemini-2.0-flash" });
    expect(model).toBeDefined();
  });
});

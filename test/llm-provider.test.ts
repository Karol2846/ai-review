import { describe, expect, it } from "vitest";

import {
  LlmProviderError,
  isTransientLlmProviderError,
  isTransientLlmProviderErrorCode,
} from "../src/llmProvider";

describe("llmProvider", () => {
  it("classifies COMMAND_FAILED as transient", () => {
    expect(isTransientLlmProviderErrorCode("COMMAND_FAILED")).toBe(true);
    expect(isTransientLlmProviderError(new LlmProviderError("COMMAND_FAILED", "Temporary failure"))).toBe(
      true
    );
  });

  it("does not classify NOT_AUTHENTICATED as transient", () => {
    expect(isTransientLlmProviderErrorCode("NOT_AUTHENTICATED")).toBe(false);
    expect(
      isTransientLlmProviderError(new LlmProviderError("NOT_AUTHENTICATED", "Please login first"))
    ).toBe(false);
  });
});

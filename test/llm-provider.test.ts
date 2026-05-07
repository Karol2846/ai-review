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

  it("classifies RATE_LIMITED as transient", () => {
    expect(isTransientLlmProviderErrorCode("RATE_LIMITED")).toBe(true);
    expect(isTransientLlmProviderError(new LlmProviderError("RATE_LIMITED", "Too many requests"))).toBe(true);
  });

  it("classifies NETWORK_ERROR as transient", () => {
    expect(isTransientLlmProviderErrorCode("NETWORK_ERROR")).toBe(true);
    expect(isTransientLlmProviderError(new LlmProviderError("NETWORK_ERROR", "Connection lost"))).toBe(true);
  });

  it("classifies TIMEOUT as transient", () => {
    expect(isTransientLlmProviderErrorCode("TIMEOUT")).toBe(true);
    expect(isTransientLlmProviderError(new LlmProviderError("TIMEOUT", "Request timed out"))).toBe(true);
  });

  it("classifies SERVICE_UNAVAILABLE as transient", () => {
    expect(isTransientLlmProviderErrorCode("SERVICE_UNAVAILABLE")).toBe(true);
    expect(
      isTransientLlmProviderError(new LlmProviderError("SERVICE_UNAVAILABLE", "Service is down"))
    ).toBe(true);
  });

  it("does not classify INVALID_PROMPT as transient", () => {
    expect(isTransientLlmProviderErrorCode("INVALID_PROMPT")).toBe(false);
    expect(isTransientLlmProviderError(new LlmProviderError("INVALID_PROMPT", "Empty prompt"))).toBe(false);
  });

  it("does not classify COMMAND_NOT_FOUND as transient", () => {
    expect(isTransientLlmProviderErrorCode("COMMAND_NOT_FOUND")).toBe(false);
    expect(
      isTransientLlmProviderError(new LlmProviderError("COMMAND_NOT_FOUND", "Binary not found"))
    ).toBe(false);
  });

  it("returns false for non-LlmProviderError values", () => {
    expect(isTransientLlmProviderError(new Error("plain error"))).toBe(false);
    expect(isTransientLlmProviderError({ code: "COMMAND_FAILED" })).toBe(false);
    expect(isTransientLlmProviderError(null)).toBe(false);
    expect(isTransientLlmProviderError(undefined)).toBe(false);
  });
});

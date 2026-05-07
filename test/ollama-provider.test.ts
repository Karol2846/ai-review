import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateMock, ollamaCtorMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  ollamaCtorMock: vi.fn(),
}));

vi.mock("ollama", () => {
  class MockOllama {
    readonly generate = generateMock;

    constructor(config: unknown) {
      ollamaCtorMock(config);
    }
  }

  return {
    Ollama: MockOllama,
  };
});

import {
  createOllamaProvider,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
} from "../src/ollamaProvider";

const originalOllamaApiKey = process.env.OLLAMA_API_KEY;

beforeEach(() => {
  generateMock.mockReset();
  ollamaCtorMock.mockReset();
  process.env.OLLAMA_API_KEY = "env-key";
});

afterEach(() => {
  if (originalOllamaApiKey === undefined) {
    delete process.env.OLLAMA_API_KEY;
  } else {
    process.env.OLLAMA_API_KEY = originalOllamaApiKey;
  }
});

describe("createOllamaProvider", () => {
  it("applies cloud defaults and env API key", async () => {
    generateMock.mockResolvedValueOnce({ response: "Model answer" });

    const provider = createOllamaProvider({});

    await expect(provider.sendPrompt("Review this diff")).resolves.toBe("Model answer");
    expect(ollamaCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: DEFAULT_OLLAMA_URL,
        headers: {
          Authorization: "Bearer env-key",
        },
        fetch: expect.any(Function),
      })
    );
    expect(generateMock).toHaveBeenCalledWith({
      model: DEFAULT_OLLAMA_MODEL,
      prompt: "Review this diff",
      stream: false,
    });
  });

  it("prefers explicit config apiKey over environment value", async () => {
    generateMock.mockResolvedValueOnce({ response: "Model answer" });

    const provider = createOllamaProvider({
      apiKey: "config-key",
    });
    await expect(provider.sendPrompt("Prompt")).resolves.toBe("Model answer");

    expect(ollamaCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Authorization: "Bearer config-key",
        },
      })
    );
  });

  it("fails fast when OLLAMA_API_KEY is missing", () => {
    delete process.env.OLLAMA_API_KEY;

    expect(() => createOllamaProvider({})).toThrowError(
      expect.objectContaining({
        code: "NOT_AUTHENTICATED",
      })
    );
  });

  it("rejects non-cloud URL configuration", () => {
    expect(() =>
      createOllamaProvider({
        url: "http://localhost:11434",
      })
    ).toThrowError(
      expect.objectContaining({
        code: "COMMAND_FAILED",
        message: expect.stringContaining("Cloud-only mode is enabled"),
      })
    );
  });

  it("rejects non-cloud model configuration", () => {
    expect(() =>
      createOllamaProvider({
        model: "llama3.1",
      })
    ).toThrowError(
      expect.objectContaining({
        code: "COMMAND_FAILED",
        message: expect.stringContaining("Cloud-only mode is enabled"),
      })
    );
  });

  it("rejects empty prompts with INVALID_PROMPT", async () => {
    const provider = createOllamaProvider({});

    await expect(provider.sendPrompt("   ")).rejects.toMatchObject({
      code: "INVALID_PROMPT",
      message: "Ollama prompt must not be empty.",
    });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("maps request abort to TIMEOUT", async () => {
    generateMock.mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"));

    const provider = createOllamaProvider({
      timeoutMs: 10,
    });

    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("maps 401/403/429/5xx statuses to provider error codes", async () => {
    const provider = createOllamaProvider({});

    generateMock.mockRejectedValueOnce({ status_code: 401, error: "Unauthorized" });
    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });

    generateMock.mockRejectedValueOnce({ status_code: 403, error: "Forbidden" });
    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });

    generateMock.mockRejectedValueOnce({ status_code: 429, error: "Too Many Requests" });
    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({ code: "RATE_LIMITED" });

    generateMock.mockRejectedValueOnce({ status_code: 503, error: "Service Unavailable" });
    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("maps malformed response payload to COMMAND_FAILED", async () => {
    generateMock.mockResolvedValueOnce({ done: true });

    const provider = createOllamaProvider({});

    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: 'Ollama response is missing required "response" field.',
    });
  });

  it("maps non-string response field to COMMAND_FAILED", async () => {
    generateMock.mockResolvedValueOnce({ response: 123 });

    const provider = createOllamaProvider({});

    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: 'Ollama response field "response" must be a string.',
    });
  });

  it("maps network failures to NETWORK_ERROR", async () => {
    generateMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:443"));

    const provider = createOllamaProvider({});

    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });
});

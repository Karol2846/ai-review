import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOllamaProvider,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
} from "../src/providers/ollamaProvider";

type MockResponseInput = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly body: string;
};

function mockResponse(input: MockResponseInput): Response {
  return {
    ok: input.ok,
    status: input.status,
    statusText: input.statusText ?? "",
    text: async () => input.body,
  } as Response;
}

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOllamaProvider", () => {
  it("applies default URL and model when not provided", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ response: "Model answer" }),
      })
    );

    const provider = createOllamaProvider({});

    await expect(provider.sendPrompt("Review this diff")).resolves.toBe("Model answer");
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_OLLAMA_URL}/api/generate`,
      expect.objectContaining({
        body: JSON.stringify({
          model: DEFAULT_OLLAMA_MODEL,
          prompt: "Review this diff",
          stream: false,
        }),
      })
    );
  });

  it("returns generated response text on success", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ response: "Model answer" }),
      })
    );

    const provider = createOllamaProvider({
      url: "http://localhost:11434/",
      model: "llama3.1",
    });

    await expect(provider.sendPrompt("Review this diff")).resolves.toBe("Model answer");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/generate",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("rejects empty prompts with INVALID_PROMPT", async () => {
    const provider = createOllamaProvider({
      url: "http://localhost:11434",
      model: "llama3.1",
    });

    await expect(provider.sendPrompt("   ")).rejects.toMatchObject({
      code: "INVALID_PROMPT",
      message: "Ollama prompt must not be empty.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps request abort to TIMEOUT", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true }
        );
      });
    });

    const provider = createOllamaProvider({
      url: "http://localhost:11434",
      model: "llama3.1",
      timeoutMs: 10,
    });

    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("maps 401/403/429/5xx statuses to provider error codes", async () => {
    const provider = createOllamaProvider({
      url: "http://localhost:11434",
      model: "llama3.1",
    });

    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        body: "",
      })
    );
    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });

    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        body: "",
      })
    );
    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });

    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body: "",
      })
    );
    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({ code: "RATE_LIMITED" });

    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        body: "",
      })
    );
    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("maps malformed response payload to COMMAND_FAILED", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: "not-json",
      })
    );

    const provider = createOllamaProvider({
      url: "http://localhost:11434",
      model: "llama3.1",
    });

    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "Ollama returned a non-JSON response body.",
    });
  });

  it("maps network failures to NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:11434"));

    const provider = createOllamaProvider({
      url: "http://localhost:11434",
      model: "llama3.1",
    });

    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("maps JSON without response field to COMMAND_FAILED", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ done: true }),
      })
    );

    const provider = createOllamaProvider({
      url: "http://localhost:11434",
      model: "llama3.1",
    });

    await expect(provider.sendPrompt("Prompt")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: 'Ollama response is missing required "response" field.',
    });
  });
});

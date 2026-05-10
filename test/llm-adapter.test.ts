import { describe, it, expect } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { APICallError } from "ai";
import { generateFindings } from "../src/llmAdapter";
import { LlmProviderError } from "../src/llmProvider";
import type { Finding } from "../src/findingSchema";

const validFinding: Finding = {
  file: "src/foo.ts",
  line: 5,
  agent: "tester",
  severity: "warning",
  category: "missing-test",
  message: "No test for this function",
  suggestion: "Add a unit test",
};

function makeModel(doGenerate: () => Promise<unknown>) {
  return new MockLanguageModelV3({ doGenerate: doGenerate as MockLanguageModelV3["doGenerate"] });
}

function successModel(findings: Finding[]) {
  return makeModel(async () => ({
    rawCall: { rawPrompt: "", rawSettings: {} },
    finishReason: "stop" as const,
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
    content: [{ type: "text" as const, text: JSON.stringify({ findings }) }],
  }));
}

function apiErrorModel(statusCode: number) {
  return makeModel(async () => {
    throw new APICallError({
      message: `HTTP ${statusCode}`,
      url: "https://api.example.com",
      requestBodyValues: {},
      statusCode,
      responseHeaders: {},
      responseBody: "",
    });
  });
}

describe("generateFindings", () => {
  it("returns Finding[] on success", async () => {
    const findings = await generateFindings(successModel([validFinding]), "review this");
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/foo.ts");
    expect(findings[0].severity).toBe("warning");
  });

  it("returns empty array when model returns []", async () => {
    const findings = await generateFindings(successModel([]), "review this");
    expect(findings).toEqual([]);
  });

  it("maps 429 to RATE_LIMITED", async () => {
    await expect(generateFindings(apiErrorModel(429), "x")).rejects.toSatisfy(
      (e) => e instanceof LlmProviderError && e.code === "RATE_LIMITED"
    );
  });

  it("maps 401 to NOT_AUTHENTICATED", async () => {
    await expect(generateFindings(apiErrorModel(401), "x")).rejects.toSatisfy(
      (e) => e instanceof LlmProviderError && e.code === "NOT_AUTHENTICATED"
    );
  });

  it("maps 403 to NOT_AUTHENTICATED", async () => {
    await expect(generateFindings(apiErrorModel(403), "x")).rejects.toSatisfy(
      (e) => e instanceof LlmProviderError && e.code === "NOT_AUTHENTICATED"
    );
  });

  it("maps 500 to SERVICE_UNAVAILABLE", async () => {
    await expect(generateFindings(apiErrorModel(500), "x")).rejects.toSatisfy(
      (e) => e instanceof LlmProviderError && e.code === "SERVICE_UNAVAILABLE"
    );
  });

  it("maps 503 to SERVICE_UNAVAILABLE", async () => {
    await expect(generateFindings(apiErrorModel(503), "x")).rejects.toSatisfy(
      (e) => e instanceof LlmProviderError && e.code === "SERVICE_UNAVAILABLE"
    );
  });

  it("returns empty array when model output contains no valid findings", async () => {
    const badModel = makeModel(async () => ({
      rawCall: { rawPrompt: "", rawSettings: {} },
      finishReason: "stop" as const,
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      warnings: [],
      content: [{ type: "text" as const, text: JSON.stringify([{ notAFinding: true }]) }],
    }));
    await expect(generateFindings(badModel, "x")).resolves.toEqual([]);
  });

  it("maps abort error to TIMEOUT", async () => {
    const abortModel = makeModel(async () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    });
    await expect(generateFindings(abortModel, "x")).rejects.toSatisfy(
      (e) => e instanceof LlmProviderError && e.code === "TIMEOUT"
    );
  });

  it("maps fetch failure to NETWORK_ERROR", async () => {
    const networkModel = makeModel(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    await expect(generateFindings(networkModel, "x")).rejects.toSatisfy(
      (e) => e instanceof LlmProviderError && e.code === "NETWORK_ERROR"
    );
  });
});

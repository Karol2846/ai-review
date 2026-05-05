import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_INSTALL_PROVIDER,
  INSTALL_PROVIDER_CONFIG_FILE_NAME,
  getInstallProviderConfigPath,
  isInstallProviderType,
  parseInstallProviderConfig,
  parseInstallProviderConfigObject,
  resolveInstallProviderConfig,
} from "../src/installProviderConfig";

describe("installProviderConfig", () => {
  it("resolves config path relative to package install directory", () => {
    const moduleDir = resolve("tmp", "ai-review", "dist");
    const configPath = getInstallProviderConfigPath(moduleDir);

    expect(configPath).toBe(join(moduleDir, "..", INSTALL_PROVIDER_CONFIG_FILE_NAME));
  });

  it("accepts only supported provider values", () => {
    expect(isInstallProviderType("copilot")).toBe(true);
    expect(isInstallProviderType("ollama")).toBe(true);
    expect(isInstallProviderType("openai")).toBe(false);
    expect(isInstallProviderType(undefined)).toBe(false);
  });

  it("parses valid JSON config", () => {
    const result = parseInstallProviderConfig('{ "provider": "ollama" }');

    expect(result).toEqual({
      ok: true,
      config: {
        provider: "ollama",
      },
    });
  });

  it("reports INVALID_JSON for malformed JSON", () => {
    const result = parseInstallProviderConfig('{"provider":');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_JSON");
    }
  });

  it("reports INVALID_CONFIG_SHAPE for unsupported keys", () => {
    const result = parseInstallProviderConfigObject({
      provider: "copilot",
      extra: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_CONFIG_SHAPE");
    }
  });

  it("reports INVALID_PROVIDER for unsupported provider", () => {
    const result = parseInstallProviderConfig('{ "provider": "openai" }');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PROVIDER");
      expect(result.error.message).toContain("copilot|ollama");
    }
  });

  it("applies fallback provider and surfaces parse error", () => {
    const result = resolveInstallProviderConfig('{ "provider": "invalid" }');

    expect(result).toEqual({
      provider: DEFAULT_INSTALL_PROVIDER,
      usedFallback: true,
      error: expect.objectContaining({
        code: "INVALID_PROVIDER",
      }),
    });
  });

  it("returns config provider when parsing succeeds", () => {
    const result = resolveInstallProviderConfig('{ "provider": "ollama" }', "copilot");

    expect(result).toEqual({
      provider: "ollama",
      usedFallback: false,
    });
  });
});

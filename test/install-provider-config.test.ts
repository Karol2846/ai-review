import { join, resolve } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  INSTALL_PROVIDER_CONFIG_FILE_NAME,
  PROVIDER_KINDS,
  InstallProviderConfigParseError,
  getInstallProviderConfigPath,
  loadInstallProviderConfig,
} from "../src/installProviderConfig";

const validConfig = {
  provider: "openai-compatible" as const,
  model: "gpt-4o",
  apiKeyEnv: "OPENAI_API_KEY",
};

function writeTempConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-test-"));
  const filePath = join(dir, INSTALL_PROVIDER_CONFIG_FILE_NAME);
  writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  return filePath;
}

describe("getInstallProviderConfigPath", () => {
  it("resolves config path inside the given config directory", () => {
    const configDir = resolve("tmp", "ai-review-config");
    const configPath = getInstallProviderConfigPath(configDir);
    expect(configPath).toBe(join(configDir, INSTALL_PROVIDER_CONFIG_FILE_NAME));
  });
});

describe("PROVIDER_KINDS", () => {
  it("includes all expected providers", () => {
    expect(PROVIDER_KINDS).toContain("openai-compatible");
    expect(PROVIDER_KINDS).toContain("anthropic");
    expect(PROVIDER_KINDS).toContain("google");
    expect(PROVIDER_KINDS).not.toContain("bedrock");
    expect(PROVIDER_KINDS).not.toContain("ollama");
    expect(PROVIDER_KINDS).not.toContain("copilot");
  });
});

describe("loadInstallProviderConfig", () => {
  it("loads a valid config", () => {
    const path = writeTempConfig(validConfig);
    const result = loadInstallProviderConfig(path);
    expect(result).toEqual(validConfig);
  });

  it("loads a valid config with optional baseURL", () => {
    const config = { ...validConfig, baseURL: "https://api.groq.com/openai/v1" };
    const path = writeTempConfig(config);
    const result = loadInstallProviderConfig(path);
    expect(result.baseURL).toBe("https://api.groq.com/openai/v1");
  });

  it("trims whitespace from model and apiKeyEnv", () => {
    const path = writeTempConfig({ ...validConfig, model: "  gpt-4o  ", apiKeyEnv: "  MY_KEY  " });
    const result = loadInstallProviderConfig(path);
    expect(result.model).toBe("gpt-4o");
    expect(result.apiKeyEnv).toBe("MY_KEY");
  });

  it("throws INVALID_JSON for malformed JSON", () => {
    const path = writeTempConfig('{"provider":');
    expect(() => loadInstallProviderConfig(path)).toThrow(InstallProviderConfigParseError);
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("INVALID_JSON");
    }
  });

  it("throws INVALID_CONFIG_SHAPE when root is not an object", () => {
    const path = writeTempConfig('"just a string"');
    expect(() => loadInstallProviderConfig(path)).toThrow(InstallProviderConfigParseError);
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("INVALID_CONFIG_SHAPE");
    }
  });

  it("throws INVALID_CONFIG_SHAPE for unknown keys", () => {
    const path = writeTempConfig({ ...validConfig, extra: true });
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("INVALID_CONFIG_SHAPE");
    }
  });

  it("throws MISSING_REQUIRED_FIELD when model is absent", () => {
    const { model: _m, ...noModel } = validConfig;
    const path = writeTempConfig(noModel);
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("MISSING_REQUIRED_FIELD");
    }
  });

  it("throws MISSING_REQUIRED_FIELD when apiKeyEnv is absent", () => {
    const { apiKeyEnv: _a, ...noApiKey } = validConfig;
    const path = writeTempConfig(noApiKey);
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("MISSING_REQUIRED_FIELD");
    }
  });

  it("throws INVALID_PROVIDER_KIND for unsupported provider", () => {
    const path = writeTempConfig({ ...validConfig, provider: "ollama" });
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("INVALID_PROVIDER_KIND");
      expect((e as InstallProviderConfigParseError).message).toContain("openai-compatible");
    }
  });

  it("throws INVALID_CONFIG_SHAPE for empty model", () => {
    const path = writeTempConfig({ ...validConfig, model: "   " });
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("INVALID_CONFIG_SHAPE");
    }
  });

  it("throws INVALID_CONFIG_SHAPE for baseURL on non-openai-compatible provider", () => {
    const path = writeTempConfig({ provider: "anthropic", model: "claude-3-5-haiku-20241022", apiKeyEnv: "MY_KEY", baseURL: "https://example.com" });
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("INVALID_CONFIG_SHAPE");
    }
  });

  it("throws INVALID_CONFIG_SHAPE for invalid baseURL", () => {
    const path = writeTempConfig({ ...validConfig, baseURL: "not-a-url" });
    try { loadInstallProviderConfig(path); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("INVALID_CONFIG_SHAPE");
    }
  });

  it("throws INVALID_CONFIG_SHAPE when config file does not exist", () => {
    try { loadInstallProviderConfig("/nonexistent/path/.ai-review-install-provider.json"); } catch (e) {
      expect((e as InstallProviderConfigParseError).code).toBe("INVALID_CONFIG_SHAPE");
    }
  });
});

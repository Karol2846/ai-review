import { join, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  INSTALL_PROVIDER_CONFIG_FILE_NAME,
  PROVIDER_KINDS,
  InstallProviderConfigParseError,
  type InstallProviderConfig,
  getInstallProviderConfigPath,
  loadInstallProviderConfig,
  mergeProviderConfig,
} from "../src/installProviderConfig";

const validConfig = {
  provider: "claude-code" as const,
  model: "haiku",
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
  it("lists the supported coding-agent CLIs", () => {
    expect([...PROVIDER_KINDS]).toEqual(["claude-code", "codex"]);
  });
});

describe("loadInstallProviderConfig", () => {
  it("loads a valid config", () => {
    const path = writeTempConfig(validConfig);
    const result = loadInstallProviderConfig(path);
    expect(result).toEqual(validConfig);
  });

  it("loads a config with only a provider (model is optional)", () => {
    const path = writeTempConfig({ provider: "codex" });
    expect(loadInstallProviderConfig(path)).toEqual({ provider: "codex" });
  });

  it("trims whitespace from model", () => {
    const path = writeTempConfig({ ...validConfig, model: "  haiku  " });
    expect(loadInstallProviderConfig(path).model).toBe("haiku");
  });

  it("throws INVALID_JSON for malformed JSON", () => {
    const path = writeTempConfig('{"provider":');
    expect(() => loadInstallProviderConfig(path)).toThrow(
      expect.objectContaining({ code: "INVALID_JSON" })
    );
  });

  it("throws INVALID_CONFIG_SHAPE when root is not an object", () => {
    const path = writeTempConfig('"just a string"');
    expect(() => loadInstallProviderConfig(path)).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG_SHAPE" })
    );
  });

  it("throws INVALID_CONFIG_SHAPE for unknown keys", () => {
    const path = writeTempConfig({ ...validConfig, extra: true });
    expect(() => loadInstallProviderConfig(path)).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG_SHAPE" })
    );
  });

  it("rejects a config from the API-key era so the setup wizard runs again", () => {
    const path = writeTempConfig({ provider: "anthropic", model: "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_API_KEY" });
    expect(() => loadInstallProviderConfig(path)).toThrow(InstallProviderConfigParseError);
  });

  it("throws MISSING_REQUIRED_FIELD when provider is absent", () => {
    const path = writeTempConfig({ model: "haiku" });
    expect(() => loadInstallProviderConfig(path)).toThrow(
      expect.objectContaining({ code: "MISSING_REQUIRED_FIELD" })
    );
  });

  it("throws INVALID_PROVIDER_KIND for unsupported provider", () => {
    const path = writeTempConfig({ ...validConfig, provider: "openai-compatible" });
    expect(() => loadInstallProviderConfig(path)).toThrow(
      expect.objectContaining({ code: "INVALID_PROVIDER_KIND", message: expect.stringContaining("claude-code") })
    );
  });

  it("throws INVALID_CONFIG_SHAPE for empty model", () => {
    const path = writeTempConfig({ ...validConfig, model: "   " });
    expect(() => loadInstallProviderConfig(path)).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG_SHAPE" })
    );
  });

  it("throws INVALID_CONFIG_SHAPE when config file does not exist", () => {
    expect(() => loadInstallProviderConfig("/nonexistent/path/.ai-review-install-provider.json")).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG_SHAPE" })
    );
  });
});

describe("mergeProviderConfig", () => {
  const installClaude: InstallProviderConfig = { provider: "claude-code", model: "sonnet" };

  it("returns the base config unchanged when override is null", () => {
    expect(mergeProviderConfig(installClaude, null)).toBe(installClaude);
  });

  it("overrides only the model name, inheriting the provider", () => {
    expect(mergeProviderConfig(installClaude, "haiku")).toEqual({ provider: "claude-code", model: "haiku" });
  });

  it("adds a model when the install config has none", () => {
    expect(mergeProviderConfig({ provider: "codex" }, "gpt-5-codex")).toEqual({
      provider: "codex",
      model: "gpt-5-codex",
    });
  });

  it("does not mutate the base config", () => {
    mergeProviderConfig(installClaude, "haiku");
    expect(installClaude.model).toBe("sonnet");
  });
});

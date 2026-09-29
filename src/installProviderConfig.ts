import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { type ProviderKind, PROVIDER_KINDS } from "./llmClient";

export { type ProviderKind, PROVIDER_KINDS };

export const INSTALL_PROVIDER_CONFIG_FILE_NAME = ".ai-review-install-provider.json";

export interface InstallProviderConfig {
  readonly provider: ProviderKind;
  /** Optional; when omitted the provider CLI's own default model is used. */
  readonly model?: string;
}

/**
 * Per-repo model override (the `model` section of `ai-review.json`): just the model name.
 * The provider always comes from the install config — to change it, re-run the setup wizard.
 */
export type UserModelConfigOverride = string;

export type InstallProviderConfigParseErrorCode =
  | "INVALID_JSON"
  | "INVALID_CONFIG_SHAPE"
  | "INVALID_PROVIDER_KIND"
  | "MISSING_REQUIRED_FIELD";

export class InstallProviderConfigParseError extends Error {
  readonly code: InstallProviderConfigParseErrorCode;

  constructor(code: InstallProviderConfigParseErrorCode, message: string) {
    super(message);
    this.name = "InstallProviderConfigParseError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

const ALLOWED_KEYS = new Set(["provider", "model"]);
const REQUIRED_KEYS = ["provider"] as const;

/**
 * Validates the value-level constraints of a provider config and returns a normalized
 * `InstallProviderConfig`. `remediation` is appended to error messages to point the user at the
 * right place to fix it.
 */
function validateProviderConfigShape(
  fields: Record<string, unknown>,
  remediation: string
): InstallProviderConfig {
  const { provider, model } = fields;

  if (!isProviderKind(provider)) {
    throw new InstallProviderConfigParseError(
      "INVALID_PROVIDER_KIND",
      `"provider" must be one of ${PROVIDER_KINDS.join("|")}. Received: "${String(provider)}". ${remediation}`
    );
  }

  if (model === undefined) {
    return { provider };
  }

  if (typeof model !== "string" || model.trim().length === 0) {
    throw new InstallProviderConfigParseError(
      "INVALID_CONFIG_SHAPE",
      `"model" must be a non-empty string. ${remediation}`
    );
  }

  return { provider, model: model.trim() };
}

function parseInstallProviderConfigObject(value: unknown): InstallProviderConfig {
  if (!isPlainObject(value)) {
    throw new InstallProviderConfigParseError(
      "INVALID_CONFIG_SHAPE",
      "Install provider config root must be a JSON object."
    );
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new InstallProviderConfigParseError(
        "INVALID_CONFIG_SHAPE",
        `Unknown key "${key}" in install provider config. Re-run the setup wizard.`
      );
    }
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in value)) {
      throw new InstallProviderConfigParseError(
        "MISSING_REQUIRED_FIELD",
        `Missing required field "${key}" in install provider config. Re-run the setup wizard.`
      );
    }
  }

  return validateProviderConfigShape(value, "Re-run the setup wizard.");
}

/**
 * Applies a per-repo model override onto the install config: only the model name changes;
 * the provider is inherited from the install config unchanged.
 * `override` is `null` when the repo config has no `model` section.
 */
export function mergeProviderConfig(
  base: InstallProviderConfig,
  override: UserModelConfigOverride | null
): InstallProviderConfig {
  if (override === null) return base;
  return { ...base, model: override };
}

export const INSTALL_PROVIDER_CONFIG_DIR = join(homedir(), ".ai-review");

export function getInstallProviderConfigPath(configDir: string = INSTALL_PROVIDER_CONFIG_DIR): string {
  return join(configDir, INSTALL_PROVIDER_CONFIG_FILE_NAME);
}

export function loadInstallProviderConfig(filePath: string): InstallProviderConfig {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new InstallProviderConfigParseError(
      "INVALID_CONFIG_SHAPE",
      `Could not read install provider config at "${filePath}": ${(error as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error.";
    throw new InstallProviderConfigParseError(
      "INVALID_JSON",
      `Install provider config contains invalid JSON: ${details}`
    );
  }

  return parseInstallProviderConfigObject(parsed);
}

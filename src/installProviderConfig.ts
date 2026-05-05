import { resolve } from "node:path";

export const INSTALL_PROVIDER_CONFIG_FILE_NAME = ".ai-review-install-provider.json";
export const INSTALL_PROVIDER_TYPES = ["copilot", "ollama"] as const;
export const DEFAULT_INSTALL_PROVIDER = "copilot";

export type InstallProviderType = (typeof INSTALL_PROVIDER_TYPES)[number];

export interface InstallProviderConfig {
  readonly provider: InstallProviderType;
}

export type InstallProviderConfigParseErrorCode =
  | "INVALID_JSON"
  | "INVALID_CONFIG_SHAPE"
  | "INVALID_PROVIDER";

export class InstallProviderConfigParseError extends Error {
  readonly code: InstallProviderConfigParseErrorCode;

  constructor(code: InstallProviderConfigParseErrorCode, message: string) {
    super(message);
    this.name = "InstallProviderConfigParseError";
    this.code = code;
  }
}

export type ParseInstallProviderConfigResult =
  | {
      readonly ok: true;
      readonly config: InstallProviderConfig;
    }
  | {
      readonly ok: false;
      readonly error: InstallProviderConfigParseError;
    };

export interface ResolveInstallProviderConfigResult {
  readonly provider: InstallProviderType;
  readonly usedFallback: boolean;
  readonly error?: InstallProviderConfigParseError;
}

function createInvalidShapeError(message: string): ParseInstallProviderConfigResult {
  return {
    ok: false,
    error: new InstallProviderConfigParseError("INVALID_CONFIG_SHAPE", message),
  };
}

function buildAllowedProviderMessage(value: unknown): string {
  const allowed = INSTALL_PROVIDER_TYPES.join("|");
  const received = typeof value === "string" ? value : String(value);
  return `Install provider must be one of ${allowed}. Received: "${received}".`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInstallProviderType(value: unknown): value is InstallProviderType {
  return typeof value === "string" && INSTALL_PROVIDER_TYPES.includes(value as InstallProviderType);
}

export function getInstallProviderConfigPath(moduleDir: string = __dirname): string {
  return resolve(moduleDir, "..", INSTALL_PROVIDER_CONFIG_FILE_NAME);
}

export function parseInstallProviderConfigObject(
  value: unknown
): ParseInstallProviderConfigResult {
  if (!isPlainObject(value)) {
    return createInvalidShapeError("Install provider config root must be a JSON object.");
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "provider") {
    return createInvalidShapeError('Install provider config must include only the "provider" key.');
  }

  const provider = value.provider;
  if (!isInstallProviderType(provider)) {
    return {
      ok: false,
      error: new InstallProviderConfigParseError(
        "INVALID_PROVIDER",
        buildAllowedProviderMessage(provider)
      ),
    };
  }

  return {
    ok: true,
    config: {
      provider,
    },
  };
}

export function parseInstallProviderConfig(content: string): ParseInstallProviderConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const details = error instanceof Error && error.message.trim().length > 0 ? error.message : "Unknown error.";
    return {
      ok: false,
      error: new InstallProviderConfigParseError(
        "INVALID_JSON",
        `Install provider config contains invalid JSON: ${details}`
      ),
    };
  }

  return parseInstallProviderConfigObject(parsed);
}

export function resolveInstallProviderConfig(
  content: string,
  fallbackProvider: InstallProviderType = DEFAULT_INSTALL_PROVIDER
): ResolveInstallProviderConfigResult {
  const parsed = parseInstallProviderConfig(content);
  if (parsed.ok) {
    return {
      provider: parsed.config.provider,
      usedFallback: false,
    };
  }

  return {
    provider: fallbackProvider,
    usedFallback: true,
    error: parsed.error,
  };
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import micromatch from "micromatch";

import { defaultRoutingConfig } from "./defaultConfig";
import {
  type AgentGlobsMap,
  type AgentName,
  type RoutingRuntimeConfig,
  type UserRoutingConfigOverride,
} from "./routingTypes";

const CONFIG_FILE_NAME = ".ai-reviewrc.json";

export interface LoadRoutingConfigResult {
  readonly config: RoutingRuntimeConfig;
  readonly warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return "Unknown error.";
}

function createAgentGlobsRecord(): Record<string, readonly string[]> {
  return Object.create(null) as Record<string, readonly string[]>;
}

function cloneAgentGlobs(agentGlobs: AgentGlobsMap): AgentGlobsMap {
  const cloned = createAgentGlobsRecord();
  for (const [agentName, patterns] of Object.entries(agentGlobs)) {
    cloned[agentName] = [...patterns];
  }

  return cloned;
}

function cloneRuntimeConfig(config: RoutingRuntimeConfig): RoutingRuntimeConfig {
  return {
    ...config,
    agentGlobs: cloneAgentGlobs(config.agentGlobs),
  };
}

interface ParseUserConfigResult {
  readonly override: UserRoutingConfigOverride;
  readonly warnings: string[];
}

function parseUserConfig(value: unknown, configPath: string): ParseUserConfigResult {
  const override: { agentGlobs?: Partial<Record<AgentName, readonly string[]>> } = {};

  if (!isPlainObject(value)) {
    return {
      override,
      warnings: [`Invalid config in ${configPath}: root must be a JSON object.`],
    };
  }

  const warnings: string[] = [];
  const allowedRootKeys = new Set(["agentGlobs"]);
  const parsedAgentGlobs = createAgentGlobsRecord();

  for (const key of Object.keys(value)) {
    if (!allowedRootKeys.has(key)) {
      warnings.push(`Invalid config in ${configPath}: unsupported root key "${key}" at "${key}".`);
    }
  }

  if (!("agentGlobs" in value)) {
    return { override, warnings };
  }

  const { agentGlobs } = value;
  if (!isPlainObject(agentGlobs)) {
    warnings.push(`Invalid config in ${configPath}: "agentGlobs" must be an object.`);
    return { override, warnings };
  }

  for (const [agentName, patterns] of Object.entries(agentGlobs)) {
    const agentPath = `agentGlobs.${agentName}`;
    if (!Array.isArray(patterns)) {
      warnings.push(
        `Invalid config in ${configPath}: "${agentPath}" must be an array of non-empty glob strings.`
      );
      continue;
    }

    if (patterns.length === 0) {
      parsedAgentGlobs[agentName] = [];
      continue;
    }

    const validPatterns: string[] = [];
    for (const [index, pattern] of patterns.entries()) {
      const patternPath = `${agentPath}[${index}]`;
      if (typeof pattern !== "string" || pattern.trim().length === 0) {
        warnings.push(
          `Invalid config in ${configPath}: "${patternPath}" must be a non-empty string.`
        );
        continue;
      }

      const trimmedPattern = pattern.trim();
      try {
        micromatch.makeRe(trimmedPattern);
        validPatterns.push(trimmedPattern);
      } catch {
        warnings.push(
          `Invalid config in ${configPath}: "${patternPath}" must be a valid glob pattern.`
        );
      }
    }

    if (validPatterns.length > 0) {
      parsedAgentGlobs[agentName] = validPatterns;
    }
  }

  if (Object.keys(parsedAgentGlobs).length > 0) {
    override.agentGlobs = parsedAgentGlobs as Partial<Record<AgentName, readonly string[]>>;
  }

  return {
    override: override as UserRoutingConfigOverride,
    warnings,
  };
}

function mergeOverrideConfig(
  baseConfig: RoutingRuntimeConfig,
  userConfig: UserRoutingConfigOverride
): RoutingRuntimeConfig {
  const mergedAgentGlobs = cloneAgentGlobs(baseConfig.agentGlobs);

  if (userConfig.agentGlobs) {
    for (const [agentName, overridePatterns] of Object.entries(userConfig.agentGlobs)) {
      if (!overridePatterns) {
        continue;
      }

      mergedAgentGlobs[agentName as AgentName] = overridePatterns.map((pattern) => pattern.trim());
    }
  }

  return {
    ...baseConfig,
    agentGlobs: mergedAgentGlobs,
  };
}

export function loadRoutingConfig(repoRootPath: string): LoadRoutingConfigResult {
  const defaultConfig = cloneRuntimeConfig(defaultRoutingConfig);
  const configPath = join(repoRootPath, CONFIG_FILE_NAME);

  if (!existsSync(configPath)) {
    return { config: defaultConfig, warnings: [] };
  }

  let rawConfigContent: string;
  try {
    rawConfigContent = readFileSync(configPath, "utf8");
  } catch (error) {
    return {
      config: defaultConfig,
      warnings: [`Failed to read ${CONFIG_FILE_NAME}: ${formatErrorDetail(error)}`],
    };
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfigContent) as unknown;
  } catch (error) {
    return {
      config: defaultConfig,
      warnings: [`Invalid JSON in ${CONFIG_FILE_NAME}: ${formatErrorDetail(error)}`],
    };
  }

  const { override, warnings } = parseUserConfig(parsedConfig, configPath);

  return {
    config: mergeOverrideConfig(defaultConfig, override),
    warnings,
  };
}

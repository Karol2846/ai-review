import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import micromatch from "micromatch";

import { defaultRoutingConfig } from "./defaultConfig";
import {
  AGENT_NAMES,
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

function cloneAgentGlobs(agentGlobs: AgentGlobsMap): AgentGlobsMap {
  const cloned = {} as Record<AgentName, readonly string[]>;

  for (const agent of AGENT_NAMES) {
    cloned[agent] = [...agentGlobs[agent]];
  }

  return cloned;
}

function cloneRuntimeConfig(config: RoutingRuntimeConfig): RoutingRuntimeConfig {
  return {
    ...config,
    agentGlobs: cloneAgentGlobs(config.agentGlobs),
  };
}

function validateUserConfig(value: unknown, configPath: string): string[] {
  if (!isPlainObject(value)) {
    return [`Invalid config in ${configPath}: root must be a JSON object.`];
  }

  const warnings: string[] = [];
  const allowedRootKeys = new Set(["agentGlobs"]);

  for (const key of Object.keys(value)) {
    if (!allowedRootKeys.has(key)) {
      warnings.push(`Invalid config in ${configPath}: unsupported root key "${key}".`);
    }
  }

  if (!("agentGlobs" in value)) {
    return warnings;
  }

  const { agentGlobs } = value;
  if (!isPlainObject(agentGlobs)) {
    warnings.push(`Invalid config in ${configPath}: "agentGlobs" must be an object.`);
    return warnings;
  }

  const supportedAgents = new Set<string>(AGENT_NAMES);
  for (const [agentName, patterns] of Object.entries(agentGlobs)) {
    if (!supportedAgents.has(agentName)) {
      warnings.push(`Invalid config in ${configPath}: unsupported agent "${agentName}".`);
      continue;
    }

    if (!Array.isArray(patterns)) {
      warnings.push(
        `Invalid config in ${configPath}: "agentGlobs.${agentName}" must be an array of non-empty strings.`
      );
      continue;
    }

    patterns.forEach((pattern, index) => {
      if (typeof pattern !== "string" || pattern.trim().length === 0) {
        warnings.push(
          `Invalid config in ${configPath}: "agentGlobs.${agentName}[${index}]" must be a non-empty string.`
        );
        return;
      }

      try {
        micromatch.makeRe(pattern.trim());
      } catch {
        warnings.push(
          `Invalid config in ${configPath}: "agentGlobs.${agentName}[${index}]" must be a valid glob pattern.`
        );
      }
    });
  }

  return warnings;
}

function mergeOverrideConfig(
  baseConfig: RoutingRuntimeConfig,
  userConfig: UserRoutingConfigOverride
): RoutingRuntimeConfig {
  const mergedAgentGlobs = cloneAgentGlobs(baseConfig.agentGlobs);

  if (userConfig.agentGlobs) {
    for (const agent of AGENT_NAMES) {
      const overridePatterns = userConfig.agentGlobs[agent];
      if (overridePatterns) {
        mergedAgentGlobs[agent] = overridePatterns.map((pattern) => pattern.trim());
      }
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

  const validationWarnings = validateUserConfig(parsedConfig, configPath);
  if (validationWarnings.length > 0) {
    return {
      config: defaultConfig,
      warnings: validationWarnings,
    };
  }

  return {
    config: mergeOverrideConfig(defaultConfig, parsedConfig as UserRoutingConfigOverride),
    warnings: [],
  };
}

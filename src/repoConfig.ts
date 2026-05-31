import {
  type ProviderKind,
  PROVIDER_KINDS,
  type UserModelConfigOverride,
} from "./installProviderConfig";
import {
  AGENT_NAMES,
  type AgentGlobsMap,
  type RoutingRuntimeConfig,
  type UserRoutingConfigOverride,
} from "./routingTypes";

export const REPO_CONFIG_FILE_NAME = "ai-review.json";

const ALLOWED_ROOT_KEYS = ["routing", "model"] as const;
const ALLOWED_ROUTING_KEYS = ["agentGlobs"] as const;
const ALLOWED_MODEL_KEYS = ["provider", "model", "apiKeyEnv", "baseURL"] as const;
const ALLOWED_AGENT_NAMES = new Set<string>(AGENT_NAMES);

/**
 * Parsed `ai-review.json`. Each section is `null` when absent from the file.
 */
export interface RepoConfigOverride {
  readonly routing: UserRoutingConfigOverride | null;
  readonly model: UserModelConfigOverride | null;
}

export class RepoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoConfigError";
  }
}

/**
 * Parses and validates raw JSON content of `ai-review.json`.
 * Returns `null` when `raw` is `null` (file absent). When the file is present, returns a
 * `RepoConfigOverride` whose `routing`/`model` sections are `null` if absent from the file.
 * Throws `RepoConfigError` on any validation violation.
 */
export function parseRepoConfig(raw: string | null): RepoConfigOverride | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RepoConfigError(`${REPO_CONFIG_FILE_NAME}: root must be a JSON object.`);
  }

  const root = parsed as Record<string, unknown>;
  const unknownRootKeys = Object.keys(root).filter(
    (k) => !(ALLOWED_ROOT_KEYS as readonly string[]).includes(k)
  );
  if (unknownRootKeys.length > 0) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: unknown key(s) at root: "${unknownRootKeys.join('", "')}". ` +
        `Allowed: ${ALLOWED_ROOT_KEYS.join(", ")}.`
    );
  }

  return {
    routing: parseRoutingSection(root["routing"]),
    model: parseModelSection(root["model"]),
  };
}

function parseRoutingSection(routing: unknown): UserRoutingConfigOverride | null {
  if (routing === undefined) return null;

  if (typeof routing !== "object" || routing === null || Array.isArray(routing)) {
    throw new RepoConfigError(`${REPO_CONFIG_FILE_NAME}: "routing" must be an object.`);
  }

  const routingObj = routing as Record<string, unknown>;
  const unknownRoutingKeys = Object.keys(routingObj).filter(
    (k) => !(ALLOWED_ROUTING_KEYS as readonly string[]).includes(k)
  );
  if (unknownRoutingKeys.length > 0) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: unknown key(s) in "routing": "${unknownRoutingKeys.join('", "')}". ` +
        `Allowed: ${ALLOWED_ROUTING_KEYS.join(", ")}.`
    );
  }

  const agentGlobs = routingObj["agentGlobs"];
  if (agentGlobs === undefined) return {};

  if (typeof agentGlobs !== "object" || agentGlobs === null || Array.isArray(agentGlobs)) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: "routing.agentGlobs" must be an object.`
    );
  }

  const agentGlobsObj = agentGlobs as Record<string, unknown>;
  const result: Record<string, readonly string[]> = {};

  for (const [agentName, globs] of Object.entries(agentGlobsObj)) {
    if (!ALLOWED_AGENT_NAMES.has(agentName)) {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: unknown agent "${agentName}" in "routing.agentGlobs". ` +
          `Allowed agents: ${AGENT_NAMES.join(", ")}.`
      );
    }

    if (!Array.isArray(globs)) {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: "routing.agentGlobs.${agentName}" must be an array of strings.`
      );
    }

    if (globs.length === 0) {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: "routing.agentGlobs.${agentName}" must not be empty.`
      );
    }

    for (const [i, glob] of globs.entries()) {
      if (typeof glob !== "string" || glob.trim().length === 0) {
        throw new RepoConfigError(
          `${REPO_CONFIG_FILE_NAME}: "routing.agentGlobs.${agentName}[${i}]" must be a non-empty string.`
        );
      }
    }

    result[agentName] = globs as string[];
  }

  return { agentGlobs: result };
}

function parseModelSection(model: unknown): UserModelConfigOverride | null {
  if (model === undefined) return null;

  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    throw new RepoConfigError(`${REPO_CONFIG_FILE_NAME}: "model" must be an object.`);
  }

  const modelObj = model as Record<string, unknown>;
  const unknownModelKeys = Object.keys(modelObj).filter(
    (k) => !(ALLOWED_MODEL_KEYS as readonly string[]).includes(k)
  );
  if (unknownModelKeys.length > 0) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: unknown key(s) in "model": "${unknownModelKeys.join('", "')}". ` +
        `Allowed: ${ALLOWED_MODEL_KEYS.join(", ")}.`
    );
  }

  const override: {
    provider?: ProviderKind;
    model?: string;
    apiKeyEnv?: string;
    baseURL?: string;
  } = {};

  if (modelObj["provider"] !== undefined) {
    const provider = modelObj["provider"];
    if (typeof provider !== "string" || !(PROVIDER_KINDS as readonly string[]).includes(provider)) {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: "model.provider" must be one of: ${PROVIDER_KINDS.join(", ")}.`
      );
    }
    override.provider = provider as ProviderKind;
  }

  for (const key of ["model", "apiKeyEnv", "baseURL"] as const) {
    const value = modelObj[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: "model.${key}" must be a non-empty string.`
      );
    }
    override[key] = value.trim();
  }

  if (override.baseURL !== undefined) {
    try {
      new URL(override.baseURL);
    } catch {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: "model.baseURL" is not a valid URL: "${override.baseURL}".`
      );
    }
  }

  return override;
}

/**
 * Merges a per-repo routing override into the base config.
 * Semantics: extend — override globs are appended to the base globs for each agent, with dedup.
 * Agents not mentioned in the override are unchanged.
 */
export function mergeRoutingConfig(
  base: RoutingRuntimeConfig,
  override: UserRoutingConfigOverride | null
): RoutingRuntimeConfig {
  if (override === null || override.agentGlobs === undefined) {
    return base;
  }

  const mergedGlobs: AgentGlobsMap = { ...base.agentGlobs };

  for (const [agent, extraGlobs] of Object.entries(override.agentGlobs)) {
    if (extraGlobs === undefined) continue;
    const existing = mergedGlobs[agent] ?? [];
    const existingSet = new Set(existing);
    const deduped = [...existing];
    for (const glob of extraGlobs) {
      if (!existingSet.has(glob)) {
        deduped.push(glob);
      }
    }
    mergedGlobs[agent] = deduped;
  }

  return { ...base, agentGlobs: mergedGlobs };
}

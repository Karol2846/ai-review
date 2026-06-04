import {
  type ProviderKind,
  PROVIDER_KINDS,
  type UserModelConfigOverride,
} from "./installProviderConfig";
import {
  AGENT_NAMES,
  type AgentDefinition,
  type AgentsMap,
  type AgentGlobsEntry,
  type AgentGlobsMap,
  type RoutingRuntimeConfig,
  type UserRoutingConfigOverride,
} from "./routingTypes";

export const REPO_CONFIG_FILE_NAME = "ai-review.json";

const ALLOWED_ROOT_KEYS = ["model", "agents", "exclude"] as const;
const ALLOWED_BUILTIN_AGENT_KEYS = ["globs", "replace"] as const;
const ALLOWED_CUSTOM_AGENT_KEYS = ["globs", "instructionsFile"] as const;
const ALLOWED_MODEL_KEYS = ["provider", "model", "apiKeyEnv", "baseURL"] as const;
const BUILTIN_AGENT_NAMES = new Set<string>(AGENT_NAMES);
const CUSTOM_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/iu;

/**
 * Parsed `ai-review.json`. Each section is `null` when absent from the file.
 */
export interface RepoConfigOverride {
  readonly model: UserModelConfigOverride | null;
  readonly agents: AgentsMap | null;
  readonly exclude: readonly string[] | null;
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
 * `RepoConfigOverride` whose sections are `null` if absent from the file.
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

  // Migration hint for the removed `routing` section (v1 → v2).
  if ("routing" in root) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: "routing" was removed in v2. ` +
        `Move "routing.agentGlobs.<name>" to "agents.<name>.globs" instead.`
    );
  }

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
    model: parseModelSection(root["model"]),
    agents: parseAgentsSection(root["agents"]),
    exclude: parseExcludeSection(root["exclude"]),
  };
}

function parseExcludeSection(exclude: unknown): readonly string[] | null {
  if (exclude === undefined) return null;
  return validateGlobsArray(exclude, "exclude");
}

function validateGlobsArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: "${label}" must be an array of strings.`
    );
  }

  if (value.length === 0) {
    throw new RepoConfigError(`${REPO_CONFIG_FILE_NAME}: "${label}" must not be empty.`);
  }

  for (const [i, glob] of value.entries()) {
    if (typeof glob !== "string" || glob.trim().length === 0) {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: "${label}[${i}]" must be a non-empty string.`
      );
    }
  }

  return value as readonly string[];
}

/**
 * Parses the `agents` section — unified built-in overrides and custom agents.
 *
 * Built-in agent (name in AGENT_NAMES):
 *   - `globs` (required), `replace?: boolean` (default false = extend)
 *   - `instructionsFile` is forbidden (built-ins load from the agents/ directory)
 *
 * Custom agent (any other name):
 *   - `globs` (required), `instructionsFile` (required)
 *   - `replace` is forbidden
 */
function parseAgentsSection(agents: unknown): AgentsMap | null {
  if (agents === undefined) return null;

  if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
    throw new RepoConfigError(`${REPO_CONFIG_FILE_NAME}: "agents" must be an object.`);
  }

  const agentsObj = agents as Record<string, unknown>;
  const result: Record<string, AgentDefinition> = {};

  for (const [agentName, definition] of Object.entries(agentsObj)) {
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: "agents.${agentName}" must be an object.`
      );
    }

    const defObj = definition as Record<string, unknown>;

    if (BUILTIN_AGENT_NAMES.has(agentName)) {
      result[agentName] = parseBuiltinAgentEntry(agentName, defObj);
    } else {
      if (!CUSTOM_AGENT_NAME_PATTERN.test(agentName)) {
        throw new RepoConfigError(
          `${REPO_CONFIG_FILE_NAME}: invalid custom agent name "${agentName}". ` +
            `Names must match ${CUSTOM_AGENT_NAME_PATTERN.source}.`
        );
      }
      result[agentName] = parseCustomAgentEntry(agentName, defObj);
    }
  }

  return result;
}

function parseBuiltinAgentEntry(
  agentName: string,
  defObj: Record<string, unknown>
): AgentDefinition {
  const unknownKeys = Object.keys(defObj).filter(
    (k) => !(ALLOWED_BUILTIN_AGENT_KEYS as readonly string[]).includes(k)
  );
  if (unknownKeys.length > 0) {
    if (unknownKeys.includes("instructionsFile")) {
      throw new RepoConfigError(
        `${REPO_CONFIG_FILE_NAME}: "agents.${agentName}.instructionsFile" is not allowed for ` +
          `built-in agents. Built-in instructions are loaded from the agents/ directory.`
      );
    }
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: unknown key(s) in "agents.${agentName}": "${unknownKeys.join('", "')}". ` +
        `Allowed: ${ALLOWED_BUILTIN_AGENT_KEYS.join(", ")}.`
    );
  }

  const globs = validateGlobsArray(defObj["globs"], `agents.${agentName}.globs`);

  const replace = defObj["replace"];
  if (replace !== undefined && typeof replace !== "boolean") {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: "agents.${agentName}.replace" must be a boolean.`
    );
  }

  return { globs, ...(replace === true ? { replace: true } : {}) };
}

function parseCustomAgentEntry(
  agentName: string,
  defObj: Record<string, unknown>
): AgentDefinition {
  const unknownKeys = Object.keys(defObj).filter(
    (k) => !(ALLOWED_CUSTOM_AGENT_KEYS as readonly string[]).includes(k)
  );
  if (unknownKeys.length > 0) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: unknown key(s) in "agents.${agentName}": "${unknownKeys.join('", "')}". ` +
        `Allowed: ${ALLOWED_CUSTOM_AGENT_KEYS.join(", ")}.`
    );
  }

  const globs = validateGlobsArray(defObj["globs"], `agents.${agentName}.globs`);

  const instructionsFile = defObj["instructionsFile"];
  if (typeof instructionsFile !== "string" || instructionsFile.trim().length === 0) {
    throw new RepoConfigError(
      `${REPO_CONFIG_FILE_NAME}: "agents.${agentName}.instructionsFile" is required and must be a non-empty string.`
    );
  }

  return { globs, instructionsFile: instructionsFile.trim() };
}

/**
 * Projects an `AgentsMap` onto a routing override so all agent globs (built-in extends/replaces
 * and custom agent globs) can be folded into the runtime routing config via `mergeRoutingConfig`.
 */
export function agentsToRoutingOverride(agents: AgentsMap | null): UserRoutingConfigOverride | null {
  if (agents === null) return null;
  const agentGlobs: Record<string, AgentGlobsEntry> = {};
  for (const [name, definition] of Object.entries(agents)) {
    agentGlobs[name] = { globs: definition.globs, replace: definition.replace ?? false };
  }
  return { agentGlobs };
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
 * - Default (replace: false): override globs are appended to base globs (extend + dedup).
 * - replace: true: override globs fully replace the base globs for that agent.
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

  for (const [agent, entry] of Object.entries(override.agentGlobs)) {
    if (entry === undefined) continue;
    if (entry.replace) {
      mergedGlobs[agent] = entry.globs;
    } else {
      const existing = mergedGlobs[agent] ?? [];
      const existingSet = new Set(existing);
      const deduped = [...existing];
      for (const glob of entry.globs) {
        if (!existingSet.has(glob)) {
          deduped.push(glob);
        }
      }
      mergedGlobs[agent] = deduped;
    }
  }

  return { ...base, agentGlobs: mergedGlobs };
}

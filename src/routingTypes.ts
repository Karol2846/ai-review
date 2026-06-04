export const AGENT_NAMES = [
  "clean-coder",
  "tester",
  "architect",
  "ddd-reviewer",
  "performance",
] as const;

export type AgentName = string;

export type AgentGlobsMap = Record<string, readonly string[]>;

export type UnmatchedFilesPolicy = "skip";

export interface RoutingRuntimeConfig {
  readonly agentGlobs: AgentGlobsMap;
  readonly unmatchedFilesPolicy: UnmatchedFilesPolicy;
}

/** Internal override entry passed to `mergeRoutingConfig` — carries replace-vs-extend flag. */
export interface AgentGlobsEntry {
  readonly globs: readonly string[];
  readonly replace: boolean;
}

export type UserAgentGlobsOverride = Record<string, AgentGlobsEntry>;

export interface UserRoutingConfigOverride {
  readonly agentGlobs?: UserAgentGlobsOverride;
}

/**
 * Unified agent definition used in `ai-review.json`'s `agents` section.
 * - Built-in agent (name in AGENT_NAMES): `globs` required, `replace` optional, `instructionsFile` absent.
 * - Custom agent (any other name): `globs` required, `instructionsFile` required, `replace` absent.
 */
export interface AgentDefinition {
  readonly globs: readonly string[];
  readonly instructionsFile?: string;
  readonly replace?: boolean;
}

export type AgentsMap = Record<string, AgentDefinition>;

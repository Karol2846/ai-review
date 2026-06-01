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

export type UserAgentGlobsOverride = Partial<AgentGlobsMap>;

export interface UserRoutingConfigOverride {
  readonly agentGlobs?: UserAgentGlobsOverride;
}

/**
 * A custom agent defined per repo in `ai-review.json`'s `agents` section.
 * `globs` route changed files to the agent; `instructionsFile` is a repo-relative path to its
 * `.agent.md` instruction file (required — no default, so the source is always explicit).
 */
export interface CustomAgentDefinition {
  readonly globs: readonly string[];
  readonly instructionsFile: string;
}

export type CustomAgentsMap = Record<string, CustomAgentDefinition>;

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

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
export type UserConfigMergeMode = "override";
export type InvalidUserConfigPolicy = "fallback_with_warning";

export interface RoutingRuntimeConfig {
  readonly agentGlobs: AgentGlobsMap;
  readonly unmatchedFilesPolicy: UnmatchedFilesPolicy;
  readonly userConfigMergeMode: UserConfigMergeMode;
  readonly invalidUserConfigPolicy: InvalidUserConfigPolicy;
}

export type UserAgentGlobsOverride = Partial<AgentGlobsMap>;

export interface UserRoutingConfigOverride {
  readonly agentGlobs?: UserAgentGlobsOverride;
}

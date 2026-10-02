import { explainGlobMatch, matchesGlobs } from "./globMatch";
import { AGENT_NAMES, type AgentName, type RoutingRuntimeConfig } from "./routingTypes";

function toDeterministicUniqueList(files: readonly string[]): string[] {
  return [...new Set(files)].sort();
}

function toDeterministicAgentList(config: RoutingRuntimeConfig): AgentName[] {
  const configuredAgents = Object.keys(config.agentGlobs);
  const configuredAgentSet = new Set(configuredAgents);
  const defaultAgentsInOrder = AGENT_NAMES.filter((agent) => configuredAgentSet.has(agent));
  const defaultAgentSet = new Set<string>(defaultAgentsInOrder);
  const dynamicAgents = configuredAgents.filter((agent) => !defaultAgentSet.has(agent)).sort();

  return [...defaultAgentsInOrder, ...dynamicAgents];
}

export function routeFilesToAgents(
  changedFiles: readonly string[],
  config: RoutingRuntimeConfig
): Map<AgentName, string[]> {
  const agentNames = toDeterministicAgentList(config);
  const filesByAgent = new Map<AgentName, Set<string>>();

  for (const agent of agentNames) {
    filesByAgent.set(agent, new Set<string>());
  }

  for (const file of toDeterministicUniqueList(changedFiles)) {
    let matched = false;

    for (const agent of agentNames) {
      const patterns = config.agentGlobs[agent];
      if (patterns && matchesGlobs(file, patterns)) {
        const bucket = filesByAgent.get(agent);
        if (bucket) {
          bucket.add(file);
        }
        matched = true;
      }
    }

    if (!matched && config.unmatchedFilesPolicy === "skip") {
      continue;
    }
  }

  const routed = new Map<AgentName, string[]>();
  for (const agent of agentNames) {
    routed.set(agent, toDeterministicUniqueList([...(filesByAgent.get(agent) ?? [])]));
  }

  return routed;
}

/** Files from `changedFiles` that no agent was routed — nobody reviews them in this run. */
export function findUnroutedFiles(
  changedFiles: readonly string[],
  routedFilesByAgent: ReadonlyMap<AgentName, readonly string[]>
): string[] {
  const routedFiles = new Set<string>();
  for (const files of routedFilesByAgent.values()) {
    for (const file of files) {
      routedFiles.add(file);
    }
  }
  return toDeterministicUniqueList(changedFiles).filter((file) => !routedFiles.has(file));
}

export interface AgentRoutingExplanation {
  readonly agent: AgentName;
  /** The agent glob that matched the file; absent when the agent's globs are all negations. */
  readonly matchedBy?: string;
  /** Set when a `!` glob of the agent removed the file again — the agent does not receive it. */
  readonly excludedBy?: string;
}

export interface FileRoutingExplanation {
  readonly file: string;
  /** Agents with a matching glob, in routing order; those with `excludedBy` do not get the file. */
  readonly matches: readonly AgentRoutingExplanation[];
}

/**
 * Explains `routeFilesToAgents`: for every file (deduplicated, sorted), which agents' globs match
 * it and which pattern did, including agents whose negated globs removed it again.
 */
export function explainRouting(
  changedFiles: readonly string[],
  config: RoutingRuntimeConfig
): FileRoutingExplanation[] {
  const agentNames = toDeterministicAgentList(config);

  return toDeterministicUniqueList(changedFiles).map((file) => {
    const matches: AgentRoutingExplanation[] = [];
    for (const agent of agentNames) {
      const explanation = explainGlobMatch(file, config.agentGlobs[agent] ?? []);
      if (explanation !== null) {
        matches.push({ agent, ...explanation });
      }
    }
    return { file, matches };
  });
}

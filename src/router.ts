import micromatch from "micromatch";

import { AGENT_NAMES, type AgentName, type RoutingRuntimeConfig } from "./routingTypes";

function normalizeForGlob(path: string): string {
  return path.replace(/\\/gu, "/");
}

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
    const matchPath = normalizeForGlob(file);
    let matched = false;

    for (const agent of agentNames) {
      const patterns = config.agentGlobs[agent];
      if (patterns && micromatch.isMatch(matchPath, patterns)) {
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

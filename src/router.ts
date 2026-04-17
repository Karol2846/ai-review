import micromatch from "micromatch";

import { AGENT_NAMES, type AgentName, type RoutingRuntimeConfig } from "./routingTypes";

function normalizeForGlob(path: string): string {
  return path.replace(/\\/gu, "/");
}

function toDeterministicUniqueList(files: readonly string[]): string[] {
  return [...new Set(files)].sort();
}

export function routeFilesToAgents(
  changedFiles: readonly string[],
  config: RoutingRuntimeConfig
): Map<AgentName, string[]> {
  const filesByAgent = new Map<AgentName, Set<string>>();

  for (const agent of AGENT_NAMES) {
    filesByAgent.set(agent, new Set<string>());
  }

  for (const file of toDeterministicUniqueList(changedFiles)) {
    const matchPath = normalizeForGlob(file);
    let matched = false;

    for (const agent of AGENT_NAMES) {
      if (micromatch.isMatch(matchPath, config.agentGlobs[agent])) {
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
  for (const agent of AGENT_NAMES) {
    routed.set(agent, [...(filesByAgent.get(agent) ?? [])]);
  }

  return routed;
}

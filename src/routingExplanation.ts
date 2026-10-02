import { isUnsupportedFile } from "./contextBuilder";
import { explainGlobMatch } from "./globMatch";
import { explainRouting } from "./router";
import type { AgentName, RoutingRuntimeConfig } from "./routingTypes";

/**
 * - `routed` — at least one agent reviews the file.
 * - `unrouted` — no agent's globs match; nobody reviews it.
 * - `excluded` — dropped by `exclude` / `--exclude` before routing.
 * - `unsupported` — binary or lock file, skipped before routing.
 */
export type FileRoutingStatus = "routed" | "unrouted" | "excluded" | "unsupported";

export interface RoutedAgent {
  readonly agent: AgentName;
  /** The agent glob that matched; absent when the agent's globs are all negations. */
  readonly matchedBy?: string;
}

export interface NegatedAgent extends RoutedAgent {
  /** The agent's `!` glob that removed the file again. */
  readonly excludedBy: string;
}

export interface RoutingExplanationEntry {
  readonly file: string;
  readonly status: FileRoutingStatus;
  /** For `excluded`: the exclude pattern that dropped the file (absent for a negation-only list). */
  readonly excludedBy?: string;
  /** Agents that review the file. */
  readonly agents: readonly RoutedAgent[];
  /** Agents whose glob matched the file but whose `!` glob removed it — they do not review it. */
  readonly negated: readonly NegatedAgent[];
}

/**
 * Explains, per changed file, what a review run would do with it — without reading files or
 * calling an agent CLI. Mirrors the run: `exclude` first, then binary/lock files, then routing.
 */
export function buildRoutingExplanation(
  changedFiles: readonly string[],
  excludeGlobs: readonly string[],
  routingConfig: RoutingRuntimeConfig
): RoutingExplanationEntry[] {
  const entries: RoutingExplanationEntry[] = [];
  const routable: string[] = [];

  for (const file of [...new Set(changedFiles)].sort()) {
    const exclusion = explainGlobMatch(file, excludeGlobs);
    if (exclusion !== null && exclusion.excludedBy === undefined) {
      entries.push({
        file,
        status: "excluded",
        ...(exclusion.matchedBy !== undefined ? { excludedBy: exclusion.matchedBy } : {}),
        agents: [],
        negated: [],
      });
    } else if (isUnsupportedFile(file)) {
      entries.push({ file, status: "unsupported", agents: [], negated: [] });
    } else {
      routable.push(file);
    }
  }

  for (const { file, matches } of explainRouting(routable, routingConfig)) {
    const agents: RoutedAgent[] = [];
    const negated: NegatedAgent[] = [];
    for (const { agent, matchedBy, excludedBy } of matches) {
      const routedAgent = { agent, ...(matchedBy !== undefined ? { matchedBy } : {}) };
      if (excludedBy === undefined) {
        agents.push(routedAgent);
      } else {
        negated.push({ ...routedAgent, excludedBy });
      }
    }
    entries.push({ file, status: agents.length > 0 ? "routed" : "unrouted", agents, negated });
  }

  return entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Renders the explanation as plain text, one block per file. */
export function formatRoutingExplanation(
  entries: readonly RoutingExplanationEntry[],
  baseRef: string,
  selectedAgents: readonly AgentName[]
): string {
  const count = (status: FileRoutingStatus): number =>
    entries.filter((entry) => entry.status === status).length;
  const summary = [
    `${count("routed")} reviewed`,
    `${count("unrouted")} not reviewed`,
    `${count("excluded")} excluded`,
    ...(count("unsupported") > 0 ? [`${count("unsupported")} skipped`] : []),
  ].join(", ");

  const agentColumnWidth = Math.max(
    0,
    ...entries.flatMap((entry) => [...entry.agents, ...entry.negated].map(({ agent }) => agent.length))
  );
  const agentLabel = (agent: AgentName): string => agent.padEnd(agentColumnWidth);
  const viaPattern = (matchedBy: string | undefined): string =>
    matchedBy !== undefined ? `matched ${matchedBy}` : "matched (negation-only globs)";

  const lines = [
    `Routing for ${plural(entries.length, "changed file")} against ${baseRef}: ${summary}.`,
    `Agents: ${selectedAgents.join(", ")}`,
  ];

  for (const entry of entries) {
    lines.push("", entry.file);
    switch (entry.status) {
      case "excluded":
        lines.push(
          entry.excludedBy !== undefined
            ? `  excluded by "${entry.excludedBy}"`
            : "  excluded (not kept by any negated exclude pattern)"
        );
        break;
      case "unsupported":
        lines.push("  skipped: binary or lock file");
        break;
      case "unrouted":
        lines.push("  not reviewed: no agent's globs match");
        break;
      case "routed":
        for (const { agent, matchedBy } of entry.agents) {
          lines.push(`  ${agentLabel(agent)}  ${viaPattern(matchedBy)}`);
        }
        break;
    }
    for (const { agent, matchedBy, excludedBy } of entry.negated) {
      lines.push(`  ${agentLabel(agent)}  skipped: ${viaPattern(matchedBy)}, removed by ${excludedBy}`);
    }
  }

  return lines.join("\n");
}

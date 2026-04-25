#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

import { execa } from "execa";
import micromatch from "micromatch";

import {
  applyAnnotations,
  cleanAnnotations,
  type AnnotationFinding,
  type ApplyAnnotationsResult,
  type CleanAnnotationsResult,
} from "./annotator";
import { CliArgsError, formatCliUsage, parseCliArgs, type CliOptions } from "./cliArgs";
import { loadRoutingConfig, type LoadRoutingConfigResult } from "./config";
import { getChangedFiles, getMergeBase } from "./git";
import { renderReport } from "./reporter";
import { runReviewPipeline, type RunReviewPipelineInput, type RunReviewPipelineResult } from "./reviewPipeline";
import type { AgentInstructionsByAgent, RunnerRetryConfig } from "./runner";
import type { RoutingRuntimeConfig } from "./routingTypes";

const DEFAULT_MAX_CHAR_LIMIT = 14_000;
const DEFAULT_RETRY: RunnerRetryConfig = {
  maxRetries: 1,
  retryDelayMs: 500,
};

interface LoadAgentInstructionsResult {
  readonly instructions: AgentInstructionsByAgent;
  readonly warnings: readonly string[];
}

export interface CliRuntimeDependencies {
  readonly parseArgs: (argv: readonly string[]) => CliOptions;
  readonly formatUsage: () => string;
  readonly resolveRepoRoot: () => Promise<string>;
  readonly detectBaseBranch: () => Promise<string>;
  readonly getMergeBase: (baseBranch: string) => Promise<string>;
  readonly getChangedFiles: (mergeBase: string) => Promise<string[]>;
  readonly loadRoutingConfig: (repoRootPath: string) => LoadRoutingConfigResult;
  readonly loadAgentInstructions: (
    repoRootPath: string,
    agentNames: readonly string[]
  ) => Promise<LoadAgentInstructionsResult>;
  readonly runReviewPipeline: (input: RunReviewPipelineInput) => Promise<RunReviewPipelineResult>;
  readonly renderReport: typeof renderReport;
  readonly applyAnnotations: (
    findings: readonly AnnotationFinding[],
    repoRootPath: string
  ) => Promise<ApplyAnnotationsResult>;
  readonly cleanAnnotations: (repoRootPath: string) => Promise<CleanAnnotationsResult>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "Unknown error.";
}

async function runGit(args: readonly string[]): Promise<string> {
  const { stdout } = await execa("git", [...args], { reject: true });
  return stdout;
}

async function tryRunGit(args: readonly string[]): Promise<string | undefined> {
  try {
    return await runGit(args);
  } catch {
    return undefined;
  }
}

async function resolveRepoRootFromGit(): Promise<string> {
  const isInside = (await runGit(["rev-parse", "--is-inside-work-tree"])).trim().toLowerCase();
  if (isInside !== "true") {
    throw new Error("Not inside a git repository.");
  }

  const repoRoot = (await runGit(["rev-parse", "--show-toplevel"])).trim();
  if (repoRoot.length === 0) {
    throw new Error("Failed to resolve repository root.");
  }

  return repoRoot;
}

function parseOriginHeadBranch(symbolicRef: string): string | undefined {
  const match = symbolicRef.trim().match(/^refs\/remotes\/origin\/(.+)$/u);
  return match?.[1];
}

async function hasRemoteBranch(refName: string): Promise<boolean> {
  const value = await tryRunGit(["rev-parse", "--verify", refName]);
  return value !== undefined;
}

async function detectBaseBranchFromGit(): Promise<string> {
  const originHeadRef = await tryRunGit(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const parsedOriginHead = originHeadRef ? parseOriginHeadBranch(originHeadRef) : undefined;
  if (parsedOriginHead) {
    return parsedOriginHead;
  }

  if (await hasRemoteBranch("origin/main")) {
    return "main";
  }

  if (await hasRemoteBranch("origin/master")) {
    return "master";
  }

  throw new Error('Cannot detect base branch. Use "--base <branch>".');
}

function stripYamlFrontMatter(content: string): string {
  const normalized = content.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    return content.trim();
  }

  const endMarkerIndex = normalized.indexOf("\n---\n", 4);
  if (endMarkerIndex === -1) {
    return content.trim();
  }

  const body = normalized.slice(endMarkerIndex + 5);
  return body.trim();
}

async function loadAgentInstructionsFromDisk(
  repoRootPath: string,
  agentNames: readonly string[]
): Promise<LoadAgentInstructionsResult> {
  const candidateDirectories = [
    join(repoRootPath, "agents"),
    join(resolve(__dirname, ".."), "agents"),
    join(homedir(), ".copilot", "agents"),
  ];
  const uniqueDirectories = [...new Set(candidateDirectories)];
  const instructions: Record<string, string> = Object.create(null) as Record<string, string>;
  const warnings: string[] = [];

  for (const agentName of [...new Set(agentNames)]) {
    let loaded = false;
    const attemptedPaths: string[] = [];

    for (const directoryPath of uniqueDirectories) {
      const instructionPath = join(directoryPath, `${agentName}.agent.md`);
      attemptedPaths.push(instructionPath);

      try {
        const raw = await readFile(instructionPath, "utf8");
        const instruction = stripYamlFrontMatter(raw);
        if (instruction.length === 0) {
          warnings.push(`Agent instruction is empty for "${agentName}" (${instructionPath}).`);
          continue;
        }
        instructions[agentName] = instruction;
        loaded = true;
        break;
      } catch {
        // Try next candidate path.
      }
    }

    if (!loaded) {
      warnings.push(
        `Failed to load instruction for "${agentName}". Checked: ${attemptedPaths.join(", ")}.`
      );
      continue;
    }
  }

  return {
    instructions,
    warnings,
  };
}

function normalizeGlobPath(filePath: string): string {
  return filePath.replace(/\\/gu, "/");
}

function filterChangedFiles(changedFiles: readonly string[], fileFilter: string): string[] {
  return changedFiles.filter((filePath) => micromatch.isMatch(normalizeGlobPath(filePath), fileFilter));
}

interface FilteredRoutingConfigResult {
  readonly config: RoutingRuntimeConfig;
  readonly selectedAgents: readonly string[];
  readonly unknownAgents: readonly string[];
}

function filterRoutingConfigByAgents(
  routingConfig: RoutingRuntimeConfig,
  requestedAgents: readonly string[]
): FilteredRoutingConfigResult {
  const normalizedAgents = [...new Set(requestedAgents.map((agent) => agent.trim()).filter(Boolean))];
  const requestedSet = new Set(normalizedAgents);
  const selectedEntries = Object.entries(routingConfig.agentGlobs).filter(([agent]) =>
    requestedSet.has(agent)
  );

  return {
    config: {
      ...routingConfig,
      agentGlobs: Object.fromEntries(selectedEntries),
    },
    selectedAgents: selectedEntries.map(([agent]) => agent),
    unknownAgents: normalizedAgents.filter((agent) => !Object.hasOwn(routingConfig.agentGlobs, agent)),
  };
}

function toOriginRef(branchName: string): string {
  return branchName.startsWith("origin/") ? branchName : `origin/${branchName}`;
}

function printDebugWarnings(
  debug: boolean,
  warnings: readonly string[],
  writeStderr: (message: string) => void
): void {
  if (!debug) {
    return;
  }

  for (const warning of warnings) {
    writeStderr(`WARN: ${warning}`);
  }
}

function defaultDependencies(): CliRuntimeDependencies {
  return {
    parseArgs: parseCliArgs,
    formatUsage: formatCliUsage,
    resolveRepoRoot: resolveRepoRootFromGit,
    detectBaseBranch: detectBaseBranchFromGit,
    getMergeBase,
    getChangedFiles,
    loadRoutingConfig,
    loadAgentInstructions: loadAgentInstructionsFromDisk,
    runReviewPipeline,
    renderReport,
    applyAnnotations,
    cleanAnnotations,
    writeStdout: (message: string) => process.stdout.write(`${message}\n`),
    writeStderr: (message: string) => process.stderr.write(`${message}\n`),
  };
}

export async function runCli(
  argv: readonly string[],
  dependencyOverrides: Partial<CliRuntimeDependencies> = {}
): Promise<number> {
  const deps: CliRuntimeDependencies = {
    ...defaultDependencies(),
    ...dependencyOverrides,
  };

  let options: CliOptions;
  try {
    options = deps.parseArgs(argv);
  } catch (error) {
    const detail = normalizeErrorMessage(error);
    deps.writeStderr(`Error: ${detail}`);
    deps.writeStdout(deps.formatUsage());
    return 1;
  }

  if (options.showHelp) {
    deps.writeStdout(deps.formatUsage());
    return 0;
  }

  let repoRootPath: string;
  try {
    repoRootPath = await deps.resolveRepoRoot();
  } catch (error) {
    deps.writeStderr(`Error: ${normalizeErrorMessage(error)}`);
    return 1;
  }

  if (options.clean) {
    try {
      const cleanResult = await deps.cleanAnnotations(repoRootPath);
      if (options.debug) {
        deps.writeStderr(
          `Cleaned ${cleanResult.cleanedLineCount} annotation lines in ${cleanResult.cleanedFilesCount} files.`
        );
      }
      return 0;
    } catch (error) {
      deps.writeStderr(`Error: ${normalizeErrorMessage(error)}`);
      return 1;
    }
  }

  const debugWarnings: string[] = [];

  try {
    const baseBranch = options.baseBranch ?? (await deps.detectBaseBranch());
    const mergeBase = await deps.getMergeBase(baseBranch);
    let changedFiles = await deps.getChangedFiles(mergeBase);

    if (options.fileFilter) {
      changedFiles = filterChangedFiles(changedFiles, options.fileFilter);
    }

    if (changedFiles.length === 0) {
      if (options.json) {
        deps.writeStdout("[]");
      } else {
        deps.writeStdout(`No changes detected against ${toOriginRef(baseBranch)}.`);
      }
      return 0;
    }

    const loadedRoutingConfig = deps.loadRoutingConfig(repoRootPath);
    debugWarnings.push(...loadedRoutingConfig.warnings);

    const filteredRoutingConfig = filterRoutingConfigByAgents(
      loadedRoutingConfig.config,
      options.agents
    );
    for (const unknownAgent of filteredRoutingConfig.unknownAgents) {
      debugWarnings.push(`Requested agent "${unknownAgent}" is not present in routing config and was ignored.`);
    }

    if (filteredRoutingConfig.selectedAgents.length === 0) {
      if (options.json) {
        deps.writeStdout("[]");
      } else {
        deps.writeStdout("No configured agents selected for this run.");
      }
      printDebugWarnings(options.debug, debugWarnings, deps.writeStderr);
      return 0;
    }

    const instructionsResult = await deps.loadAgentInstructions(
      repoRootPath,
      filteredRoutingConfig.selectedAgents
    );
    debugWarnings.push(...instructionsResult.warnings);

    const reviewResult = await deps.runReviewPipeline({
      repoRootPath,
      mergeBase,
      changedFiles,
      routingConfig: filteredRoutingConfig.config,
      agentInstructions: instructionsResult.instructions,
      maxCharLimit: DEFAULT_MAX_CHAR_LIMIT,
      concurrency: options.maxParallel,
      retry: DEFAULT_RETRY,
      minSeverity: options.minSeverity,
    });

    for (const warning of reviewResult.warnings) {
      debugWarnings.push(
        [
          `Pipeline ${warning.stage} warning (${warning.code})`,
          warning.batchId ? `batch=${warning.batchId}` : undefined,
          warning.filePath ? `file=${warning.filePath}` : undefined,
          warning.agent ? `agent=${warning.agent}` : undefined,
          warning.message,
        ]
          .filter(Boolean)
          .join(" | ")
      );
    }

    printDebugWarnings(options.debug, debugWarnings, deps.writeStderr);

    if (options.json) {
      deps.writeStdout(JSON.stringify(reviewResult.findings));
      return 0;
    }

    if (reviewResult.findings.length === 0) {
      deps.writeStdout("No issues found.");
      return 0;
    }

    if (options.report) {
      deps.writeStdout(deps.renderReport(reviewResult.findings));
    }

    if (options.annotate) {
      const annotationResult = await deps.applyAnnotations(reviewResult.findings, repoRootPath);
      if (options.debug) {
        deps.writeStderr(
          `Applied ${annotationResult.appliedCount} annotations in ${annotationResult.changedFiles.length} files.`
        );
      }
    }

    return 0;
  } catch (error) {
    if (error instanceof CliArgsError) {
      deps.writeStderr(`Error: ${error.message}`);
      deps.writeStdout(deps.formatUsage());
      return 1;
    }

    deps.writeStderr(`Error: ${normalizeErrorMessage(error)}`);
    return 1;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const code = await runCli(argv);
  process.exitCode = code;
}

if (require.main === module) {
  void main();
}

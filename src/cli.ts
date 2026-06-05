#!/usr/bin/env node

import {homedir} from "node:os";
import {join, resolve} from "node:path";

import type {LanguageModel} from "ai";

/** Returned by resolveLanguageModel when the setup wizard ran and the user must re-run. */
export const SETUP_COMPLETED = Symbol("setup-completed");
import {execa} from "execa";
import micromatch from "micromatch";

import {
  type AnnotationFinding,
  applyAnnotations,
  type ApplyAnnotationsResult,
  cleanAnnotations,
  type CleanAnnotationsResult,
} from "./annotator";
import {readFileSync} from "node:fs";

import {CliArgsError, type CliOptions, formatCliUsage, parseCliArgs} from "./cliArgs";
import {defaultRoutingConfig} from "./defaultConfig";
import {runInit} from "./init";
import {getChangedFiles, getMergeBase} from "./git";
import {
  loadInstallProviderConfig,
  getInstallProviderConfigPath,
  mergeProviderConfig,
  type UserModelConfigOverride,
} from "./installProviderConfig";
import {createLanguageModel} from "./llmClient";
import {parseRepoConfig, mergeRoutingConfig, agentsToRoutingOverride, isCustomAgent, RepoConfigError, REPO_CONFIG_FILE_NAME} from "./repoConfig";
import {renderReport} from "./reporter";
import {runReviewPipeline, type RunReviewPipelineInput, type RunReviewPipelineResult} from "./reviewPipeline";
import type {AgentInstructionsByAgent, RunnerRetryConfig} from "./runner";
import type {AgentsMap, RoutingRuntimeConfig} from "./routingTypes";

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
  readonly getHeadSha: () => Promise<string>;
  readonly getChangedFiles: (mergeBase: string) => Promise<string[]>;
  readonly loadAgentInstructions: (
    repoRootPath: string,
    agentNames: readonly string[],
    instructionFileOverrides?: Readonly<Record<string, string>>
  ) => Promise<LoadAgentInstructionsResult>;
  readonly resolveLanguageModel: (
    writeStdout: (m: string) => void,
    modelOverride: UserModelConfigOverride | null
  ) => Promise<LanguageModel | typeof SETUP_COMPLETED>;
  readonly runReviewPipeline: (input: RunReviewPipelineInput) => Promise<RunReviewPipelineResult>;
  readonly renderReport: typeof renderReport;
  readonly applyAnnotations: (
    findings: readonly AnnotationFinding[],
    repoRootPath: string
  ) => Promise<ApplyAnnotationsResult>;
  readonly cleanAnnotations: (repoRootPath: string) => Promise<CleanAnnotationsResult>;
  readonly readRepoConfigFile: (repoRoot: string) => string | null;
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
  agentNames: readonly string[],
  instructionFileOverrides: Readonly<Record<string, string>> = {}
): Promise<LoadAgentInstructionsResult> {
  const { readFile } = await import("node:fs/promises");
  const candidateDirectories = [
    join(repoRootPath, "agents"),
    join(resolve(__dirname, ".."), "agents"),
    join(homedir(), ".copilot", "agents"),
  ];
  const uniqueDirectories = [...new Set(candidateDirectories)];
  const instructions: Record<string, string> = Object.create(null) as Record<string, string>;
  const warnings: string[] = [];

  for (const agentName of [...new Set(agentNames)]) {
    // Custom agents declare an explicit instructionsFile; load only from that path (no directory search).
    const override = Object.hasOwn(instructionFileOverrides, agentName)
      ? instructionFileOverrides[agentName]
      : undefined;
    const candidatePaths = override
      ? [join(repoRootPath, override)]
      : uniqueDirectories.map((directoryPath) => join(directoryPath, `${agentName}.agent.md`));

    let loaded = false;
    const attemptedPaths: string[] = [];

    for (const instructionPath of candidatePaths) {
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

function excludeChangedFiles(
  changedFiles: readonly string[],
  excludeGlobs: readonly string[]
): string[] {
  return changedFiles.filter(
    (filePath) => !micromatch.isMatch(normalizeGlobPath(filePath), excludeGlobs)
  );
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

function writeDebug(debug: boolean, message: string, writeStderr: (m: string) => void): void {
  if (debug) writeStderr(`DEBUG: ${message}`);
}

function defaultDependencies(): CliRuntimeDependencies {
  return {
    parseArgs: parseCliArgs,
    formatUsage: formatCliUsage,
    resolveRepoRoot: resolveRepoRootFromGit,
    detectBaseBranch: detectBaseBranchFromGit,
    getMergeBase,
    getHeadSha: async () => (await runGit(["rev-parse", "HEAD"])).trim(),
    getChangedFiles,
    loadAgentInstructions: loadAgentInstructionsFromDisk,
    resolveLanguageModel: async (writeStdout, modelOverride) => {
      const configPath = getInstallProviderConfigPath();
      let installConfig;
      try {
        installConfig = loadInstallProviderConfig(configPath);
      } catch {
        if (!process.stdin.isTTY) {
          throw new Error(
            "ai-review is not configured. Run ai-review in an interactive terminal to complete setup."
          );
        }
        writeStdout("ai-review is not configured. Starting setup wizard...");
        const { runSetupWizard, saveWizardConfig } = await import("./setupWizard");
        const wizardResult = await runSetupWizard();
        const savedPath = await saveWizardConfig(wizardResult);
        writeStdout(`\nConfiguration saved to ${savedPath}`);
        writeStdout(`Set ${wizardResult.apiKeyEnv} in your shell, then re-run ai-review.`);
        return SETUP_COMPLETED;
      }
      return createLanguageModel(mergeProviderConfig(installConfig, modelOverride));
    },
    runReviewPipeline,
    renderReport,
    applyAnnotations,
    cleanAnnotations,
    readRepoConfigFile: (repoRoot: string): string | null => {
      try {
        return readFileSync(join(repoRoot, REPO_CONFIG_FILE_NAME), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
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

  if (options.command === "init") {
    let gitRepoRoot: string | null;
    try {
      gitRepoRoot = await deps.resolveRepoRoot();
    } catch {
      gitRepoRoot = null;
    }
    return runInit({
      cwd: process.cwd(),
      force: options.force,
      gitRepoRoot,
      writeStdout: deps.writeStdout,
      writeStderr: deps.writeStderr,
    });
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
    const headSha = await deps.getHeadSha();
    let changedFiles = await deps.getChangedFiles(mergeBase);

    writeDebug(options.debug, `base branch resolved to "${baseBranch}" (origin ref: ${toOriginRef(baseBranch)})`, deps.writeStderr);
    writeDebug(options.debug, `merge-base = ${mergeBase}`, deps.writeStderr);
    writeDebug(options.debug, `HEAD = ${headSha}`, deps.writeStderr);

    let routingConfig: RoutingRuntimeConfig;
    let modelOverride: UserModelConfigOverride | null = null;
    let agentsMap: AgentsMap | null = null;
    let configExclude: readonly string[] | null = null;
    let configExcludeAgents: readonly string[] | null = null;
    try {
      const repoConfigRaw = deps.readRepoConfigFile(repoRootPath);
      const repoConfigOverride = parseRepoConfig(repoConfigRaw);
      agentsMap = repoConfigOverride?.agents ?? null;
      // Fold all agents (built-in overrides + customs) into routing config.
      routingConfig = mergeRoutingConfig(defaultRoutingConfig, agentsToRoutingOverride(agentsMap));
      modelOverride = repoConfigOverride?.model ?? null;
      configExclude = repoConfigOverride?.exclude ?? null;
      configExcludeAgents = repoConfigOverride?.excludeAgents ?? null;
      if (options.debug && repoConfigOverride !== null) {
        const builtInOverrides = agentsMap
          ? Object.entries(agentsMap).filter(([, d]) => !isCustomAgent(d)).map(([n]) => n)
          : [];
        const customAgentNames = agentsMap
          ? Object.entries(agentsMap).filter(([, d]) => isCustomAgent(d)).map(([n]) => n)
          : [];
        deps.writeStderr(
          `DEBUG: loaded ${REPO_CONFIG_FILE_NAME}` +
            (builtInOverrides.length > 0 ? ` — built-in overrides: ${builtInOverrides.join(", ")}` : "") +
            (customAgentNames.length > 0 ? `; custom agents: ${customAgentNames.join(", ")}` : "") +
            (modelOverride ? `; model override: ${modelOverride}` : "") +
            (configExclude ? `; exclude globs: ${configExclude.length}` : "") +
            (configExcludeAgents ? `; excluded agents: ${configExcludeAgents.join(", ")}` : "")
        );
      }
    } catch (err) {
      if (err instanceof RepoConfigError) {
        deps.writeStderr(`Error: ${err.message}`);
        return 1;
      }
      throw err;
    }

    // Validate agent selection eagerly — before the "no changes" early return — so a typo in
    // --agents/--exclude-agents fails fast (exit 1) regardless of whether the diff is empty,
    // matching how ai-review.json is validated up front by parseRepoConfig.
    const availableAgents = Object.keys(routingConfig.agentGlobs);
    const sortedAvailableAgents = [...availableAgents].sort().join(", ");

    // Validate --exclude-agents names against the known agent list.
    if (options.excludeAgents !== undefined) {
      const unknownExcluded = options.excludeAgents.filter(
        (a) => !Object.hasOwn(routingConfig.agentGlobs, a)
      );
      if (unknownExcluded.length > 0) {
        const names = unknownExcluded.map((a) => `"${a}"`).join(", ");
        deps.writeStderr(
          `Error: unknown agent(s) in --exclude-agents: ${names}. Available agents: ${sortedAvailableAgents}.`
        );
        return 1;
      }
    }

    // Build the effective excluded-agents set: union of config and CLI flag.
    const excludedAgentSet = new Set([
      ...(configExcludeAgents ?? []),
      ...(options.excludeAgents ?? []),
    ]);

    // Rule: --agents explicitly requesting a config-excluded agent is an error.
    if (options.agents !== undefined && configExcludeAgents !== null) {
      const conflicting = options.agents.filter((a) => configExcludeAgents.includes(a));
      if (conflicting.length > 0) {
        const names = conflicting.map((a) => `"${a}"`).join(", ");
        deps.writeStderr(
          `Error: agent(s) ${names} excluded by ${REPO_CONFIG_FILE_NAME} cannot be run.`
        );
        return 1;
      }
    }

    // No `--agents` flag → run every configured agent minus excluded ones.
    const requestedAgents =
      options.agents ?? availableAgents.filter((a) => !excludedAgentSet.has(a));
    const filteredRoutingConfig = filterRoutingConfigByAgents(
      routingConfig,
      requestedAgents
    );

    // Validate --agents names: any name not in routing config is an error.
    if (options.agents !== undefined && filteredRoutingConfig.unknownAgents.length > 0) {
      const names = filteredRoutingConfig.unknownAgents.map((a) => `"${a}"`).join(", ");
      deps.writeStderr(
        `Error: unknown agent(s) in --agents: ${names}. Available agents: ${sortedAvailableAgents}.`
      );
      return 1;
    }

    if (filteredRoutingConfig.selectedAgents.length === 0) {
      deps.writeStderr("Error: No agents selected.");
      printDebugWarnings(options.debug, debugWarnings, deps.writeStderr);
      return 1;
    }

    // Effective exclusions: union of repo-config `exclude` and `--exclude` globs (dedup).
    const effectiveExclude = [...new Set([...(configExclude ?? []), ...(options.exclude ?? [])])];
    if (effectiveExclude.length > 0) {
      changedFiles = excludeChangedFiles(changedFiles, effectiveExclude);
    }

    writeDebug(options.debug, `changed files: ${changedFiles.length}`, deps.writeStderr);

    if (changedFiles.length === 0) {
      writeDebug(options.debug, `reproduce locally: git diff --name-only ${mergeBase}..HEAD`, deps.writeStderr);
      printDebugWarnings(options.debug, debugWarnings, deps.writeStderr);
      if (options.json) {
        deps.writeStdout("[]");
      } else {
        deps.writeStdout(`No changes detected against ${toOriginRef(baseBranch)}.`);
      }
      return 0;
    }

    // Custom agents declare an explicit instructionsFile; build overrides map for those only.
    const instructionFileOverrides: Record<string, string> = {};
    if (agentsMap !== null) {
      for (const [name, definition] of Object.entries(agentsMap)) {
        if (isCustomAgent(definition)) {
          instructionFileOverrides[name] = definition.instructionsFile;
        }
      }
    }

    const instructionsResult = await deps.loadAgentInstructions(
      repoRootPath,
      filteredRoutingConfig.selectedAgents,
      instructionFileOverrides
    );
    debugWarnings.push(...instructionsResult.warnings);

    // Fail-fast: a selected custom agent (one with instructionsFile) without loadable instructions
    // is a configuration error.
    if (agentsMap !== null) {
      const instructions = instructionsResult.instructions;
      const hasInstruction = (agent: string): boolean =>
        instructions instanceof Map ? instructions.has(agent) : Object.hasOwn(instructions, agent);
      const missingCustomAgents = filteredRoutingConfig.selectedAgents.filter((agent) => {
        const def = (agentsMap as AgentsMap)[agent];
        return def !== undefined && isCustomAgent(def) && !hasInstruction(agent);
      });
      if (missingCustomAgents.length > 0) {
        const details = missingCustomAgents
          .map((agent) => `"${agent}" (${(agentsMap as AgentsMap)[agent]?.instructionsFile})`)
          .join(", ");
        deps.writeStderr(
          `Error: ${REPO_CONFIG_FILE_NAME}: could not load instructions for custom agent(s): ${details}.`
        );
        return 1;
      }
    }

    const modelOrSetup = await deps.resolveLanguageModel(deps.writeStdout, modelOverride);
    if (modelOrSetup === SETUP_COMPLETED) {
      return 0;
    }
    const model = modelOrSetup;

    const reviewResult = await deps.runReviewPipeline({
      repoRootPath,
      mergeBase,
      changedFiles,
      routingConfig: filteredRoutingConfig.config,
      agentInstructions: instructionsResult.instructions,
      model,
      maxCharLimit: DEFAULT_MAX_CHAR_LIMIT,
      concurrency: options.maxParallel,
      retry: DEFAULT_RETRY,
      minSeverity: options.minSeverity,
      onProgress: (msg) => deps.writeStderr(msg),
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
      deps.writeStderr(
        `Applied ${annotationResult.appliedCount} annotations in ${annotationResult.changedFiles.length} files.`
      );
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
  process.exitCode = await runCli(argv);
}

if (require.main === module) {
  void main();
}

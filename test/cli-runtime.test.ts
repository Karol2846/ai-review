import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliRuntimeDependencies, SETUP_COMPLETED } from "../src/cli";
import type { AggregatedFinding } from "../src/aggregator";
import {
  INSTALL_PROVIDER_CONFIG_FILE_NAME,
  getInstallProviderConfigPath,
  loadInstallProviderConfig,
} from "../src/installProviderConfig";
import { createLanguageModel } from "../src/llmClient";
import type {
  ReviewPipelineWarning,
  RunReviewPipelineInput,
  RunReviewPipelineResult,
} from "../src/reviewPipeline";
import type { RoutingRuntimeConfig } from "../src/routingTypes";

const installProviderConfigPath = getInstallProviderConfigPath(process.cwd());

const VALID_INSTALL_CONFIG = JSON.stringify({
  provider: "openai-compatible",
  model: "gpt-4o-mini",
  apiKeyEnv: "AI_REVIEW_TEST_API_KEY",
}, null, 2) + "\n";

function writeInstallProviderConfig(content: string): void {
  writeFileSync(installProviderConfigPath, content, "utf8");
}

function removeInstallProviderConfig(): void {
  rmSync(installProviderConfigPath, { force: true });
}

function createRoutingConfig(): RoutingRuntimeConfig {
  return {
    unmatchedFilesPolicy: "skip",
    agentGlobs: {
      tester: ["**/*.ts"],
      architect: ["**/*.ts"],
      performance: ["**/*.sql"],
    },
  };
}

function createPipelineResult(
  findings: readonly AggregatedFinding[] = [],
  warnings: readonly ReviewPipelineWarning[] = []
): RunReviewPipelineResult {
  return {
    findings,
    warnings,
    metadata: {
      contextFileCount: 0,
      contextWarningCount: 0,
      routedFileCount: 0,
      routedAgentCount: 0,
      batchCount: 0,
      batchCountByAgent: {},
      parsedBatchCount: 0,
      failedBatchCount: 0,
      failedBatches: [],
      runner: {
        totalBatches: 0,
        successCount: 0,
        failureCount: 0,
        warningCount: 0,
        errorCount: 0,
        warnings: [],
        errors: [],
      },
      aggregation: {
        batchCount: 0,
        minSeverity: "info",
        inputFindingCount: 0,
        findingsAfterSeverityFilter: 0,
        filteredOutBySeverity: 0,
        filteredOutByUnknownSeverity: 0,
        countsBySeverity: {
          critical: 0,
          warning: 0,
          info: 0,
        },
        dedup: {
          totalBeforeDedup: 0,
          totalAfterDedup: 0,
          duplicatesRemoved: 0,
          collisionGroupCount: 0,
        },
      },
    },
    routedFilesByAgent: new Map(),
    batches: [],
    parsedBatches: [],
  };
}

interface RuntimeTestDeps {
  readonly overrides: Partial<CliRuntimeDependencies>;
  readonly writeStdout: ReturnType<typeof vi.fn<(message: string) => void>>;
  readonly writeStderr: ReturnType<typeof vi.fn<(message: string) => void>>;
  readonly resolveRepoRoot: ReturnType<typeof vi.fn<() => Promise<string>>>;
  readonly detectBaseBranch: ReturnType<typeof vi.fn<() => Promise<string>>>;
  readonly getMergeBase: ReturnType<typeof vi.fn<(baseBranch: string) => Promise<string>>>;
  readonly getHeadSha: ReturnType<typeof vi.fn<() => Promise<string>>>;
  readonly getChangedFiles: ReturnType<typeof vi.fn<(mergeBase: string) => Promise<string[]>>>;
  readonly loadAgentInstructions: ReturnType<
    typeof vi.fn<
      (
        repoRootPath: string,
        agentNames: readonly string[]
      ) => ReturnType<CliRuntimeDependencies["loadAgentInstructions"]>
    >
  >;
  readonly runReviewPipeline: ReturnType<
    typeof vi.fn<(input: RunReviewPipelineInput) => ReturnType<CliRuntimeDependencies["runReviewPipeline"]>>
  >;
  readonly renderReport: ReturnType<typeof vi.fn<CliRuntimeDependencies["renderReport"]>>;
  readonly applyAnnotations: ReturnType<typeof vi.fn<CliRuntimeDependencies["applyAnnotations"]>>;
  readonly cleanAnnotations: ReturnType<typeof vi.fn<CliRuntimeDependencies["cleanAnnotations"]>>;
  readonly readRepoConfigFile: ReturnType<typeof vi.fn<CliRuntimeDependencies["readRepoConfigFile"]>>;
  readonly resolveLanguageModel: ReturnType<typeof vi.fn<CliRuntimeDependencies["resolveLanguageModel"]>>;
}

function createRuntimeDeps(): RuntimeTestDeps {
  const writeStdout = vi.fn<(message: string) => void>();
  const writeStderr = vi.fn<(message: string) => void>();
  const resolveRepoRoot = vi.fn<() => Promise<string>>().mockResolvedValue("C:\\repo");
  const detectBaseBranch = vi.fn<() => Promise<string>>().mockResolvedValue("main");
  const getMergeBase = vi.fn<(baseBranch: string) => Promise<string>>().mockResolvedValue("merge-base");
  const getHeadSha = vi.fn<() => Promise<string>>().mockResolvedValue("head-sha-abc123");
  const getChangedFiles = vi.fn<(mergeBase: string) => Promise<string[]>>().mockResolvedValue([
    "src/service.ts",
  ]);
  const loadAgentInstructions = vi
    .fn<
      (
        repoRootPath: string,
        agentNames: readonly string[]
      ) => ReturnType<CliRuntimeDependencies["loadAgentInstructions"]>
    >()
    .mockResolvedValue({
      instructions: {
        tester: "Tester instructions",
        architect: "Architect instructions",
      },
      warnings: [],
    });
  const runReviewPipeline = vi
    .fn<(input: RunReviewPipelineInput) => ReturnType<CliRuntimeDependencies["runReviewPipeline"]>>()
    .mockResolvedValue(createPipelineResult());
  const renderReport = vi.fn<CliRuntimeDependencies["renderReport"]>().mockReturnValue("REPORT");
  const applyAnnotations = vi
    .fn<CliRuntimeDependencies["applyAnnotations"]>()
    .mockResolvedValue({
      appliedCount: 1,
      changedFiles: ["src/service.ts"],
      skippedMissingFileCount: 0,
      skippedUnsupportedFileCount: 0,
    });
  const cleanAnnotations = vi
    .fn<CliRuntimeDependencies["cleanAnnotations"]>()
    .mockResolvedValue({
      cleanedFilesCount: 2,
      cleanedLineCount: 6,
    });
  const resolveLanguageModel = vi
    .fn<CliRuntimeDependencies["resolveLanguageModel"]>()
    .mockImplementation(async () =>
      createLanguageModel(loadInstallProviderConfig(installProviderConfigPath))
    );
  const readRepoConfigFile = vi
    .fn<CliRuntimeDependencies["readRepoConfigFile"]>()
    .mockReturnValue(null);

  return {
    overrides: {
      writeStdout,
      writeStderr,
      resolveRepoRoot,
      detectBaseBranch,
      getMergeBase,
      getHeadSha,
      getChangedFiles,
      loadAgentInstructions,
      runReviewPipeline,
      renderReport,
      applyAnnotations,
      cleanAnnotations,
      readRepoConfigFile,
      resolveLanguageModel,
    },
    writeStdout,
    writeStderr,
    resolveRepoRoot,
    detectBaseBranch,
    getMergeBase,
    getHeadSha,
    getChangedFiles,
    loadAgentInstructions,
    runReviewPipeline,
    renderReport,
    applyAnnotations,
    cleanAnnotations,
    readRepoConfigFile,
    resolveLanguageModel,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  writeInstallProviderConfig(VALID_INSTALL_CONFIG);
  process.env.AI_REVIEW_TEST_API_KEY = "test-key";
});

afterEach(() => {
  removeInstallProviderConfig();
  delete process.env.AI_REVIEW_TEST_API_KEY;
});

describe("runCli runtime flow", () => {
  it("prints usage and exits successfully for --help", async () => {
    const deps = createRuntimeDeps();

    const exitCode = await runCli(["--help"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("Usage: ai-review [OPTIONS]"));
    expect(deps.resolveRepoRoot).not.toHaveBeenCalled();
  });

  it("runs clean mode and skips review pipeline", async () => {
    const deps = createRuntimeDeps();

    const exitCode = await runCli(["--clean"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.resolveRepoRoot).toHaveBeenCalledTimes(1);
    expect(deps.cleanAnnotations).toHaveBeenCalledWith("C:\\repo");
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
  });

  it("loads bundled agent instructions when reviewed repo has no local agents directory", async () => {
    const deps = createRuntimeDeps();
    const repoWithoutAgents = join(process.cwd(), ".cli-runtime-no-agents");
    rmSync(repoWithoutAgents, { recursive: true, force: true });
    mkdirSync(repoWithoutAgents, { recursive: true });

    deps.resolveRepoRoot.mockResolvedValue(repoWithoutAgents);
    deps.runReviewPipeline.mockImplementation(async (input) => {
      const instructions = input.agentInstructions as Record<string, string>;
      expect(instructions.tester?.trim().length ?? 0).toBeGreaterThan(0);
      return createPipelineResult();
    });

    const { loadAgentInstructions: _ignored, ...overridesWithoutAgentLoader } = deps.overrides;
    const exitCode = await runCli(["--json", "--agents", "tester"], overridesWithoutAgentLoader);

    expect(exitCode).toBe(0);
    expect(deps.runReviewPipeline).toHaveBeenCalledTimes(1);

    rmSync(repoWithoutAgents, { recursive: true, force: true });
  });

  it("applies --base, --exclude, --agents, --severity, --parallel and passes model to pipeline", async () => {
    const deps = createRuntimeDeps();
    deps.getChangedFiles.mockResolvedValue(["src/service.ts", "README.md", "scripts/setup.sh"]);

    const finding: AggregatedFinding = {
      file: "src/service.ts",
      line: 12,
      endLine: 12,
      agent: "tester",
      severity: "warning",
      category: "missing-test",
      message: "Missing regression test for empty payload.",
      suggestion: "Add a test for empty payload handling.",
      fingerprint: "f".repeat(64),
    };
    deps.runReviewPipeline.mockResolvedValue(createPipelineResult([finding]));

    const exitCode = await runCli(
      [
        "--json",
        "--base",
        "develop",
        "--exclude",
        "README.md,scripts/**",
        "--agents",
        "tester,architect",
        "--severity",
        "warning",
        "--parallel",
        "3",
      ],
      deps.overrides
    );

    expect(exitCode).toBe(0);
    expect(deps.detectBaseBranch).not.toHaveBeenCalled();
    expect(deps.getMergeBase).toHaveBeenCalledWith("develop");
    expect(deps.runReviewPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        mergeBase: "merge-base",
        changedFiles: ["src/service.ts"],
        minSeverity: "warning",
        concurrency: 3,
        model: expect.anything(),
        routingConfig: expect.objectContaining({
          agentGlobs: expect.objectContaining({
            tester: expect.any(Array),
            architect: expect.any(Array),
          }),
        }),
      })
    );
    const reviewInput = deps.runReviewPipeline.mock.calls[0]?.[0];
    const routedAgents = reviewInput ? Object.keys(reviewInput.routingConfig.agentGlobs).sort() : [];
    expect(routedAgents).toEqual(["architect", "tester"]);
    expect(deps.writeStdout).toHaveBeenCalledWith(JSON.stringify([finding]));
    expect(deps.renderReport).not.toHaveBeenCalled();
    expect(deps.applyAnnotations).not.toHaveBeenCalled();
  });

  it("passes a LanguageModel when install config is valid", async () => {
    const deps = createRuntimeDeps();

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(0);
    const reviewInput = deps.runReviewPipeline.mock.calls[0]?.[0];
    expect(reviewInput?.model).toBeDefined();
    expect(typeof reviewInput?.model).toBe("object");
  });

  it("returns error exit code when install config is missing", async () => {
    removeInstallProviderConfig();
    const deps = createRuntimeDeps();

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(1);
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("Error:"));
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
  });

  it("returns error exit code when API key env var is missing", async () => {
    delete process.env.AI_REVIEW_TEST_API_KEY;
    const deps = createRuntimeDeps();

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(1);
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("Error:"));
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
  });

  it("returns empty JSON when all files are excluded via --exclude", async () => {
    const deps = createRuntimeDeps();
    deps.getChangedFiles.mockResolvedValue(["README.md"]);

    const exitCode = await runCli(["--json", "--exclude", "**/*.md"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
    expect(deps.writeStdout).toHaveBeenCalledWith("[]");
  });

  it("excludes files matching the ai-review.json exclude section", async () => {
    const deps = createRuntimeDeps();
    deps.getChangedFiles.mockResolvedValue(["src/service.ts", "src/types.generated.ts"]);
    deps.readRepoConfigFile.mockReturnValue(JSON.stringify({ exclude: ["**/*.generated.ts"] }));

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.runReviewPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ changedFiles: ["src/service.ts"] })
    );
  });

  it("unions config exclude with --exclude globs (dedup)", async () => {
    const deps = createRuntimeDeps();
    deps.getChangedFiles.mockResolvedValue([
      "src/service.ts",
      "src/types.generated.ts",
      "vendor/lib.ts",
    ]);
    deps.readRepoConfigFile.mockReturnValue(JSON.stringify({ exclude: ["**/*.generated.ts"] }));

    // CLI repeats the config glob (dedup) and adds a new one.
    const exitCode = await runCli(
      ["--json", "--exclude", "**/*.generated.ts,vendor/**"],
      deps.overrides
    );

    expect(exitCode).toBe(0);
    expect(deps.runReviewPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ changedFiles: ["src/service.ts"] })
    );
  });

  it("prints report, annotates findings, and emits debug warnings", async () => {
    const deps = createRuntimeDeps();
    deps.loadAgentInstructions.mockResolvedValue({
      instructions: {
        tester: "Tester instructions",
        architect: "Architect instructions",
      },
      warnings: ["Missing optional instruction"],
    });

    const finding: AggregatedFinding = {
      file: "src/service.ts",
      line: 3,
      endLine: 3,
      agent: "architect",
      severity: "critical",
      category: "design",
      message: "Service constructor has too many responsibilities.",
      suggestion: "Split service construction into dedicated factories.",
      fingerprint: "a".repeat(64),
    };
    deps.runReviewPipeline.mockResolvedValue(
      createPipelineResult([finding], [
        {
          stage: "runner",
          level: "warning",
          code: "COMMAND_FAILED",
          message: "adapter invocation timed out",
          batchId: "architect::001",
          agent: "architect",
        },
      ])
    );

    const exitCode = await runCli(["--report", "--debug"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.renderReport).toHaveBeenCalledWith([finding]);
    expect(deps.writeStdout).toHaveBeenCalledWith("REPORT");
    expect(deps.applyAnnotations).toHaveBeenCalledWith([finding], "C:\\repo");
    expect(
      deps.writeStderr.mock.calls.some(([message]) =>
        String(message).includes("Pipeline runner warning (COMMAND_FAILED)")
      )
    ).toBe(true);
  });

  it("returns non-zero and prints usage for invalid arguments", async () => {
    const deps = createRuntimeDeps();

    const exitCode = await runCli(["--does-not-exist"], deps.overrides);

    expect(exitCode).toBe(1);
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("Error:"));
    expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("Usage: ai-review [OPTIONS]"));
    expect(deps.resolveRepoRoot).not.toHaveBeenCalled();
  });

  it("emits debug diagnostics on stderr when --debug and no changed files", async () => {
    const deps = createRuntimeDeps();
    deps.getChangedFiles.mockResolvedValue([]);
    deps.getMergeBase.mockResolvedValue("deadbeef1234");
    deps.getHeadSha.mockResolvedValue("cafebabe5678");

    const exitCode = await runCli(["--debug"], deps.overrides);

    expect(exitCode).toBe(0);
    const stderrLines = deps.writeStderr.mock.calls.map(([m]) => String(m));
    expect(stderrLines.some((l) => l.includes('DEBUG: base branch resolved to "main"'))).toBe(true);
    expect(stderrLines.some((l) => l.includes("DEBUG: merge-base = deadbeef1234"))).toBe(true);
    expect(stderrLines.some((l) => l.includes("DEBUG: HEAD = cafebabe5678"))).toBe(true);
    expect(stderrLines.some((l) => l.includes("DEBUG: changed files: 0"))).toBe(true);
    expect(stderrLines.some((l) => l.includes("DEBUG: reproduce locally:"))).toBe(true);
  });

  it("does not emit DEBUG lines when --debug is not set", async () => {
    const deps = createRuntimeDeps();
    deps.getChangedFiles.mockResolvedValue([]);

    const exitCode = await runCli([], deps.overrides);

    expect(exitCode).toBe(0);
    const stderrLines = deps.writeStderr.mock.calls.map(([m]) => String(m));
    expect(stderrLines.every((l) => !l.startsWith("DEBUG:"))).toBe(true);
  });

  it("returns exit code 0 without running the pipeline when resolveLanguageModel signals setup-completed", async () => {
    const deps = createRuntimeDeps();
    deps.resolveLanguageModel.mockResolvedValue(SETUP_COMPLETED);

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
  });

  it("passes the ai-review.json model override to resolveLanguageModel", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(
      JSON.stringify({ model: "gpt-4o-mini" })
    );

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.resolveLanguageModel).toHaveBeenCalledWith(expect.any(Function), "gpt-4o-mini");
  });

  it("passes a null model override when ai-review.json has no model section", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(null);

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.resolveLanguageModel).toHaveBeenCalledWith(expect.any(Function), null);
  });

  it("runs every configured agent when --agents is not provided", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(null);

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(0);
    const reviewInput = deps.runReviewPipeline.mock.calls[0]?.[0];
    const routedAgents = reviewInput ? Object.keys(reviewInput.routingConfig.agentGlobs).sort() : [];
    expect(routedAgents).toEqual(
      ["architect", "clean-coder", "ddd-reviewer", "performance", "tester"]
    );
  });

  it("registers a custom agent from ai-review.json and routes it through the pipeline", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(
      JSON.stringify({
        agents: { security: { globs: ["**/*.ts"], instructionsFile: "agents/security.agent.md" } },
      })
    );
    deps.loadAgentInstructions.mockResolvedValue({
      instructions: { tester: "Tester", architect: "Architect", security: "Security review" },
      warnings: [],
    });

    const exitCode = await runCli(["--agents", "security", "--json"], deps.overrides);

    expect(exitCode).toBe(0);
    // The explicit instructionsFile path is forwarded to the loader as an override.
    expect(deps.loadAgentInstructions).toHaveBeenCalledWith(
      expect.any(String),
      ["security"],
      { security: "agents/security.agent.md" }
    );
    const reviewInput = deps.runReviewPipeline.mock.calls[0]?.[0];
    expect(reviewInput?.routingConfig.agentGlobs["security"]).toEqual(["**/*.ts"]);
  });

  it("fails fast when a selected custom agent has no loadable instruction", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(
      JSON.stringify({
        agents: { security: { globs: ["**/*.ts"], instructionsFile: "agents/missing.agent.md" } },
      })
    );
    // Loader cannot find the custom agent's instruction.
    deps.loadAgentInstructions.mockResolvedValue({
      instructions: { tester: "Tester", architect: "Architect" },
      warnings: ["Failed to load instruction for \"security\"."],
    });

    const exitCode = await runCli(["--agents", "security", "--json"], deps.overrides);

    expect(exitCode).toBe(1);
    expect(deps.writeStderr).toHaveBeenCalledWith(
      expect.stringContaining("could not load instructions for custom agent")
    );
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
  });

  it("recognizes custom-agent instructions delivered as a ReadonlyMap (not a plain object)", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(
      JSON.stringify({
        agents: { security: { globs: ["**/*.ts"], instructionsFile: "agents/security.agent.md" } },
      })
    );
    // AgentInstructionsByAgent is `ReadonlyMap | Record`. When the loader returns a Map, the
    // fail-fast must use Map.has — not Object.hasOwn (which would falsely report the agent missing).
    deps.loadAgentInstructions.mockResolvedValue({
      instructions: new Map([["security", "Security review"]]),
      warnings: [],
    });

    const exitCode = await runCli(["--agents", "security", "--json"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.runReviewPipeline).toHaveBeenCalled();
    expect(deps.writeStderr).not.toHaveBeenCalledWith(
      expect.stringContaining("could not load instructions for custom agent")
    );
  });

  // --- excludeAgents ---

  it("omits agents listed in ai-review.json excludeAgents from the default run", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(
      JSON.stringify({ excludeAgents: ["ddd-reviewer", "performance"] })
    );

    const exitCode = await runCli(["--json"], deps.overrides);

    expect(exitCode).toBe(0);
    const reviewInput = deps.runReviewPipeline.mock.calls[0]?.[0];
    const routedAgents = reviewInput ? Object.keys(reviewInput.routingConfig.agentGlobs).sort() : [];
    expect(routedAgents).toEqual(["architect", "clean-coder", "tester"]);
    expect(routedAgents).not.toContain("ddd-reviewer");
    expect(routedAgents).not.toContain("performance");
  });

  it("omits agents listed via --exclude-agents from the default run", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(null);

    const exitCode = await runCli(["--json", "--exclude-agents", "tester,architect"], deps.overrides);

    expect(exitCode).toBe(0);
    const reviewInput = deps.runReviewPipeline.mock.calls[0]?.[0];
    const routedAgents = reviewInput ? Object.keys(reviewInput.routingConfig.agentGlobs).sort() : [];
    expect(routedAgents).not.toContain("tester");
    expect(routedAgents).not.toContain("architect");
    expect(routedAgents).toContain("clean-coder");
  });

  it("unions config excludeAgents with --exclude-agents (dedup)", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(
      JSON.stringify({ excludeAgents: ["ddd-reviewer"] })
    );

    // --exclude-agents repeats the config agent plus adds one new one.
    const exitCode = await runCli(
      ["--json", "--exclude-agents", "ddd-reviewer,performance"],
      deps.overrides
    );

    expect(exitCode).toBe(0);
    const reviewInput = deps.runReviewPipeline.mock.calls[0]?.[0];
    const routedAgents = reviewInput ? Object.keys(reviewInput.routingConfig.agentGlobs).sort() : [];
    expect(routedAgents).toEqual(["architect", "clean-coder", "tester"]);
  });

  it("exits 1 with error when all agents are excluded", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(null);

    const exitCode = await runCli(
      ["--json", "--exclude-agents", "clean-coder,tester,architect,ddd-reviewer,performance"],
      deps.overrides
    );

    expect(exitCode).toBe(1);
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("No agents selected"));
  });

  it("exits 1 with error when --exclude-agents contains an unknown agent name", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(null);

    const exitCode = await runCli(
      ["--json", "--exclude-agents", "bogus"],
      deps.overrides
    );

    expect(exitCode).toBe(1);
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining('"bogus"'));
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("--exclude-agents"));
  });

  it("exits 1 with error when --agents contains an unknown agent name", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(null);

    const exitCode = await runCli(["--json", "--agents", "nonexistent"], deps.overrides);

    expect(exitCode).toBe(1);
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining('"nonexistent"'));
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining("--agents"));
  });

  it("exits 1 with error when --agents mixes valid and unknown agent names", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(null);

    const exitCode = await runCli(["--json", "--agents", "tester,bogus"], deps.overrides);

    expect(exitCode).toBe(1);
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
    expect(deps.writeStderr).toHaveBeenCalledWith(expect.stringContaining('"bogus"'));
  });

  it("exits 1 with a clear error when --agents requests a config-excluded agent", async () => {
    const deps = createRuntimeDeps();
    deps.readRepoConfigFile.mockReturnValue(
      JSON.stringify({ excludeAgents: ["ddd-reviewer"] })
    );

    const exitCode = await runCli(["--agents", "ddd-reviewer", "--json"], deps.overrides);

    expect(exitCode).toBe(1);
    expect(deps.writeStderr).toHaveBeenCalledWith(
      expect.stringContaining('"ddd-reviewer"')
    );
    expect(deps.writeStderr).toHaveBeenCalledWith(
      expect.stringContaining("excluded")
    );
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
  });
});

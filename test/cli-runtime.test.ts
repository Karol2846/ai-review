import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliRuntimeDependencies } from "../src/cli";
import type { AggregatedFinding } from "../src/aggregator";
import type {
  ReviewPipelineWarning,
  RunReviewPipelineInput,
  RunReviewPipelineResult,
} from "../src/reviewPipeline";
import type { RoutingRuntimeConfig } from "../src/routingTypes";

function createRoutingConfig(): RoutingRuntimeConfig {
  return {
    unmatchedFilesPolicy: "skip",
    userConfigMergeMode: "override",
    invalidUserConfigPolicy: "fallback_with_warning",
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
      parserWarningCount: 0,
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
  readonly getChangedFiles: ReturnType<typeof vi.fn<(mergeBase: string) => Promise<string[]>>>;
  readonly loadRoutingConfig: ReturnType<
    typeof vi.fn<(repoRootPath: string) => ReturnType<CliRuntimeDependencies["loadRoutingConfig"]>>
  >;
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
}

function createRuntimeDeps(): RuntimeTestDeps {
  const writeStdout = vi.fn<(message: string) => void>();
  const writeStderr = vi.fn<(message: string) => void>();
  const resolveRepoRoot = vi.fn<() => Promise<string>>().mockResolvedValue("C:\\repo");
  const detectBaseBranch = vi.fn<() => Promise<string>>().mockResolvedValue("main");
  const getMergeBase = vi.fn<(baseBranch: string) => Promise<string>>().mockResolvedValue("merge-base");
  const getChangedFiles = vi.fn<(mergeBase: string) => Promise<string[]>>().mockResolvedValue([
    "src/service.ts",
  ]);
  const loadRoutingConfig = vi
    .fn<(repoRootPath: string) => ReturnType<CliRuntimeDependencies["loadRoutingConfig"]>>()
    .mockReturnValue({
      config: createRoutingConfig(),
      warnings: [],
    });
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

  return {
    overrides: {
      writeStdout,
      writeStderr,
      resolveRepoRoot,
      detectBaseBranch,
      getMergeBase,
      getChangedFiles,
      loadRoutingConfig,
      loadAgentInstructions,
      runReviewPipeline,
      renderReport,
      applyAnnotations,
      cleanAnnotations,
    },
    writeStdout,
    writeStderr,
    resolveRepoRoot,
    detectBaseBranch,
    getMergeBase,
    getChangedFiles,
    loadRoutingConfig,
    loadAgentInstructions,
    runReviewPipeline,
    renderReport,
    applyAnnotations,
    cleanAnnotations,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
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

  it("applies --base, --files, --agents, --severity, --parallel and prints raw JSON", async () => {
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
        "--files",
        "src/**/*.ts",
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
        routingConfig: expect.objectContaining({
          agentGlobs: expect.objectContaining({
            tester: ["**/*.ts"],
            architect: ["**/*.ts"],
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

  it("returns empty JSON when no files remain after --files filter", async () => {
    const deps = createRuntimeDeps();
    deps.getChangedFiles.mockResolvedValue(["README.md"]);

    const exitCode = await runCli(["--json", "--files", "src/**/*.ts"], deps.overrides);

    expect(exitCode).toBe(0);
    expect(deps.runReviewPipeline).not.toHaveBeenCalled();
    expect(deps.writeStdout).toHaveBeenCalledWith("[]");
  });

  it("prints report, annotates findings, and emits debug warnings", async () => {
    const deps = createRuntimeDeps();
    deps.loadRoutingConfig.mockReturnValue({
      config: createRoutingConfig(),
      warnings: ["Routing config fallback warning"],
    });
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
          message: "copilot invocation timed out",
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
        String(message).includes("Routing config fallback warning")
      )
    ).toBe(true);
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
});

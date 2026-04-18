import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CopilotServiceError, runCopilotPrompt } from "./copilot";
import { loadRoutingConfig } from "./config";
import { createBatches, type FileContext } from "./batcher";
import { buildFileContexts } from "./contextBuilder";
import { defaultRoutingConfig } from "./defaultConfig";
import { getChangedFiles, getFileDiff } from "./git";
import { buildAgentBatchPrompt } from "./promptBuilder";
import { routeFilesToAgents } from "./router";
import { AGENT_NAMES, type RoutingRuntimeConfig } from "./routingTypes";

const SMOKE_FIXTURES_ROOT = join(process.cwd(), `.smoke-fixtures-${process.pid}`);

function writeConfigFixture(name: string, config: unknown): string {
  const fixtureRoot = join(SMOKE_FIXTURES_ROOT, name);
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, ".ai-reviewrc.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return fixtureRoot;
}

async function runSmokeChecks(): Promise<void> {
  rmSync(SMOKE_FIXTURES_ROOT, { recursive: true, force: true });
  mkdirSync(SMOKE_FIXTURES_ROOT, { recursive: true });

  try {
    const routingLoadResult = loadRoutingConfig(process.cwd());
    assert.ok(routingLoadResult.config, "loadRoutingConfig should return a config object");
    assert.ok(Array.isArray(routingLoadResult.warnings), "loadRoutingConfig should return warnings");

    const routed = routeFilesToAgents(
      ["src/git.ts", "src/domain/OrderAggregate.ts", "README.md", "docs/notes.txt"],
      routingLoadResult.config
    );
    assert.ok(routed instanceof Map, "routeFilesToAgents should return a map");
    assert.deepEqual([...routed.keys()], [...AGENT_NAMES], "Default agent ordering should be stable");
    for (const agent of AGENT_NAMES) {
      assert.ok(routed.has(agent), `Expected routing entry for agent: ${agent}`);
      const files = routed.get(agent);
      assert.ok(Array.isArray(files), `Expected an array for agent ${agent}`);
    }

    const unmatchedFile = "docs/notes.txt";
    const unmatchedAssignments = AGENT_NAMES.flatMap((agent) =>
      (routed.get(agent) ?? []).filter((file) => file === unmatchedFile)
    );
    assert.equal(unmatchedAssignments.length, 0, "Unmatched files should be skipped");

    const defaultRouted = routeFilesToAgents(["src/router.ts"], defaultRoutingConfig);
    assert.ok(defaultRouted instanceof Map, "defaultRoutingConfig should be valid for routing");

    const dynamicRoutingConfig: RoutingRuntimeConfig = {
      ...defaultRoutingConfig,
      agentGlobs: {
        ...defaultRoutingConfig.agentGlobs,
        "z-custom": ["**/*.md"],
        "a-custom": ["**/*.txt"],
      },
    };
    const dynamicRouted = routeFilesToAgents(
      ["README.md", "docs/notes.txt", "README.md"],
      dynamicRoutingConfig
    );
    assert.ok(dynamicRouted.has("a-custom"), "Expected dynamic routing entry for a-custom");
    assert.ok(dynamicRouted.has("z-custom"), "Expected dynamic routing entry for z-custom");
    assert.deepEqual(
      [...dynamicRouted.keys()],
      [...AGENT_NAMES, "a-custom", "z-custom"],
      "Dynamic agent ordering should be deterministic"
    );
    assert.deepEqual(dynamicRouted.get("a-custom"), ["docs/notes.txt"]);
    assert.deepEqual(dynamicRouted.get("z-custom"), ["README.md"]);

    const mixedConfigRoot = writeConfigFixture("partial-merge", {
      invalidRootFlag: true,
      agentGlobs: {
        tester: ["**/*.spec.ts", 42],
        architect: 7,
        performance: ["**/*.sql", ""],
        "custom-docs": ["docs/**/*.md"],
        "bad-agent": [null],
      },
    });
    const mixedConfigLoadResult = loadRoutingConfig(mixedConfigRoot);
    assert.equal(
      mixedConfigLoadResult.warnings.some((warning) => warning.includes('unsupported root key "invalidRootFlag"')),
      true,
      "Invalid root fragments should emit warnings"
    );
    assert.equal(
      mixedConfigLoadResult.warnings.some((warning) =>
        warning.includes('"agentGlobs.architect" must be an array of non-empty glob strings.')
      ),
      true,
      "Non-array agent fragments should emit warnings"
    );
    assert.equal(
      mixedConfigLoadResult.warnings.some((warning) =>
        warning.includes('"agentGlobs.tester[1]" must be a non-empty string.')
      ),
      true,
      "Invalid primitive pattern entries should emit warnings"
    );
    assert.equal(
      mixedConfigLoadResult.warnings.some((warning) =>
        warning.includes('"agentGlobs.performance[1]" must be a non-empty string.')
      ),
      true,
      "Invalid string pattern entries should emit warnings"
    );
    assert.equal(
      mixedConfigLoadResult.warnings.some((warning) =>
        warning.includes('"agentGlobs.bad-agent[0]" must be a non-empty string.')
      ),
      true,
      "Bad primitive values should emit warnings"
    );
    assert.equal(
      mixedConfigLoadResult.warnings.some((warning) => warning.includes("unsupported agent")),
      false,
      "Unknown agent keys should be accepted as dynamic additions"
    );

    assert.deepEqual(
      mixedConfigLoadResult.config.agentGlobs.tester,
      ["**/*.spec.ts"],
      "Partial merge should keep valid entries in a mixed override fragment"
    );
    assert.deepEqual(
      mixedConfigLoadResult.config.agentGlobs.architect,
      defaultRoutingConfig.agentGlobs.architect,
      "Invalid sibling fragment should not replace default agent patterns"
    );
    assert.deepEqual(
      mixedConfigLoadResult.config.agentGlobs.performance,
      ["**/*.sql"],
      "Valid sibling entries should survive even when one entry is invalid"
    );
    assert.equal(
      Object.hasOwn(mixedConfigLoadResult.config.agentGlobs, "bad-agent"),
      false,
      "Fully invalid fragments should be ignored in merged config"
    );
    assert.deepEqual(
      mixedConfigLoadResult.config.agentGlobs["custom-docs"],
      ["docs/**/*.md"],
      "New agent keys from user config should be merged"
    );

    const configDrivenRouted = routeFilesToAgents(
      ["docs/guide.md", "src/app.spec.ts", "src/perf/query.sql", "src/config/settings.ts"],
      mixedConfigLoadResult.config
    );
    assert.deepEqual(
      [...configDrivenRouted.keys()],
      [...AGENT_NAMES, "custom-docs"],
      "Config-defined dynamic agents should be routable and ordered deterministically"
    );
    assert.deepEqual(
      configDrivenRouted.get("custom-docs"),
      ["docs/guide.md"],
      "Dynamically added agent should receive matching files"
    );
    assert.deepEqual(
      configDrivenRouted.get("tester"),
      ["src/app.spec.ts"],
      "Valid tester override should remain active despite invalid siblings"
    );
    assert.deepEqual(
      configDrivenRouted.get("architect"),
      ["src/config/settings.ts"],
      "Invalid architect override fragment should not affect architect routing"
    );
    assert.deepEqual(
      configDrivenRouted.get("performance"),
      ["src/perf/query.sql"],
      "Invalid fragment should only affect that fragment, not valid performance patterns"
    );

    const contextBuilderProbe = await buildFileContexts(process.cwd(), "HEAD");
    assert.ok(
      Array.isArray(contextBuilderProbe.contexts),
      "buildFileContexts should return a contexts array"
    );
    assert.ok(
      Array.isArray(contextBuilderProbe.warnings),
      "buildFileContexts should return a warnings array"
    );

    const batchContextByFile: Record<string, FileContext> = {
      "src/architect/BigService.ts": {
        fullContent:
          "### collision marker\n" +
          "const payload = 'x';\n".repeat(80),
        gitDiff:
          "@@ -1,3 +1,3 @@\n" +
          "+const changed = true;\n".repeat(20),
      },
      "src/tests/feature.spec.ts": {
        fullContent: "describe('feature', () => {})\n".repeat(20),
        gitDiff: "@@ -0,0 +1,3 @@\n+it('works', () => {})\n",
      },
      "docs/guide.md": {
        fullContent: "# Guide\n".repeat(40),
        gitDiff: "@@ -1,2 +1,3 @@\n+updated docs\n",
      },
    };

    const routedForBatching = new Map<string, readonly string[]>([
      ["architect", ["src/architect/BigService.ts", "src/tests/feature.spec.ts"]],
      ["z-custom", ["docs/guide.md"]],
    ]);

    const batched = createBatches(routedForBatching, batchContextByFile, 700);
    assert.ok(batched.batches.length > 0, "createBatches should produce at least one batch");
    for (const batch of batched.batches) {
      assert.equal(batch.estimatedChars <= 700, true, "Batch estimated chars must respect maxCharLimit");
    }
    const architectBatches = batched.batchesByAgent.get("architect") ?? [];
    const architectChunks = architectBatches.flatMap((batch) => batch.chunks);
    const bigServiceChunks = architectChunks.filter(
      (chunk) => chunk.filePath === "src/architect/BigService.ts"
    );
    assert.equal(
      bigServiceChunks.some((chunk) => chunk.totalChunks > 1),
      true,
      "Oversized entries should be chunked into multiple deterministic chunks"
    );

    const batchedSecondRun = createBatches(routedForBatching, batchContextByFile, 700);
    assert.deepEqual(
      batched.batches.map((batch) => batch.id),
      batchedSecondRun.batches.map((batch) => batch.id),
      "Batch IDs should be deterministic for identical input"
    );

    const prompt = buildAgentBatchPrompt({
      agentInstruction: "Review architecture and return strict findings.",
      batch: batched.batches[0],
    });
    assert.equal(prompt.includes("### AGENT_INSTRUCTION"), true);
    assert.equal(prompt.includes("### FILE"), true);
    assert.equal(prompt.includes("### FULL_CONTENT"), true);
    assert.equal(prompt.includes("### GIT_DIFF"), true);
    assert.equal(prompt.includes("### OUTPUT_REQUIREMENTS"), true);
    assert.equal(
      prompt.includes("##\\# collision marker"),
      true,
      "Delimiter collisions should be sanitized deterministically"
    );

    const changed = await getChangedFiles("HEAD");
    assert.ok(Array.isArray(changed), "getChangedFiles should return an array");

    const smokeFile = existsSync("README.md") ? "README.md" : "LICENSE";
    const diff = await getFileDiff("HEAD", smokeFile);
    assert.equal(typeof diff, "string", "getFileDiff should return a string");

    let caught = false;
    try {
      await runCopilotPrompt("   ");
    } catch (error) {
      caught = true;
      assert.ok(error instanceof CopilotServiceError, "Expected CopilotServiceError");
      assert.equal(error.code, "INVALID_PROMPT");
    }

    assert.ok(caught, "runCopilotPrompt should reject empty prompt");
  } finally {
    rmSync(SMOKE_FIXTURES_ROOT, { recursive: true, force: true });
  }
}

runSmokeChecks()
  .then(() => {
    console.log("Smoke checks passed.");
  })
  .catch((error: unknown) => {
    console.error("Smoke checks failed.", error);
    process.exitCode = 1;
  });

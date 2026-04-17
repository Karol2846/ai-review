import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { CopilotServiceError, runCopilotPrompt } from "./copilot";
import { loadRoutingConfig } from "./config";
import { defaultRoutingConfig } from "./defaultConfig";
import { getChangedFiles, getFileDiff } from "./git";
import { routeFilesToAgents } from "./router";
import { AGENT_NAMES } from "./routingTypes";

async function runSmokeChecks(): Promise<void> {
  const routingLoadResult = loadRoutingConfig(process.cwd());
  assert.ok(routingLoadResult.config, "loadRoutingConfig should return a config object");
  assert.ok(Array.isArray(routingLoadResult.warnings), "loadRoutingConfig should return warnings");

  const routed = routeFilesToAgents(
    ["src/git.ts", "src/domain/OrderAggregate.ts", "README.md", "docs/notes.txt"],
    routingLoadResult.config
  );
  assert.ok(routed instanceof Map, "routeFilesToAgents should return a map");
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
}

runSmokeChecks()
  .then(() => {
    console.log("Smoke checks passed.");
  })
  .catch((error: unknown) => {
    console.error("Smoke checks failed.", error);
    process.exitCode = 1;
  });

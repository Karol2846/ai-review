import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { CopilotServiceError, runCopilotPrompt } from "./copilot";
import { getChangedFiles, getFileDiff } from "./git";

async function runSmokeChecks(): Promise<void> {
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

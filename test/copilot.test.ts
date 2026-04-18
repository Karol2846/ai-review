import { beforeEach, describe, expect, it, vi } from "vitest";

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: execaMock,
}));

import { CopilotServiceError, runCopilotPrompt } from "../src/copilot";

beforeEach(() => {
  execaMock.mockReset();
});

describe("runCopilotPrompt", () => {
  it("throws INVALID_PROMPT for empty prompts", async () => {
    await expect(runCopilotPrompt("   ")).rejects.toMatchObject({
      name: "CopilotServiceError",
      code: "INVALID_PROMPT",
      message: "Copilot prompt must not be empty.",
    });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("maps ENOENT command failures to COMMAND_NOT_FOUND", async () => {
    execaMock.mockRejectedValueOnce({
      code: "ENOENT",
      shortMessage: "spawn copilot ENOENT",
    });

    await expect(runCopilotPrompt("review this diff")).rejects.toMatchObject({
      name: "CopilotServiceError",
      code: "COMMAND_NOT_FOUND",
    });
  });

  it("maps auth-like stderr output to NOT_AUTHENTICATED", async () => {
    execaMock.mockRejectedValueOnce({
      stderr: "Authentication required. Please run login and try again.",
    });

    await expect(runCopilotPrompt("review this diff")).rejects.toMatchObject({
      name: "CopilotServiceError",
      code: "NOT_AUTHENTICATED",
    });
  });

  it("falls back to COMMAND_FAILED for other command failures", async () => {
    execaMock.mockRejectedValueOnce({
      stderr: "Unexpected copilot failure",
    });

    await expect(runCopilotPrompt("review this diff")).rejects.toMatchObject({
      name: "CopilotServiceError",
      code: "COMMAND_FAILED",
    });
  });

  it("uses CopilotServiceError for all mapped failures", async () => {
    execaMock.mockRejectedValueOnce({
      stderr: "Authentication required.",
    });

    await expect(runCopilotPrompt("prompt")).rejects.toBeInstanceOf(CopilotServiceError);
  });
});

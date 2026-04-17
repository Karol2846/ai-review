import { execa } from "execa";

type CommandFailure = {
  code?: string;
  shortMessage?: string;
  stderr?: string;
  stdout?: string;
  message?: string;
};

function isCommandFailure(value: unknown): value is CommandFailure {
  return typeof value === "object" && value !== null;
}

function failureText(error: unknown): string {
  if (!isCommandFailure(error)) {
    return "Unknown command failure.";
  }

  const detail = error.shortMessage ?? error.stderr ?? error.stdout ?? error.message;
  return detail && detail.trim().length > 0 ? detail.trim() : "Unknown command failure.";
}

function isNotAuthenticated(detail: string): boolean {
  const authPattern =
    /(not logged in|authentication|authenticate|please run\s+\/?login|copilot.*login)/iu;
  return authPattern.test(detail);
}

export type CopilotServiceErrorCode =
  | "INVALID_PROMPT"
  | "COMMAND_NOT_FOUND"
  | "NOT_AUTHENTICATED"
  | "COMMAND_FAILED";

export class CopilotServiceError extends Error {
  readonly code: CopilotServiceErrorCode;

  constructor(code: CopilotServiceErrorCode, message: string) {
    super(message);
    this.name = "CopilotServiceError";
    this.code = code;
  }
}

export async function runCopilotPrompt(prompt: string): Promise<string> {
  if (prompt.trim().length === 0) {
    throw new CopilotServiceError("INVALID_PROMPT", "Copilot prompt must not be empty.");
  }

  try {
    const { stdout } = await execa("copilot", ["-p", prompt, "-s"], { reject: true });
    return stdout;
  } catch (error) {
    const detail = failureText(error);

    if (isCommandFailure(error) && error.code === "ENOENT") {
      throw new CopilotServiceError(
        "COMMAND_NOT_FOUND",
        `copilot CLI executable not found in PATH: ${detail}`
      );
    }

    if (isNotAuthenticated(detail)) {
      throw new CopilotServiceError(
        "NOT_AUTHENTICATED",
        `copilot CLI is not authenticated: ${detail}`
      );
    }

    throw new CopilotServiceError("COMMAND_FAILED", `copilot command failed: ${detail}`);
  }
}

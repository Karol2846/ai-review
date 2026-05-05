export interface LlmProvider {
  sendPrompt(prompt: string): Promise<string>;
}

export type LlmProviderErrorCode =
  | "INVALID_PROMPT"
  | "COMMAND_NOT_FOUND"
  | "NOT_AUTHENTICATED"
  | "COMMAND_FAILED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "SERVICE_UNAVAILABLE";

export class LlmProviderError extends Error {
  readonly code: LlmProviderErrorCode;

  constructor(code: LlmProviderErrorCode, message: string) {
    super(message);
    this.name = "LlmProviderError";
    this.code = code;
  }
}

const TRANSIENT_LLM_PROVIDER_ERROR_CODES: ReadonlySet<LlmProviderErrorCode> = new Set([
  "COMMAND_FAILED",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "SERVICE_UNAVAILABLE",
]);

export function isTransientLlmProviderErrorCode(code: LlmProviderErrorCode): boolean {
  return TRANSIENT_LLM_PROVIDER_ERROR_CODES.has(code);
}

export function isTransientLlmProviderError(error: unknown): error is LlmProviderError {
  return error instanceof LlmProviderError && isTransientLlmProviderErrorCode(error.code);
}

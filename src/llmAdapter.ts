import { LlmProviderError } from "./llmProvider";
import type { LlmClient } from "./llmClient";
import { parseModelResponse } from "./responseParser";
import type { Finding } from "./findingSchema";

export async function generateFindings(client: LlmClient, prompt: string): Promise<Finding[]> {
  let text: string;
  try {
    text = await client.complete(prompt);
  } catch (error) {
    if (error instanceof LlmProviderError) throw error;
    throw new LlmProviderError("COMMAND_FAILED", error instanceof Error ? error.message : String(error));
  }
  const { findings } = parseModelResponse(text);
  return findings;
}

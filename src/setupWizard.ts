import { createInterface, type Interface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  INSTALL_PROVIDER_CONFIG_DIR,
  INSTALL_PROVIDER_CONFIG_FILE_NAME,
  PROVIDER_KINDS,
  type ProviderKind,
} from "./installProviderConfig";

export interface SetupWizardResult {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly baseURL?: string;
}

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function promptProvider(rl: Interface): Promise<ProviderKind> {
  process.stdout.write("\nSelect provider:\n");
  process.stdout.write("  1) openai-compatible  (OpenAI, Groq, OpenRouter, any OpenAI-compatible endpoint)\n");
  process.stdout.write("  2) anthropic\n");
  process.stdout.write("  3) google\n");

  for (;;) {
    const answer = (await ask(rl, "[1/2/3]: ")).trim();
    switch (answer) {
      case "1": case "openai-compatible": return "openai-compatible";
      case "2": case "anthropic":         return "anthropic";
      case "3": case "google":            return "google";
      default:
        process.stderr.write(`Invalid selection "${answer}". Enter 1, 2, or 3.\n`);
    }
  }
}

async function promptNonEmpty(rl: Interface, question: string, defaultValue?: string): Promise<string> {
  for (;;) {
    const value = (await ask(rl, question)).trim();
    if (value.length > 0) return value;
    if (defaultValue !== undefined) return defaultValue;
    process.stderr.write("Value cannot be empty.\n");
  }
}

async function promptBaseURL(rl: Interface): Promise<string | undefined> {
  const yesNo = (await ask(rl, "Use a custom baseURL (e.g. for Groq, OpenRouter)? [y/N]: ")).trim().toLowerCase();
  if (yesNo !== "y" && yesNo !== "yes") return undefined;

  for (;;) {
    const url = (await ask(rl, "baseURL: ")).trim();
    if (url.length === 0) {
      process.stderr.write("baseURL cannot be empty.\n");
      continue;
    }
    try {
      new URL(url);
      return url;
    } catch {
      process.stderr.write(`"${url}" is not a valid URL. Include scheme (e.g. https://...).\n`);
    }
  }
}

function modelHint(provider: ProviderKind): string {
  switch (provider) {
    case "openai-compatible":
      return "Model name (e.g. gpt-4o-mini; for Groq: llama-3.3-70b-versatile): ";
    case "anthropic":
      return "Model name (e.g. claude-sonnet-4-6): ";
    case "google":
      return "Model name (e.g. gemini-2.0-flash): ";
  }
}

async function collectConfig(rl: Interface): Promise<SetupWizardResult> {
  const provider = await promptProvider(rl);
  const model = await promptNonEmpty(rl, modelHint(provider));
  const apiKeyEnv = await promptNonEmpty(
    rl,
    "Environment variable name for API key [AI_REVIEW_API_KEY]: ",
    "AI_REVIEW_API_KEY"
  );
  const baseURL = provider === "openai-compatible" ? await promptBaseURL(rl) : undefined;
  return { provider, model, apiKeyEnv, ...(baseURL !== undefined ? { baseURL } : {}) };
}

export async function runSetupWizard(): Promise<SetupWizardResult> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await collectConfig(rl);
  } finally {
    rl.close();
  }
}

export async function saveWizardConfig(config: SetupWizardResult): Promise<string> {
  await mkdir(INSTALL_PROVIDER_CONFIG_DIR, { recursive: true });
  const configPath = join(INSTALL_PROVIDER_CONFIG_DIR, INSTALL_PROVIDER_CONFIG_FILE_NAME);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

export { PROVIDER_KINDS };

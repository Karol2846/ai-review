import { createInterface, type Interface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  INSTALL_PROVIDER_CONFIG_DIR,
  INSTALL_PROVIDER_CONFIG_FILE_NAME,
  PROVIDER_KINDS,
  type ProviderKind,
} from "./installProviderConfig";

//FIXME: Is Circle K supports github models? If not - this can be thrown away :(
const GITHUB_MODELS_BASE_URL = "https://models.inference.ai.azure.com";

type WizardSelection = ProviderKind | "github-models";

export interface SetupWizardResult {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly baseURL?: string;
}

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function promptProvider(rl: Interface): Promise<WizardSelection> {
  process.stdout.write("\nSelect provider:\n");
  process.stdout.write("  1) openai-compatible  (OpenAI, Groq, OpenRouter, any OpenAI-compatible endpoint)\n");
  process.stdout.write("  2) anthropic\n");
  process.stdout.write("  3) google\n");
  process.stdout.write("  4) github-models      (GitHub Models API — use your GitHub PAT)\n");

  for (;;) {
    const answer = (await ask(rl, "[1/2/3/4]: ")).trim();
    switch (answer) {
      case "1": case "openai-compatible": return "openai-compatible";
      case "2": case "anthropic":         return "anthropic";
      case "3": case "google":            return "google";
      case "4": case "github-models":     return "github-models";
      default:
        process.stderr.write(`Invalid selection "${answer}". Enter 1, 2, 3, or 4.\n`);
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
  const selection = await promptProvider(rl);

  if (selection === "github-models") {
    const model = await promptNonEmpty(
      rl,
      "Model name (e.g. gpt-4o-mini, claude-3.5-sonnet-20241022): "
    );
    const apiKeyEnv = await promptNonEmpty(
      rl,
      "Environment variable name for your GitHub PAT [GITHUB_TOKEN]: ",
      "GITHUB_TOKEN"
    );
    process.stdout.write(
      "\nNote: your PAT needs 'models:read' scope (or 'public_repo' for org accounts).\n" +
      "Generate one at: github.com/settings/tokens\n"
    );
    return { provider: "openai-compatible", model, apiKeyEnv, baseURL: GITHUB_MODELS_BASE_URL };
  }

  const model = await promptNonEmpty(rl, modelHint(selection));
  const apiKeyEnv = await promptNonEmpty(
    rl,
    "Environment variable name for API key [AI_REVIEW_API_KEY]: ",
    "AI_REVIEW_API_KEY"
  );
  const baseURL = selection === "openai-compatible" ? await promptBaseURL(rl) : undefined;
  return { provider: selection, model, apiKeyEnv, ...(baseURL !== undefined ? { baseURL } : {}) };
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

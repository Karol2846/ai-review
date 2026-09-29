import { createInterface, type Interface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import {
  INSTALL_PROVIDER_CONFIG_DIR,
  INSTALL_PROVIDER_CONFIG_FILE_NAME,
  PROVIDER_KINDS,
  type InstallProviderConfig,
  type ProviderKind,
} from "./installProviderConfig";
import { PROVIDER_INFO } from "./llmClient";

export type SetupWizardResult = InstallProviderConfig;

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/** Returns true when the provider's CLI can be launched from PATH. */
export async function isProviderInstalled(provider: ProviderKind): Promise<boolean> {
  const result = await execa(PROVIDER_INFO[provider].command, ["--version"], {
    reject: false,
    timeout: 15_000,
  });
  return result.exitCode === 0;
}

async function promptProvider(
  rl: Interface,
  installed: ReadonlySet<ProviderKind>
): Promise<ProviderKind> {
  process.stdout.write("\nWhich coding agent should run the reviews? ai-review uses its existing login.\n");
  PROVIDER_KINDS.forEach((provider, index) => {
    const status = installed.has(provider) ? "installed" : "not found in PATH";
    process.stdout.write(`  ${index + 1}) ${PROVIDER_INFO[provider].label}  (${status})\n`);
  });

  const defaultProvider = PROVIDER_KINDS.find((provider) => installed.has(provider));
  const defaultIndex = defaultProvider ? PROVIDER_KINDS.indexOf(defaultProvider) + 1 : undefined;
  const choices = PROVIDER_KINDS.map((_, index) => index + 1).join("/");

  for (;;) {
    const suffix = defaultIndex !== undefined ? ` [${defaultIndex}]` : "";
    const answer = (await ask(rl, `[${choices}]${suffix}: `)).trim();
    if (answer.length === 0 && defaultProvider !== undefined) return defaultProvider;

    const byIndex = PROVIDER_KINDS[Number(answer) - 1];
    const provider = byIndex ?? PROVIDER_KINDS.find((kind) => kind === answer);
    if (provider !== undefined) return provider;

    process.stderr.write(`Invalid selection "${answer}". Enter one of ${choices}.\n`);
  }
}

export async function runSetupWizard(): Promise<SetupWizardResult> {
  const detected = await Promise.all(
    PROVIDER_KINDS.map(async (provider) => ((await isProviderInstalled(provider)) ? provider : undefined))
  );
  const installed = new Set(detected.filter((provider): provider is ProviderKind => provider !== undefined));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const provider = await promptProvider(rl, installed);
    if (!installed.has(provider)) {
      const info = PROVIDER_INFO[provider];
      process.stdout.write(
        `\n${info.label} was not found. Install it with \`${info.installHint}\`, then ${info.loginHint}.\n`
      );
    }
    return { provider };
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

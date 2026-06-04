import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { REPO_CONFIG_FILE_NAME } from "./repoConfig";

export interface RunInitParams {
  readonly cwd: string;
  readonly force: boolean;
  /** `null` when `init` is run outside a git repository. */
  readonly gitRepoRoot: string | null;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

export const INIT_TEMPLATE = {
  model: "claude-haiku-4-5",
  exclude: ["**/*.generated.ts", "vendor/**"],
  agents: {
    tester: { globs: ["**/*.spec.ts"] },
    security: {
      globs: ["**/*.java"],
      instructionsFile: "agents/security.agent.md",
    },
  },
} as const;

export function renderInitTemplate(): string {
  return JSON.stringify(INIT_TEMPLATE, null, 2) + "\n";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(params: RunInitParams): Promise<number> {
  const { cwd, force, gitRepoRoot, writeStdout, writeStderr } = params;
  const targetPath = join(cwd, REPO_CONFIG_FILE_NAME);

  if (!force && (await fileExists(targetPath))) {
    writeStderr(
      `${REPO_CONFIG_FILE_NAME} already exists. Use --force to overwrite.`
    );
    return 1;
  }

  await writeFile(targetPath, renderInitTemplate(), "utf8");
  writeStdout(`Created ${targetPath}`);

  const needsNote =
    gitRepoRoot === null || resolve(gitRepoRoot) !== resolve(cwd);
  if (needsNote) {
    const hint =
      gitRepoRoot !== null ? `repo root (${resolve(gitRepoRoot)})` : "the repo root";
    writeStderr(
      `Note: ai-review reads ${REPO_CONFIG_FILE_NAME} only from the repo root. ` +
        `Move the file to ${hint} for it to take effect.`
    );
  }

  return 0;
}

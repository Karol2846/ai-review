import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

interface PackageJsonLike {
  readonly main?: string;
  readonly types?: string;
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly scripts?: Record<string, string>;
}

interface TsConfigLike {
  readonly compilerOptions?: {
    readonly outDir?: string;
    readonly declaration?: boolean;
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

describe("npm packaging", () => {
  const repoRoot = process.cwd();
  const packageJson = readJsonFile<PackageJsonLike>(join(repoRoot, "package.json"));
  const tsconfig = readJsonFile<TsConfigLike>(join(repoRoot, "tsconfig.json"));

  it("uses a tsc-only build pipeline", () => {
    const scripts = packageJson.scripts ?? {};
    expect(scripts.build).toContain("tsc -p tsconfig.json");
    expect(Object.values(scripts).join(" ")).not.toMatch(/\besbuild\b/u);
  });

  it("publishes coherent cli and library entrypoints", () => {
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.bin?.["ai-review"]).toBe("./dist/cli.js");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "agents"]));

    const rootExport = packageJson.exports?.["."];
    expect(rootExport).toEqual(
      expect.objectContaining({
        default: "./dist/index.js",
        types: "./dist/index.d.ts",
      })
    );
    expect(packageJson.exports?.["./cli"]).toBe("./dist/cli.js");

    expect(tsconfig.compilerOptions?.outDir).toBe("dist");
    expect(tsconfig.compilerOptions?.declaration).toBe(true);
  });

  it("preserves shebang in the compiled cli entrypoint", () => {
    const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cliSource).toMatch(/^#!\/usr\/bin\/env node\r?\n/u);

    const transpiled = ts.transpileModule(cliSource, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });
    expect(transpiled.outputText).toMatch(/^#!\/usr\/bin\/env node\r?\n/u);
  });
});

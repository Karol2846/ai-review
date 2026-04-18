import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRoutingConfig } from "../src/config";
import { defaultRoutingConfig } from "../src/defaultConfig";
import { routeFilesToAgents } from "../src/router";
import { AGENT_NAMES, type RoutingRuntimeConfig } from "../src/routingTypes";

const FIXTURES_ROOT = join(process.cwd(), ".router-config-fixtures");

function recreateFixtureDir(name: string): string {
  const fixtureRoot = join(FIXTURES_ROOT, name);
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
  return fixtureRoot;
}

function writeJsonConfigFixture(name: string, config: unknown): string {
  const fixtureRoot = recreateFixtureDir(name);
  const configPath = join(fixtureRoot, ".ai-reviewrc.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return fixtureRoot;
}

function writeRawConfigFixture(name: string, content: string): string {
  const fixtureRoot = recreateFixtureDir(name);
  const configPath = join(fixtureRoot, ".ai-reviewrc.json");
  writeFileSync(configPath, content, "utf8");
  return fixtureRoot;
}

beforeAll(() => {
  rmSync(FIXTURES_ROOT, { recursive: true, force: true });
  mkdirSync(FIXTURES_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURES_ROOT, { recursive: true, force: true });
});

describe("routeFilesToAgents", () => {
  it("keeps stable default ordering, deduplicates files, and skips unmatched files", () => {
    const routed = routeFilesToAgents(
      ["src/router/index.ts", "src/router/index.ts", "README.md", "docs/notes.txt"],
      defaultRoutingConfig
    );

    expect([...routed.keys()]).toEqual([...AGENT_NAMES]);
    expect((routed.get("clean-coder") ?? []).filter((file) => file === "src/router/index.ts")).toHaveLength(1);
    expect((routed.get("architect") ?? []).filter((file) => file === "src/router/index.ts")).toHaveLength(1);

    for (const assignedFiles of routed.values()) {
      expect(assignedFiles).not.toContain("README.md");
      expect(assignedFiles).not.toContain("docs/notes.txt");
    }
  });

  it("adds dynamic agents deterministically after default agents", () => {
    const dynamicConfig: RoutingRuntimeConfig = {
      ...defaultRoutingConfig,
      agentGlobs: {
        ...defaultRoutingConfig.agentGlobs,
        "z-custom": ["**/*.md"],
        "a-custom": ["**/*.txt"],
        "m-custom": ["**/*.json"],
      },
    };

    const routed = routeFilesToAgents(
      ["README.md", "notes/todo.txt", "config/data.json", "README.md"],
      dynamicConfig
    );

    expect([...routed.keys()]).toEqual([...AGENT_NAMES, "a-custom", "m-custom", "z-custom"]);
    expect(routed.get("a-custom")).toEqual(["notes/todo.txt"]);
    expect(routed.get("m-custom")).toEqual(["config/data.json"]);
    expect(routed.get("z-custom")).toEqual(["README.md"]);
  });

  it("normalizes Windows-style paths before glob matching", () => {
    const routed = routeFilesToAgents(
      ["src\\config\\settings.ts", "src\\router\\index.ts"],
      defaultRoutingConfig
    );

    expect(routed.get("architect")).toEqual(["src\\config\\settings.ts", "src\\router\\index.ts"]);
    expect(routed.get("clean-coder")).toEqual(["src\\config\\settings.ts", "src\\router\\index.ts"]);
  });
});

describe("loadRoutingConfig", () => {
  it("returns defaults with no warnings when config file is missing", () => {
    const fixtureRoot = recreateFixtureDir("missing-config");

    const result = loadRoutingConfig(fixtureRoot);

    expect(result.config).toEqual(defaultRoutingConfig);
    expect(result.config).not.toBe(defaultRoutingConfig);
    expect(result.warnings).toEqual([]);
  });

  it("warns and falls back to defaults when JSON is invalid", () => {
    const fixtureRoot = writeRawConfigFixture("invalid-json", "{ invalid");

    const result = loadRoutingConfig(fixtureRoot);

    expect(result.config).toEqual(defaultRoutingConfig);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Invalid JSON in .ai-reviewrc.json");
  });

  it("warns on unsupported root keys", () => {
    const fixtureRoot = writeJsonConfigFixture("unsupported-root", {
      unsupportedRootFlag: true,
    });

    const result = loadRoutingConfig(fixtureRoot);

    expect(result.warnings.some((warning) => warning.includes('unsupported root key "unsupportedRootFlag"'))).toBe(
      true
    );
    expect(result.config).toEqual(defaultRoutingConfig);
  });

  it("warns when an agent fragment has an invalid type", () => {
    const fixtureRoot = writeJsonConfigFixture("invalid-agent-fragment", {
      agentGlobs: {
        architect: 7,
      },
    });

    const result = loadRoutingConfig(fixtureRoot);

    expect(
      result.warnings.some((warning) =>
        warning.includes('"agentGlobs.architect" must be an array of non-empty glob strings.')
      )
    ).toBe(true);
    expect(result.config.agentGlobs.architect).toEqual(defaultRoutingConfig.agentGlobs.architect);
  });

  it("merges only valid override fragments and preserves defaults for invalid fragments", () => {
    const fixtureRoot = writeJsonConfigFixture("partial-valid-override", {
      agentGlobs: {
        tester: ["**/*.spec.ts", 42],
        architect: 7,
        performance: ["**/*.sql", ""],
      },
    });

    const result = loadRoutingConfig(fixtureRoot);

    expect(result.config.agentGlobs.tester).toEqual(["**/*.spec.ts"]);
    expect(result.config.agentGlobs.architect).toEqual(defaultRoutingConfig.agentGlobs.architect);
    expect(result.config.agentGlobs.performance).toEqual(["**/*.sql"]);
    expect(result.config.agentGlobs["clean-coder"]).toEqual(defaultRoutingConfig.agentGlobs["clean-coder"]);
    expect(
      result.warnings.some((warning) => warning.includes('"agentGlobs.tester[1]" must be a non-empty string.'))
    ).toBe(true);
    expect(
      result.warnings.some((warning) =>
        warning.includes('"agentGlobs.architect" must be an array of non-empty glob strings.')
      )
    ).toBe(true);
    expect(
      result.warnings.some((warning) =>
        warning.includes('"agentGlobs.performance[1]" must be a non-empty string.')
      )
    ).toBe(true);
  });

  it("accepts and merges dynamic custom agent keys", () => {
    const fixtureRoot = writeJsonConfigFixture("dynamic-agent", {
      agentGlobs: {
        "custom-docs": ["docs/**/*.md"],
      },
    });

    const result = loadRoutingConfig(fixtureRoot);

    expect(result.warnings).toEqual([]);
    expect(result.config.agentGlobs["custom-docs"]).toEqual(["docs/**/*.md"]);
    expect(result.config.agentGlobs.architect).toEqual(defaultRoutingConfig.agentGlobs.architect);
  });
});


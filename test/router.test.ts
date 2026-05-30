import { describe, expect, it } from "vitest";

import { routeFilesToAgents } from "../src/router";
import type { RoutingRuntimeConfig } from "../src/routingTypes";

function createConfig(agentGlobs: Record<string, readonly string[]>): RoutingRuntimeConfig {
  return {
    agentGlobs,
    unmatchedFilesPolicy: "skip",
    userConfigMergeMode: "override",
    invalidUserConfigPolicy: "fallback_with_warning",
  };
}

describe("routeFilesToAgents", () => {
  it("routes files to matching agents based on glob patterns", () => {
    const config = createConfig({
      tester: ["**/*.spec.ts", "**/*.test.ts"],
      architect: ["src/**/*.ts"],
    });

    const result = routeFilesToAgents(
      ["src/service.ts", "src/service.spec.ts", "README.md"],
      config
    );

    expect(result.get("tester")).toEqual(["src/service.spec.ts"]);
    expect(result.get("architect")).toEqual(["src/service.spec.ts", "src/service.ts"]);
  });

  it("skips unmatched files when unmatchedFilesPolicy is 'skip'", () => {
    const config = createConfig({
      tester: ["**/*.spec.ts"],
    });

    const result = routeFilesToAgents(["README.md", "package.json"], config);

    expect(result.get("tester")).toEqual([]);
  });

  it("returns an empty list for each agent when no files are provided", () => {
    const config = createConfig({
      tester: ["**/*.spec.ts"],
      architect: ["src/**/*.ts"],
    });

    const result = routeFilesToAgents([], config);

    expect(result.get("tester")).toEqual([]);
    expect(result.get("architect")).toEqual([]);
  });

  it("returns a Map with all configured agents as keys, even when they match nothing", () => {
    const config = createConfig({
      tester: ["**/*.spec.ts"],
      performance: ["**/*.sql"],
    });

    const result = routeFilesToAgents(["src/app.ts"], config);

    expect([...result.keys()].sort()).toEqual(["performance", "tester"]);
    expect(result.get("tester")).toEqual([]);
    expect(result.get("performance")).toEqual([]);
  });

  it("deduplicates files that appear more than once in the input list", () => {
    const config = createConfig({
      tester: ["**/*.ts"],
    });

    const result = routeFilesToAgents(
      ["src/a.ts", "src/a.ts", "src/b.ts"],
      config
    );

    expect(result.get("tester")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns files in deterministic sorted order within each agent bucket", () => {
    const config = createConfig({
      tester: ["**/*.ts"],
    });

    const result = routeFilesToAgents(
      ["src/z.ts", "src/a.ts", "src/m.ts"],
      config
    );

    expect(result.get("tester")).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("a single file can be routed to multiple agents that all match it", () => {
    const config = createConfig({
      tester: ["src/**/*.ts"],
      architect: ["src/**/*.ts"],
      "clean-coder": ["**/*.ts"],
    });

    const result = routeFilesToAgents(["src/service.ts"], config);

    expect(result.get("tester")).toEqual(["src/service.ts"]);
    expect(result.get("architect")).toEqual(["src/service.ts"]);
    expect(result.get("clean-coder")).toEqual(["src/service.ts"]);
  });

  it("preserves AGENT_NAMES ordering for known agents, then sorts unknown agents alphabetically", () => {
    const config = createConfig({
      performance: ["**/*.sql"],
      tester: ["**/*.spec.ts"],
      "custom-z": ["**/*.go"],
      "clean-coder": ["**/*.ts"],
    });

    const result = routeFilesToAgents([], config);

    // AGENT_NAMES order: clean-coder, tester, architect, ddd-reviewer, performance
    // Among those present: clean-coder first, then tester, then performance
    // Unknown agents sorted alphabetically: custom-z
    expect([...result.keys()]).toEqual(["clean-coder", "tester", "performance", "custom-z"]);
  });

  it("normalises Windows-style backslash paths when matching globs", () => {
    const config = createConfig({
      architect: ["src/**/*.ts"],
    });

    const result = routeFilesToAgents(["src\\service\\MyService.ts"], config);

    expect(result.get("architect")).toEqual(["src\\service\\MyService.ts"]);
  });
});

import { describe, expect, it } from "vitest";

import { defaultRoutingConfig } from "../src/defaultConfig";
import {
  RepoConfigError,
  mergeRoutingConfig,
  parseRepoConfig,
} from "../src/repoConfig";

describe("parseRepoConfig", () => {
  it("returns null when raw is null (file absent)", () => {
    expect(parseRepoConfig(null)).toBeNull();
  });

  it("returns null when file has no routing section", () => {
    expect(parseRepoConfig("{}")).toBeNull();
  });

  it("returns empty override when routing section has no agentGlobs", () => {
    const result = parseRepoConfig(JSON.stringify({ routing: {} }));
    expect(result).toEqual({});
  });

  it("parses valid agentGlobs for a known agent", () => {
    const raw = JSON.stringify({
      routing: {
        agentGlobs: {
          "ddd-reviewer": ["**/internal/core/**/*.java"],
        },
      },
    });
    const result = parseRepoConfig(raw);
    expect(result).toEqual({
      agentGlobs: {
        "ddd-reviewer": ["**/internal/core/**/*.java"],
      },
    });
  });

  it("parses valid agentGlobs for multiple agents", () => {
    const raw = JSON.stringify({
      routing: {
        agentGlobs: {
          "ddd-reviewer": ["**/internal/core/**/*.java"],
          performance: ["**/infra/cache/**/*.java"],
        },
      },
    });
    const result = parseRepoConfig(raw);
    expect(result?.agentGlobs?.["ddd-reviewer"]).toEqual(["**/internal/core/**/*.java"]);
    expect(result?.agentGlobs?.["performance"]).toEqual(["**/infra/cache/**/*.java"]);
  });

  it("throws RepoConfigError on invalid JSON", () => {
    expect(() => parseRepoConfig("{bad json}")).toThrow(RepoConfigError);
  });

  it("throws RepoConfigError with message containing 'invalid JSON'", () => {
    expect(() => parseRepoConfig("{bad json}")).toThrow(/invalid JSON/i);
  });

  it("throws RepoConfigError on unknown root key", () => {
    const raw = JSON.stringify({ model: "gpt-4o", routing: {} });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/unknown key/i);
    expect(() => parseRepoConfig(raw)).toThrow(/model/);
  });

  it("throws RepoConfigError with list of allowed root keys on unknown root key", () => {
    const raw = JSON.stringify({ unknownThing: 1 });
    expect(() => parseRepoConfig(raw)).toThrow(/routing/);
  });

  it("throws RepoConfigError on unknown routing key", () => {
    const raw = JSON.stringify({ routing: { unknownOption: true } });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/unknownOption/);
  });

  it("throws RepoConfigError on unknown agent name", () => {
    const raw = JSON.stringify({
      routing: { agentGlobs: { tester2: ["**/*.ts"] } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/tester2/);
  });

  it("error for unknown agent includes list of allowed agent names", () => {
    const raw = JSON.stringify({
      routing: { agentGlobs: { tester2: ["**/*.ts"] } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(/tester/);
    expect(() => parseRepoConfig(raw)).toThrow(/clean-coder/);
  });

  it("throws RepoConfigError when globs value is a string instead of array", () => {
    const raw = JSON.stringify({
      routing: { agentGlobs: { tester: "**/*.ts" } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/array/i);
  });

  it("throws RepoConfigError on empty globs array", () => {
    const raw = JSON.stringify({
      routing: { agentGlobs: { tester: [] } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/empty/i);
  });

  it("throws RepoConfigError on empty string glob", () => {
    const raw = JSON.stringify({
      routing: { agentGlobs: { tester: [""] } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/non-empty string/i);
  });

  it("throws RepoConfigError on whitespace-only glob", () => {
    const raw = JSON.stringify({
      routing: { agentGlobs: { tester: ["  "] } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
  });

  it("throws RepoConfigError when root is not an object (array)", () => {
    expect(() => parseRepoConfig("[]")).toThrow(RepoConfigError);
  });
});

describe("mergeRoutingConfig", () => {
  it("returns base unchanged when override is null", () => {
    const result = mergeRoutingConfig(defaultRoutingConfig, null);
    expect(result).toBe(defaultRoutingConfig);
  });

  it("returns base unchanged when override has no agentGlobs", () => {
    const result = mergeRoutingConfig(defaultRoutingConfig, {});
    expect(result).toBe(defaultRoutingConfig);
  });

  it("extends globs for the overridden agent", () => {
    const override = {
      agentGlobs: {
        "ddd-reviewer": ["**/internal/core/**/*.java"],
      },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    const dddGlobs = result.agentGlobs["ddd-reviewer"];
    // Contains all original default globs
    for (const g of defaultRoutingConfig.agentGlobs["ddd-reviewer"]) {
      expect(dddGlobs).toContain(g);
    }
    // Also contains the new glob
    expect(dddGlobs).toContain("**/internal/core/**/*.java");
  });

  it("puts default globs before override globs", () => {
    const override = {
      agentGlobs: {
        "ddd-reviewer": ["**/internal/core/**/*.java"],
      },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    const dddGlobs = result.agentGlobs["ddd-reviewer"];
    const defaultLen = defaultRoutingConfig.agentGlobs["ddd-reviewer"].length;
    expect(dddGlobs.slice(0, defaultLen)).toEqual(
      defaultRoutingConfig.agentGlobs["ddd-reviewer"]
    );
    expect(dddGlobs[dddGlobs.length - 1]).toBe("**/internal/core/**/*.java");
  });

  it("deduplicates: does not add glob already present in defaults", () => {
    const existingGlob = defaultRoutingConfig.agentGlobs["ddd-reviewer"][0];
    const override = { agentGlobs: { "ddd-reviewer": [existingGlob] } };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    const dddGlobs = result.agentGlobs["ddd-reviewer"];
    const count = dddGlobs.filter((g) => g === existingGlob).length;
    expect(count).toBe(1);
  });

  it("leaves other agents unchanged when only one agent is overridden", () => {
    const override = {
      agentGlobs: { "ddd-reviewer": ["**/extra/**/*.java"] },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    expect(result.agentGlobs["tester"]).toEqual(defaultRoutingConfig.agentGlobs["tester"]);
    expect(result.agentGlobs["architect"]).toEqual(defaultRoutingConfig.agentGlobs["architect"]);
    expect(result.agentGlobs["performance"]).toEqual(defaultRoutingConfig.agentGlobs["performance"]);
    expect(result.agentGlobs["clean-coder"]).toEqual(defaultRoutingConfig.agentGlobs["clean-coder"]);
  });

  it("can extend multiple agents at once", () => {
    const override = {
      agentGlobs: {
        "ddd-reviewer": ["**/internal/core/**/*.java"],
        performance: ["**/infra/cache/**/*.java"],
      },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    expect(result.agentGlobs["ddd-reviewer"]).toContain("**/internal/core/**/*.java");
    expect(result.agentGlobs["performance"]).toContain("**/infra/cache/**/*.java");
  });

  it("preserves unmatchedFilesPolicy from base", () => {
    const override = { agentGlobs: { tester: ["**/*.spec.ts"] } };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    expect(result.unmatchedFilesPolicy).toBe(defaultRoutingConfig.unmatchedFilesPolicy);
  });
});

import { describe, expect, it } from "vitest";

import { defaultRoutingConfig } from "../src/defaultConfig";
import {
  RepoConfigError,
  agentsToRoutingOverride,
  mergeRoutingConfig,
  parseRepoConfig,
} from "../src/repoConfig";

describe("parseRepoConfig", () => {
  it("returns null when raw is null (file absent)", () => {
    expect(parseRepoConfig(null)).toBeNull();
  });

  it("returns null sections when file is an empty object", () => {
    expect(parseRepoConfig("{}")).toEqual({ model: null, agents: null, exclude: null, excludeAgents: null });
  });

  it("throws RepoConfigError on invalid JSON", () => {
    expect(() => parseRepoConfig("{bad json}")).toThrow(RepoConfigError);
    expect(() => parseRepoConfig("{bad json}")).toThrow(/invalid JSON/i);
  });

  it("throws RepoConfigError on unknown root key", () => {
    const raw = JSON.stringify({ severity: "high" });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/unknown key/i);
    expect(() => parseRepoConfig(raw)).toThrow(/severity/);
  });

  it("error for unknown root key lists allowed keys", () => {
    const raw = JSON.stringify({ unknownThing: 1 });
    expect(() => parseRepoConfig(raw)).toThrow(/agents/);
    expect(() => parseRepoConfig(raw)).toThrow(/model/);
  });

  it("throws RepoConfigError when root is not an object (array)", () => {
    expect(() => parseRepoConfig("[]")).toThrow(RepoConfigError);
  });

  it("throws unknown-key error when legacy `routing` key is present", () => {
    const raw = JSON.stringify({ routing: { agentGlobs: { tester: ["**/*.ts"] } } });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/unknown key/i);
    expect(() => parseRepoConfig(raw)).toThrow(/"routing"/);
  });
});

describe("parseRepoConfig — model section", () => {
  it("returns null model when section is absent", () => {
    const result = parseRepoConfig(JSON.stringify({}));
    expect(result?.model).toBeNull();
  });

  it("parses a model name string", () => {
    const result = parseRepoConfig(JSON.stringify({ model: "claude-haiku-4-5" }));
    expect(result?.model).toBe("claude-haiku-4-5");
  });

  it("trims the model name", () => {
    const result = parseRepoConfig(JSON.stringify({ model: "  gpt-4o  " }));
    expect(result?.model).toBe("gpt-4o");
  });

  it("throws when model is an object (the removed v1 shape)", () => {
    const raw = JSON.stringify({ model: { provider: "anthropic", model: "claude-sonnet-4-6" } });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/must be a non-empty string/i);
  });

  it("error for the object shape hints at re-running the wizard", () => {
    const raw = JSON.stringify({ model: { model: "gpt-4o" } });
    expect(() => parseRepoConfig(raw)).toThrow(/wizard/i);
  });

  it("throws on an empty model string", () => {
    expect(() => parseRepoConfig(JSON.stringify({ model: "   " }))).toThrow(/non-empty string/i);
  });

  it("throws when model is a number", () => {
    expect(() => parseRepoConfig(JSON.stringify({ model: 42 }))).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(JSON.stringify({ model: 42 }))).toThrow(/non-empty string/i);
  });
});

describe("parseRepoConfig — agents section (built-in overrides)", () => {
  it("returns null agents when section is absent", () => {
    const result = parseRepoConfig(JSON.stringify({}));
    expect(result?.agents).toBeNull();
  });

  it("parses a built-in agent with globs only (extend mode)", () => {
    const raw = JSON.stringify({
      agents: { tester: { globs: ["**/*.spec.ts", "**/*.test.ts"] } },
    });
    const result = parseRepoConfig(raw);
    expect(result?.agents?.tester).toEqual({ globs: ["**/*.spec.ts", "**/*.test.ts"] });
  });

  it("parses a built-in agent with replace: true", () => {
    const raw = JSON.stringify({
      agents: { "clean-coder": { globs: ["legacy/**/*.ts"], replace: true } },
    });
    const result = parseRepoConfig(raw);
    expect(result?.agents?.["clean-coder"]).toEqual({ globs: ["legacy/**/*.ts"], replace: true });
  });

  it("omits replace when it is false (normalized form)", () => {
    const raw = JSON.stringify({
      agents: { tester: { globs: ["**/*.spec.ts"], replace: false } },
    });
    const result = parseRepoConfig(raw);
    // replace: false is the default — parser does not set the field
    expect(result?.agents?.tester).toEqual({ globs: ["**/*.spec.ts"] });
  });

  it("throws when instructionsFile is set on a built-in agent", () => {
    const raw = JSON.stringify({
      agents: { tester: { globs: ["**/*.ts"], instructionsFile: "agents/tester.agent.md" } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/instructionsFile.*not allowed.*built-in/i);
  });

  it("throws on unknown key in a built-in agent definition", () => {
    const raw = JSON.stringify({
      agents: { tester: { globs: ["**/*.ts"], extra: true } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/extra/);
  });

  it("throws when replace is not a boolean", () => {
    const raw = JSON.stringify({
      agents: { tester: { globs: ["**/*.ts"], replace: "yes" } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/replace.*boolean/i);
  });

  it("throws on empty globs for a built-in agent", () => {
    const raw = JSON.stringify({ agents: { tester: { globs: [] } } });
    expect(() => parseRepoConfig(raw)).toThrow(/must not be empty/i);
  });

  it("throws on missing globs for a built-in agent", () => {
    const raw = JSON.stringify({ agents: { tester: {} } });
    expect(() => parseRepoConfig(raw)).toThrow(/globs/);
  });

  it("parses all five built-in agent names", () => {
    const agents = Object.fromEntries(
      ["clean-coder", "tester", "architect", "ddd-reviewer", "performance"].map((name) => [
        name,
        { globs: ["**/*.ts"] },
      ])
    );
    const result = parseRepoConfig(JSON.stringify({ agents }));
    expect(Object.keys(result?.agents ?? {})).toHaveLength(5);
  });
});

describe("parseRepoConfig — agents section (custom agents)", () => {
  it("parses a valid custom agent", () => {
    const raw = JSON.stringify({
      agents: {
        security: {
          globs: ["**/*.java", "**/*.ts"],
          instructionsFile: "agents/security.agent.md",
        },
      },
    });
    const result = parseRepoConfig(raw);
    expect(result?.agents?.security).toEqual({
      globs: ["**/*.java", "**/*.ts"],
      instructionsFile: "agents/security.agent.md",
    });
  });

  it("trims the instructionsFile path", () => {
    const raw = JSON.stringify({
      agents: { security: { globs: ["**/*.ts"], instructionsFile: "  agents/security.agent.md  " } },
    });
    const result = parseRepoConfig(raw);
    expect(result?.agents?.security?.instructionsFile).toBe("agents/security.agent.md");
  });

  it("throws when instructionsFile is missing for a custom agent", () => {
    const raw = JSON.stringify({ agents: { security: { globs: ["**/*.ts"] } } });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/instructionsFile/);
  });

  it("throws when instructionsFile is an empty string", () => {
    const raw = JSON.stringify({ agents: { security: { globs: ["**/*.ts"], instructionsFile: "  " } } });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/instructionsFile/);
  });

  it("throws on an invalid custom agent name", () => {
    const raw = JSON.stringify({
      agents: { "bad name!": { globs: ["**/*.ts"], instructionsFile: "agents/x.agent.md" } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/invalid custom agent name/i);
  });

  it("rejects an uppercase name (typo of a built-in) instead of treating it as custom", () => {
    // "Tester" is not the built-in "tester" (case-sensitive), and the lowercase-only name
    // pattern must reject it rather than route it through the custom-agent branch.
    const raw = JSON.stringify({
      agents: { Tester: { globs: ["**/*.spec.ts"], instructionsFile: "agents/x.agent.md" } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/invalid custom agent name/i);
  });

  it("throws on empty globs for a custom agent", () => {
    const raw = JSON.stringify({
      agents: { security: { globs: [], instructionsFile: "agents/security.agent.md" } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(/must not be empty/i);
  });

  it("throws on missing globs for a custom agent", () => {
    const raw = JSON.stringify({
      agents: { security: { instructionsFile: "agents/security.agent.md" } },
    });
    expect(() => parseRepoConfig(raw)).toThrow(/globs/);
  });

  it("throws on unknown key in a custom agent definition", () => {
    const raw = JSON.stringify({
      agents: {
        security: { globs: ["**/*.ts"], instructionsFile: "agents/s.agent.md", model: "gpt-4o" },
      },
    });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/model/);
  });

  it("throws when the agents section is not an object", () => {
    expect(() => parseRepoConfig(JSON.stringify({ agents: [] }))).toThrow(/"agents" must be an object/);
  });

  it("allows mixed built-in and custom agents in the same config", () => {
    const raw = JSON.stringify({
      agents: {
        tester: { globs: ["**/*.spec.ts"] },
        security: { globs: ["**/*.java"], instructionsFile: "agents/security.agent.md" },
      },
    });
    const result = parseRepoConfig(raw);
    expect(result?.agents?.tester).toEqual({ globs: ["**/*.spec.ts"] });
    expect(result?.agents?.security).toEqual({
      globs: ["**/*.java"],
      instructionsFile: "agents/security.agent.md",
    });
  });
});

describe("parseRepoConfig — exclude section", () => {
  it("returns null exclude when section is absent", () => {
    const result = parseRepoConfig(JSON.stringify({}));
    expect(result?.exclude).toBeNull();
  });

  it("parses a valid array of exclude globs", () => {
    const raw = JSON.stringify({ exclude: ["**/*.generated.ts", "vendor/**"] });
    const result = parseRepoConfig(raw);
    expect(result?.exclude).toEqual(["**/*.generated.ts", "vendor/**"]);
  });

  it("throws RepoConfigError on an empty exclude array", () => {
    const raw = JSON.stringify({ exclude: [] });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/must not be empty/i);
  });

  it("throws RepoConfigError when a glob entry is not a string", () => {
    const raw = JSON.stringify({ exclude: ["ok", 42] });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/non-empty string/i);
  });

  it("throws RepoConfigError on a whitespace-only glob", () => {
    const raw = JSON.stringify({ exclude: ["  "] });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
  });

  it("throws RepoConfigError when exclude is not an array", () => {
    const raw = JSON.stringify({ exclude: "**/*.ts" });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/array/i);
  });
});

describe("parseRepoConfig — excludeAgents section", () => {
  it("returns null excludeAgents when section is absent", () => {
    const result = parseRepoConfig(JSON.stringify({}));
    expect(result?.excludeAgents).toBeNull();
  });

  it("parses a valid array of built-in agent names", () => {
    const raw = JSON.stringify({ excludeAgents: ["ddd-reviewer", "performance"] });
    const result = parseRepoConfig(raw);
    expect(result?.excludeAgents).toEqual(["ddd-reviewer", "performance"]);
  });

  it("parses an array that includes a defined custom agent", () => {
    const raw = JSON.stringify({
      agents: { security: { globs: ["**/*.java"], instructionsFile: "agents/security.agent.md" } },
      excludeAgents: ["security"],
    });
    const result = parseRepoConfig(raw);
    expect(result?.excludeAgents).toEqual(["security"]);
  });

  it("deduplicates repeated entries", () => {
    const raw = JSON.stringify({ excludeAgents: ["tester", "tester", "architect"] });
    const result = parseRepoConfig(raw);
    expect(result?.excludeAgents).toEqual(["tester", "architect"]);
  });

  it("throws RepoConfigError on an empty excludeAgents array", () => {
    const raw = JSON.stringify({ excludeAgents: [] });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/must not be empty/i);
  });

  it("throws RepoConfigError when excludeAgents is not an array", () => {
    const raw = JSON.stringify({ excludeAgents: "tester" });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/array/i);
  });

  it("throws RepoConfigError when an entry is not a string", () => {
    const raw = JSON.stringify({ excludeAgents: ["tester", 42] });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/non-empty string/i);
  });

  it("throws RepoConfigError on a whitespace-only entry", () => {
    const raw = JSON.stringify({ excludeAgents: ["  "] });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
  });

  it("throws RepoConfigError on an unknown agent name", () => {
    const raw = JSON.stringify({ excludeAgents: ["nope"] });
    expect(() => parseRepoConfig(raw)).toThrow(RepoConfigError);
    expect(() => parseRepoConfig(raw)).toThrow(/unknown agent name/i);
    expect(() => parseRepoConfig(raw)).toThrow(/nope/);
  });

  it("includes built-in and defined custom names in the allowed set reported in the error", () => {
    const raw = JSON.stringify({
      agents: { security: { globs: ["**/*.java"], instructionsFile: "agents/security.agent.md" } },
      excludeAgents: ["nope"],
    });
    expect(() => parseRepoConfig(raw)).toThrow(/security/);
    expect(() => parseRepoConfig(raw)).toThrow(/tester/);
  });
});

describe("agentsToRoutingOverride", () => {
  it("returns null when agents is null", () => {
    expect(agentsToRoutingOverride(null)).toBeNull();
  });

  it("projects custom agent globs onto an agentGlobs override (extend mode)", () => {
    const override = agentsToRoutingOverride({
      security: { globs: ["**/*.ts"], instructionsFile: "agents/security.agent.md" },
    });
    expect(override).toEqual({ agentGlobs: { security: { globs: ["**/*.ts"], replace: false } } });
  });

  it("projects built-in override with replace: true", () => {
    const override = agentsToRoutingOverride({
      tester: { globs: ["**/*.spec.ts"], replace: true },
    });
    expect(override).toEqual({ agentGlobs: { tester: { globs: ["**/*.spec.ts"], replace: true } } });
  });

  it("defaults replace to false when not set", () => {
    const override = agentsToRoutingOverride({
      tester: { globs: ["**/*.spec.ts"] },
    });
    expect(override?.agentGlobs?.tester.replace).toBe(false);
  });

  it("merges a custom agent into routing config as a brand-new agent entry", () => {
    const override = agentsToRoutingOverride({
      security: { globs: ["**/*.ts"], instructionsFile: "agents/security.agent.md" },
    });
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    expect(result.agentGlobs["security"]).toEqual(["**/*.ts"]);
    expect(result.agentGlobs["tester"]).toEqual(defaultRoutingConfig.agentGlobs["tester"]);
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

  it("extends globs for the overridden agent (replace: false)", () => {
    const override = {
      agentGlobs: {
        "ddd-reviewer": { globs: ["**/internal/core/**/*.java"], replace: false },
      },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    const dddGlobs = result.agentGlobs["ddd-reviewer"];
    for (const g of defaultRoutingConfig.agentGlobs["ddd-reviewer"]) {
      expect(dddGlobs).toContain(g);
    }
    expect(dddGlobs).toContain("**/internal/core/**/*.java");
  });

  it("puts default globs before override globs in extend mode", () => {
    const override = {
      agentGlobs: {
        "ddd-reviewer": { globs: ["**/internal/core/**/*.java"], replace: false },
      },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    const dddGlobs = result.agentGlobs["ddd-reviewer"];
    const defaultLen = defaultRoutingConfig.agentGlobs["ddd-reviewer"].length;
    expect(dddGlobs.slice(0, defaultLen)).toEqual(defaultRoutingConfig.agentGlobs["ddd-reviewer"]);
    expect(dddGlobs[dddGlobs.length - 1]).toBe("**/internal/core/**/*.java");
  });

  it("deduplicates in extend mode: does not add glob already present in defaults", () => {
    const existingGlob = defaultRoutingConfig.agentGlobs["ddd-reviewer"][0];
    const override = {
      agentGlobs: { "ddd-reviewer": { globs: [existingGlob], replace: false } },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    const dddGlobs = result.agentGlobs["ddd-reviewer"];
    const count = dddGlobs.filter((g) => g === existingGlob).length;
    expect(count).toBe(1);
  });

  it("replaces globs entirely when replace: true", () => {
    const override = {
      agentGlobs: {
        tester: { globs: ["legacy/**/*.test.ts"], replace: true },
      },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    expect(result.agentGlobs["tester"]).toEqual(["legacy/**/*.test.ts"]);
    for (const g of defaultRoutingConfig.agentGlobs["tester"]) {
      expect(result.agentGlobs["tester"]).not.toContain(g);
    }
  });

  it("leaves other agents unchanged when only one agent is overridden", () => {
    const override = {
      agentGlobs: { "ddd-reviewer": { globs: ["**/extra/**/*.java"], replace: false } },
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
        "ddd-reviewer": { globs: ["**/internal/core/**/*.java"], replace: false },
        performance: { globs: ["**/infra/cache/**/*.java"], replace: false },
      },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    expect(result.agentGlobs["ddd-reviewer"]).toContain("**/internal/core/**/*.java");
    expect(result.agentGlobs["performance"]).toContain("**/infra/cache/**/*.java");
  });

  it("adds a brand-new agent (custom) as a fresh entry", () => {
    const override = {
      agentGlobs: { security: { globs: ["**/*.java"], replace: false } },
    };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    expect(result.agentGlobs["security"]).toEqual(["**/*.java"]);
  });

  it("preserves unmatchedFilesPolicy from base", () => {
    const override = { agentGlobs: { tester: { globs: ["**/*.spec.ts"], replace: false } } };
    const result = mergeRoutingConfig(defaultRoutingConfig, override);
    expect(result.unmatchedFilesPolicy).toBe(defaultRoutingConfig.unmatchedFilesPolicy);
  });
});

import { describe, expect, it } from "vitest";

import { buildRoutingExplanation, formatRoutingExplanation } from "../src/routingExplanation";
import type { RoutingRuntimeConfig } from "../src/routingTypes";

const config: RoutingRuntimeConfig = {
  unmatchedFilesPolicy: "skip",
  agentGlobs: {
    "clean-coder": ["src/**/*.ts", "!**/*.test.ts"],
    tester: ["**/*.test.ts"],
    architect: ["src/api/**/*.ts"],
  },
};

const changedFiles = [
  "src/api/orders.ts",
  "src/orders.test.ts",
  "Dockerfile",
  "vendor/lib.ts",
  "assets/logo.png",
];

describe("buildRoutingExplanation", () => {
  it("classifies every changed file the way a review run would treat it", () => {
    expect(buildRoutingExplanation(changedFiles, ["vendor/**"], config)).toEqual([
      { file: "Dockerfile", status: "unrouted", agents: [], negated: [] },
      { file: "assets/logo.png", status: "unsupported", agents: [], negated: [] },
      {
        file: "src/api/orders.ts",
        status: "routed",
        agents: [
          { agent: "clean-coder", matchedBy: "src/**/*.ts" },
          { agent: "architect", matchedBy: "src/api/**/*.ts" },
        ],
        negated: [],
      },
      {
        file: "src/orders.test.ts",
        status: "routed",
        agents: [{ agent: "tester", matchedBy: "**/*.test.ts" }],
        negated: [{ agent: "clean-coder", matchedBy: "src/**/*.ts", excludedBy: "!**/*.test.ts" }],
      },
      { file: "vendor/lib.ts", status: "excluded", excludedBy: "vendor/**", agents: [], negated: [] },
    ]);
  });

  it("keeps files that a negated exclude pattern re-includes", () => {
    const [entry] = buildRoutingExplanation(["vendor/keep/a.ts"], ["vendor/**", "!vendor/keep/**"], config);
    expect(entry?.status).toBe("unrouted");
  });
});

describe("formatRoutingExplanation", () => {
  it("renders a summary and one block per file", () => {
    const text = formatRoutingExplanation(
      buildRoutingExplanation(changedFiles, ["vendor/**"], config),
      "origin/main",
      ["clean-coder", "tester", "architect"]
    );

    expect(text).toBe(
      [
        "Routing for 5 changed files against origin/main: 2 reviewed, 1 not reviewed, 1 excluded, 1 skipped.",
        "Agents: clean-coder, tester, architect",
        "",
        "Dockerfile",
        "  not reviewed: no agent's globs match",
        "",
        "assets/logo.png",
        "  skipped: binary or lock file",
        "",
        "src/api/orders.ts",
        "  clean-coder  matched src/**/*.ts",
        "  architect    matched src/api/**/*.ts",
        "",
        "src/orders.test.ts",
        "  tester       matched **/*.test.ts",
        "  clean-coder  skipped: matched src/**/*.ts, removed by !**/*.test.ts",
        "",
        "vendor/lib.ts",
        '  excluded by "vendor/**"',
      ].join("\n")
    );
  });
});

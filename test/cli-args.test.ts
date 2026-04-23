import { describe, expect, it } from "vitest";

import { AGENT_NAMES } from "../src/routingTypes";
import { CliArgsError, formatCliUsage, parseCliArgs } from "../src/cliArgs";

function expectCliArgsError(argv: readonly string[], expectedMessage: RegExp): void {
  expect(() => parseCliArgs(argv)).toThrowError(CliArgsError);
  expect(() => parseCliArgs(argv)).toThrowError(expectedMessage);
}

describe("parseCliArgs", () => {
  it("returns defaults when no args are passed", () => {
    const result = parseCliArgs([]);

    expect(result).toEqual({
      annotate: true,
      report: false,
      clean: false,
      json: false,
      debug: false,
      showHelp: false,
      agents: [...AGENT_NAMES],
      agentsCsv: AGENT_NAMES.join(","),
      minSeverity: "info",
      maxParallel: 5,
    });
  });

  it("parses all supported flags and values", () => {
    const result = parseCliArgs([
      "--report",
      "--clean",
      "--json",
      "--debug",
      "--base",
      "  develop  ",
      "--agents",
      "tester, architect",
      "--severity",
      "warning",
      "--files",
      "  src/**/*.ts  ",
      "--parallel",
      "3",
      "-h",
    ]);

    expect(result).toEqual({
      annotate: true,
      report: true,
      clean: true,
      json: true,
      debug: true,
      showHelp: true,
      baseBranch: "develop",
      agents: ["tester", "architect"],
      agentsCsv: "tester,architect",
      minSeverity: "warning",
      fileFilter: "src/**/*.ts",
      maxParallel: 3,
    });
  });

  it("supports --help", () => {
    const result = parseCliArgs(["--help"]);

    expect(result.showHelp).toBe(true);
  });

  it("throws for invalid --severity", () => {
    expectCliArgsError(["--severity", "fatal"], /"--severity" must be one of/u);
  });

  it("throws for invalid --parallel value: 0", () => {
    expectCliArgsError(["--parallel", "0"], /"--parallel" must be a positive integer/u);
  });

  it("throws for invalid --parallel value: non-number", () => {
    expectCliArgsError(["--parallel", "three"], /"--parallel" must be a positive integer/u);
  });

  it("throws for empty --base", () => {
    expectCliArgsError(["--base", "   "], /"--base" must not be empty/u);
  });

  it("throws for empty --files", () => {
    expectCliArgsError(["--files", "   "], /"--files" must not be empty/u);
  });

  it("throws for empty or whitespace --agents list", () => {
    expectCliArgsError(["--agents", " ,  , "], /"--agents" must include at least one non-empty value/u);
  });
});

describe("formatCliUsage", () => {
  it("includes stable essential options", () => {
    const usage = formatCliUsage();

    expect(usage).toContain("Usage: ai-review [OPTIONS]");
    expect(usage).toContain("--base <branch>");
    expect(usage).toContain("--report");
    expect(usage).toContain("--clean");
    expect(usage).toContain("--agents <list>");
    expect(usage).toContain("--severity <min>");
    expect(usage).toContain("--files <glob>");
    expect(usage).toContain("--json");
    expect(usage).toContain("--debug");
    expect(usage).toContain("--parallel <n>");
    expect(usage).toContain("-h, --help");
  });
});

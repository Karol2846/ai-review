import { describe, expect, it } from "vitest";

import { CliArgsError, formatCliUsage, parseCliArgs } from "../src/cliArgs";

function expectCliArgsError(argv: readonly string[], expectedMessage: RegExp): void {
  expect(() => parseCliArgs(argv)).toThrowError(CliArgsError);
  expect(() => parseCliArgs(argv)).toThrowError(expectedMessage);
}

describe("parseCliArgs", () => {
  it("returns defaults when no args are passed (agents omitted → run all configured)", () => {
    const result = parseCliArgs([]);

    expect(result).toEqual({
      annotate: true,
      report: false,
      clean: false,
      json: false,
      debug: false,
      showHelp: false,
      force: false,
      minSeverity: "info",
      maxParallel: 5,
    });
    expect(result.agents).toBeUndefined();
    expect(result.command).toBeUndefined();
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
      "--exclude",
      "  **/*.generated.ts , vendor/** ",
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
      force: false,
      baseBranch: "develop",
      agents: ["tester", "architect"],
      minSeverity: "warning",
      exclude: ["**/*.generated.ts", "vendor/**"],
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

  it("throws for empty or whitespace --exclude list", () => {
    expectCliArgsError(["--exclude", " ,  , "], /"--exclude" must include at least one non-empty value/u);
  });

  it("throws for empty or whitespace --agents list", () => {
    expectCliArgsError(["--agents", " ,  , "], /"--agents" must include at least one non-empty value/u);
  });

  it("parses --exclude-agents as a CSV list", () => {
    const result = parseCliArgs(["--exclude-agents", "tester, ddd-reviewer"]);
    expect(result.excludeAgents).toEqual(["tester", "ddd-reviewer"]);
    expect(result.agents).toBeUndefined();
  });

  it("throws CliArgsError when --agents and --exclude-agents are both provided", () => {
    expectCliArgsError(
      ["--agents", "tester", "--exclude-agents", "performance"],
      /Use --agents or --exclude-agents, not both/u
    );
  });

  it("throws for empty or whitespace --exclude-agents list", () => {
    expectCliArgsError(
      ["--exclude-agents", " ,  , "],
      /"--exclude-agents" must include at least one non-empty value/u
    );
  });

  it("throws for unknown flag", () => {
    expectCliArgsError(["--unknown-flag"], /unknown/iu);
  });

  it("parses 'init' positional as command", () => {
    const result = parseCliArgs(["init"]);

    expect(result.command).toBe("init");
    expect(result.force).toBe(false);
  });

  it("parses --force flag", () => {
    const result = parseCliArgs(["init", "--force"]);

    expect(result.command).toBe("init");
    expect(result.force).toBe(true);
  });

  it("sets command to undefined when no positional is given (normal review run)", () => {
    const result = parseCliArgs(["--report"]);

    expect(result.command).toBeUndefined();
    expect(result.force).toBe(false);
  });

  it("throws for unknown command positional", () => {
    expectCliArgsError(["foo"], /Unknown command "foo"\. The only command is "init"\./u);
  });

  it("throws when extra positional is passed after init", () => {
    expectCliArgsError(["init", "extra"], /"init" takes no extra arguments/u);
  });

  it("throws for --parallel with decimal value", () => {
    expectCliArgsError(["--parallel", "1.5"], /"--parallel" must be a positive integer/u);
  });

  it("throws for --parallel with NaN", () => {
    expectCliArgsError(["--parallel", "NaN"], /"--parallel" must be a positive integer/u);
  });

  it("throws for --agents with comma-only value", () => {
    expectCliArgsError(["--agents", ","], /"--agents" must include at least one non-empty value/u);
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
    expect(usage).toContain("--exclude <list>");
    expect(usage).toContain("--json");
    expect(usage).toContain("--debug");
    expect(usage).toContain("--parallel <n>");
    expect(usage).toContain("-h, --help");
  });

  it("includes the init command and --force flag", () => {
    const usage = formatCliUsage();

    expect(usage).toContain("init");
    expect(usage).toContain("--force");
  });
});

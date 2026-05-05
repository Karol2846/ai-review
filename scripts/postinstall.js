#!/usr/bin/env node
// postinstall.js — Copy agents and skill into ~/.copilot after npm install -g

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

const INSTALL_PROVIDER_CONFIG_FILE_NAME = ".ai-review-install-provider.json";
const INSTALL_PROVIDER_TYPES = ["copilot", "ollama"];
const DEFAULT_INSTALL_PROVIDER = "copilot";

function log(msg) {
  process.stdout.write(msg + "\n");
}

function warn(msg) {
  process.stderr.write(`${YELLOW}⚠ ${msg}${RESET}\n`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function isInteractiveInstall() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const ciValue = String(process.env.CI ?? "").trim().toLowerCase();
  return ciValue !== "true" && ciValue !== "1";
}

function parseProviderSelection(input) {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "" || normalized === "1" || normalized === "copilot") {
    return "copilot";
  }

  if (normalized === "2" || normalized === "ollama") {
    return "ollama";
  }

  return null;
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function selectInstallProvider() {
  if (!isInteractiveInstall()) {
    log(
      `  ${DIM}No interactive terminal detected (or CI). Using default provider "${DEFAULT_INSTALL_PROVIDER}".${RESET}`
    );
    return DEFAULT_INSTALL_PROVIDER;
  }

  log("\nChoose the default ai-review provider:");
  log(`  ${DIM}1) copilot (default)${RESET}`);
  log(`  ${DIM}2) ollama${RESET}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await askQuestion(rl, "Select provider [1/2]: ");
    const selected = parseProviderSelection(answer);

    if (selected === null) {
      warn(
        `Invalid selection "${String(answer)}". Falling back to default provider "${DEFAULT_INSTALL_PROVIDER}".`
      );
      return DEFAULT_INSTALL_PROVIDER;
    }

    return selected;
  } finally {
    rl.close();
  }
}

function writeInstallProviderConfig(pkgRoot, provider) {
  if (!INSTALL_PROVIDER_TYPES.includes(provider)) {
    throw new Error(`Unsupported provider "${String(provider)}".`);
  }

  const configPath = path.join(pkgRoot, INSTALL_PROVIDER_CONFIG_FILE_NAME);
  const config = JSON.stringify({ provider }, null, 2);
  fs.writeFileSync(configPath, `${config}\n`, "utf8");
  return configPath;
}

async function run() {
  const pkgRoot = path.join(__dirname, "..");
  const agentsSrc = path.join(pkgRoot, "agents");
  const skillSrc = path.join(pkgRoot, "skill");
  const copilotDir = path.join(os.homedir(), ".copilot");
  const agentsDest = path.join(copilotDir, "agents");
  const skillDest = path.join(copilotDir, "skills", "ai-review");

  log(`\n${CYAN}Setting up ai-review Copilot integration...${RESET}`);

  const installProvider = await selectInstallProvider();
  const installConfigPath = writeInstallProviderConfig(pkgRoot, installProvider);
  log(`  ${DIM}✓ Saved default provider "${installProvider}" to ${installConfigPath}${RESET}`);

  // --- Agents ---
  if (!fs.existsSync(agentsSrc)) {
    warn("agents/ directory not found in package — skipping agent setup.");
  } else {
    fs.mkdirSync(agentsDest, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(agentsSrc)) {
      if (!entry.endsWith(".agent.md")) continue;
      const dest = path.join(agentsDest, entry);
      fs.copyFileSync(path.join(agentsSrc, entry), dest);
      log(`  ${DIM}✓ ~/.copilot/agents/${entry}${RESET}`);
      count++;
    }
    if (count === 0) {
      warn("No *.agent.md files found in agents/ — skipping agent setup.");
    }
  }

  // --- Skill ---
  if (!fs.existsSync(skillSrc)) {
    warn("skill/ directory not found in package — skipping skill setup.");
  } else {
    fs.mkdirSync(path.join(copilotDir, "skills"), { recursive: true });
    copyDir(skillSrc, skillDest);
    log(`  ${DIM}✓ ~/.copilot/skills/ai-review${RESET}`);
  }

  log(`\n${GREEN}✅ ai-review Copilot integration installed.${RESET}`);
  log(`\nUsage:`);
  log(`  ${DIM}ai-review${RESET}             Review current branch + insert TODO comments`);
  log(`  ${DIM}ai-review --report${RESET}    Also print terminal report`);
  log(`  ${DIM}ai-review --clean${RESET}     Remove [ai-review] TODOs`);
  log(`  ${DIM}ai-review --help${RESET}      Show all options`);
  log("");
}

run().catch((err) => {
  warn(`Copilot integration setup failed (non-fatal): ${err?.message ?? String(err)}`);
  warn("You can re-run setup manually: node node_modules/ai-review/scripts/postinstall.js");
});

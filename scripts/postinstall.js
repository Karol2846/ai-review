#!/usr/bin/env node
// postinstall.js — Configure ai-review provider and copy agents/skill after npm install -g

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
const PROVIDER_KINDS = ["openai-compatible", "anthropic", "google", "bedrock"];

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

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function promptProvider(rl) {
  log("\nSelect provider:");
  log(`  ${DIM}1) openai-compatible${RESET}  ${DIM}(OpenAI, Groq, OpenRouter, any OpenAI-compatible endpoint)${RESET}`);
  log(`  ${DIM}2) anthropic${RESET}`);
  log(`  ${DIM}3) google${RESET}`);
  log(`  ${DIM}4) bedrock${RESET}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = (await askQuestion(rl, "[1/2/3/4]: ")).trim();
    switch (answer) {
      case "1": case "openai-compatible": return "openai-compatible";
      case "2": case "anthropic":         return "anthropic";
      case "3": case "google":            return "google";
      case "4": case "bedrock":           return "bedrock";
      default:
        warn(`Invalid selection "${answer}". Enter 1, 2, 3, or 4.`);
    }
  }
}

async function promptNonEmpty(rl, question, defaultValue) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = await askQuestion(rl, question);
    const value = raw.trim();
    if (value.length > 0) return value;
    if (defaultValue !== undefined) return defaultValue;
    warn("Value cannot be empty.");
  }
}

async function promptBaseURL(rl) {
  const yesNo = (await askQuestion(rl, "Use a custom baseURL (e.g. for Groq, OpenRouter)? [y/N]: ")).trim().toLowerCase();
  if (yesNo !== "y" && yesNo !== "yes") return undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = (await askQuestion(rl, "baseURL: ")).trim();
    if (url.length === 0) {
      warn("baseURL cannot be empty.");
      continue;
    }
    try {
      new URL(url);
      return url;
    } catch {
      warn(`"${url}" is not a valid URL. Please enter a full URL including scheme (e.g. https://...)"`);
    }
  }
}

async function collectConfig(rl) {
  const provider = await promptProvider(rl);
  const model = await promptNonEmpty(rl, "Model name: ", undefined);
  const apiKeyEnv = await promptNonEmpty(rl, "Environment variable name for API key [AI_REVIEW_API_KEY]: ", "AI_REVIEW_API_KEY");

  let baseURL;
  if (provider === "openai-compatible") {
    baseURL = await promptBaseURL(rl);
  }

  return { provider, model, apiKeyEnv, ...(baseURL !== undefined ? { baseURL } : {}) };
}

function writeInstallProviderConfig(pkgRoot, config) {
  if (!PROVIDER_KINDS.includes(config.provider)) {
    throw new Error(`Unsupported provider "${String(config.provider)}".`);
  }

  const configPath = path.join(pkgRoot, INSTALL_PROVIDER_CONFIG_FILE_NAME);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

async function run() {
  const pkgRoot = path.join(__dirname, "..");
  const agentsSrc = path.join(pkgRoot, "agents");
  const skillSrc = path.join(pkgRoot, "skill");
  const copilotDir = path.join(os.homedir(), ".copilot");
  const agentsDest = path.join(copilotDir, "agents");
  const skillDest = path.join(copilotDir, "skills", "ai-review");

  log(`\n${CYAN}Setting up ai-review...${RESET}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let config;
  try {
    config = await collectConfig(rl);
  } finally {
    rl.close();
  }

  const installConfigPath = writeInstallProviderConfig(pkgRoot, config);
  log(`  ${DIM}✓ Saved provider config to ${installConfigPath}${RESET}`);
  log(`\nConfigured ai-review with ${config.provider} / ${config.model}. Set ${config.apiKeyEnv} in your shell before running ai-review.`);

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

  log(`\n${GREEN}✅ ai-review installed.${RESET}`);
  log(`\nUsage:`);
  log(`  ${DIM}ai-review${RESET}             Review current branch + insert TODO comments`);
  log(`  ${DIM}ai-review --report${RESET}    Also print terminal report`);
  log(`  ${DIM}ai-review --clean${RESET}     Remove [ai-review] TODOs`);
  log(`  ${DIM}ai-review --help${RESET}      Show all options`);
  log("");
}

run().catch((err) => {
  warn(`ai-review setup failed (non-fatal): ${err?.message ?? String(err)}`);
  warn("You can re-run setup manually: node node_modules/ai-review/scripts/postinstall.js");
});

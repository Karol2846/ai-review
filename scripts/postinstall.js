#!/usr/bin/env node
// postinstall.js — Copy agents and skill into ~/.copilot after npm install -g

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

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

function run() {
  const pkgRoot = path.join(__dirname, "..");
  const agentsSrc = path.join(pkgRoot, "agents");
  const skillSrc = path.join(pkgRoot, "skill");
  const copilotDir = path.join(os.homedir(), ".copilot");
  const agentsDest = path.join(copilotDir, "agents");
  const skillDest = path.join(copilotDir, "skills", "ai-review");

  log(`\n${CYAN}Setting up ai-review Copilot integration...${RESET}`);

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

try {
  run();
} catch (err) {
  warn(`Copilot integration setup failed (non-fatal): ${err?.message ?? String(err)}`);
  warn("You can re-run setup manually: node node_modules/ai-review/scripts/postinstall.js");
}

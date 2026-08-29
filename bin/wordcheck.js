#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const chalk = require("chalk");
const Agent = require("../lib/agent");

const args = process.argv.slice(2);
const version = require("../package.json").version;

// ---------------------------------------------------------------------------
// Colors — keep consistent with cli.js palette
// ---------------------------------------------------------------------------
const C = {
  pink:  chalk.hex("#FF79C6"),
  dim:   chalk.hex("#6272A4"),
  bar:   chalk.hex("#FF79C6"),
  red:   chalk.hex("#FF5555"),
  white: chalk.hex("#F8F8F2"),
  cyan:  chalk.hex("#8BE9FD"),
  green: chalk.hex("#50FA7B"),
};

// ---------------------------------------------------------------------------
// Wordmark
// ---------------------------------------------------------------------------
const WORDMARK = [
  "  ██╗    ██╗ ██████╗ ██████╗ ██████╗  ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗",
  "  ██║    ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝",
  "  ██║ █╗ ██║██║   ██║██████╔╝██║  ██║██║     ███████║█████╗  ██║     █████╔╝ ",
  "  ██║███╗██║██║   ██║██╔══██╗██║  ██║██║     ██╔══██║██╔══╝  ██║     ██╔═██╗ ",
  "  ╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝╚██████╗██║  ██║███████╗╚██████╗██║  ██╗",
  "   ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝",
];

function renderBanner() {
  console.log();
  for (const line of WORDMARK) console.log(C.pink(line));
  console.log();
  console.log(C.dim("  AI-Tell Scanner for Word Documents"));
  console.log();
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printUsage() {
  renderBanner();
  console.log(C.dim("  Usage"));
  console.log("    " + C.pink("wordcheck") + C.dim("                  launch interactive file selector"));
  console.log("    " + C.pink("wordcheck") + " " + C.white("<document.docx>") + C.dim("    scan a document directly"));
  console.log("    " + C.pink("wordcheck") + " " + C.white("<document.docx>") + " " + C.white("-n") + C.dim("  non-interactive / pipe mode"));
  console.log();
  console.log(C.dim("  Options"));
  console.log("    " + C.white("-n") + C.dim(", ") + C.white("--noninteractive") + C.dim("   pipe-friendly output, no REPL"));
  console.log("    " + C.white("-v") + C.dim(", ") + C.white("--version") + C.dim("          show version"));
  console.log("    " + C.white("-h") + C.dim(", ") + C.white("--help") + C.dim("             show this help"));
  console.log();
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(C.pink("wordcheck") + C.dim("  v" + version));
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const noninteractive = args.includes("--noninteractive") || args.includes("-n");
const fileArg = args.find((a) => !a.startsWith("-"));

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validateDocx(resolved) {
  if (!fs.existsSync(resolved)) return "File not found: " + resolved;
  if (!resolved.toLowerCase().endsWith(".docx")) return "Only .docx files are supported";
  return null;
}

// ---------------------------------------------------------------------------
// Interactive file prompt — shown when wordcheck is run with no arguments
// ---------------------------------------------------------------------------
function promptForFile() {
  renderBanner();
  console.log(C.bar("  │ ") + C.dim("Select a Word document to analyse"));
  console.log(C.bar("  │ ") + C.dim("Paste a file path and press Enter"));
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("SIGINT", () => {
    console.log("\n" + C.dim("  cancelled."));
    rl.close();
    process.exit(0);
  });

  const ask = () => {
    rl.question(C.bar("  │ ") + C.pink.bold("wordcheck") + C.dim(" › "), (answer) => {
      const input = answer.trim();
      if (!input) { ask(); return; }

      const resolved = path.resolve(input);
      const err = validateDocx(resolved);
      if (err) {
        console.error(C.red("  ✗  ") + C.dim(err));
        ask();
        return;
      }

      rl.close();
      launchAgent(resolved);
    });
  };

  ask();
}

// ---------------------------------------------------------------------------
// Launch the Agent
// ---------------------------------------------------------------------------
async function launchAgent(filePath) {
  const agent = new Agent();
  await agent.run(filePath);
}

// ---------------------------------------------------------------------------
// Non-interactive scan (simple output for piping)
// ---------------------------------------------------------------------------
async function noninteractiveScan(filePath) {
  const { scanDisk } = require("../lib/scanner");
  const { buildFindings, summarizeFindings } = require("../lib/findings");

  let result;
  try {
    result = await scanDisk(filePath);
  } catch (e) {
    console.error("Error: " + e.message);
    process.exit(1);
  }

  const findings = buildFindings(result);
  const summary = summarizeFindings(findings);

  const pct = result.aiPercentage;
  const verdict = pct >= 50 ? "likely AI-assisted" : pct >= 25 ? "mixed signals" : "reads human";
  console.log(`File: ${path.basename(filePath)}`);
  console.log(`Paragraphs: ${result.totalBody}  Score: ${result.totalScore}  AI: ${pct.toFixed(0)}%  (${verdict})`);
  console.log(`Findings: ${summary.total}  HIGH: ${summary.bySeverity.HIGH}  MED: ${summary.bySeverity.MEDIUM}  LOW: ${summary.bySeverity.LOW}`);
  console.log();

  for (const f of findings) {
    const sev = f.severity === "HIGH" ? "!!" : f.severity === "MEDIUM" ? "! " : "  ";
    console.log(`${sev} ${f.id} [${f.category}] ${f.title}`);
  }
}

// ---------------------------------------------------------------------------
// Main routing
// ---------------------------------------------------------------------------
if (!fileArg) {
  if (noninteractive) {
    console.error(C.red("Error: ") + "A file path is required in non-interactive mode");
    console.error(C.dim("Usage: wordcheck <document.docx> -n"));
    process.exit(1);
  }
  promptForFile();
} else {
  const resolved = path.resolve(fileArg);
  const err = validateDocx(resolved);
  if (err) {
    console.error(C.red("  ✗  ") + err);
    process.exit(1);
  }

  if (noninteractive) {
    noninteractiveScan(resolved);
  } else {
    launchAgent(resolved);
  }
}

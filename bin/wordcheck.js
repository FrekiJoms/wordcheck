#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const Agent = require("../lib/agent");
const { renderWordmark } = require("../lib/wordmark");

const args = process.argv.slice(2);
const version = require("../package.json").version;

const C = {
  pink:  chalk.hex("#FF79C6"),
  dim:   chalk.hex("#6272A4"),
  red:   chalk.hex("#FF5555"),
  white: chalk.hex("#F8F8F2"),
};

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------
function printUsage() {
  console.log();
  for (const line of renderWordmark()) console.log(line);
  console.log();
  console.log(C.dim("  AI-Tell Scanner for Word Documents"));
  console.log();
  console.log(C.dim("  Usage"));
  console.log("    " + C.pink("wordcheck") + C.dim("                  open interactive agent"));
  console.log("    " + C.pink("wordcheck") + " " + C.white("<document.docx>") + C.dim("    scan a document"));
  console.log("    " + C.pink("wordcheck") + " " + C.white("<document.docx>") + " " + C.white("-n") + C.dim("  non-interactive"));
  console.log();
  console.log(C.dim("  Options"));
  console.log("    " + C.white("-n") + C.dim(", ") + C.white("--noninteractive") + C.dim("   pipe-friendly output"));
  console.log("    " + C.white("-v") + C.dim(", ") + C.white("--version") + C.dim("          show version"));
  console.log("    " + C.white("-h") + C.dim(", ") + C.white("--help") + C.dim("             show help"));
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
// Non-interactive scan (piping/CI)
// ---------------------------------------------------------------------------
async function noninteractiveScan(filePath) {
  const { scanDisk } = require("../lib/scanner");
  const { buildFindings, summarizeFindings } = require("../lib/findings");
  const { renderTable } = require("../lib/table");
  const chalk = require("chalk");
  const Co = require("../lib/colors");

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

  console.log();
  console.log(`  File: ${path.basename(filePath)}`);
  console.log(`  Paragraphs: ${result.totalBody}  Score: ${result.totalScore}  AI: ${pct.toFixed(0)}%  (${verdict})`);
  console.log(`  Findings: ${findings.length}  HIGH: ${summary.bySeverity.HIGH}  MED: ${summary.bySeverity.MEDIUM}  LOW: ${summary.bySeverity.LOW}`);
  console.log();

  if (findings.length > 0) {
    const headers = ["ID", "Sev", "Category", "Title"];
    const rows = findings.map((f) => {
      const sev = f.severity === "HIGH" ? chalk.bgRed.white(" " + f.severity.charAt(0) + " ") :
                  f.severity === "MEDIUM" ? chalk.bgYellow.black(" " + f.severity.charAt(0) + " ") :
                  chalk.bgGreen.black(" " + f.severity.charAt(0) + " ");
      return [Co.dim(f.id), sev, Co.dim(f.category), Co.dim(f.title)];
    });
    const table = renderTable({ headers, rows, headerStyle: chalk.bold, dimStyle: Co.dim });
    for (const line of table) console.log(line);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Main routing
// ---------------------------------------------------------------------------
if (!fileArg) {
  if (noninteractive) {
    console.error(C.red("  ✗  ") + "A file path is required in non-interactive mode");
    console.error(C.dim("     Usage: wordcheck <document.docx> -n"));
    process.exit(1);
  }
  // Launch agent TUI with file selector
  const agent = new Agent();
  agent.runWithFileSelector();
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
    // Launch agent TUI with file
    const agent = new Agent();
    agent.run(resolved);
  }
}

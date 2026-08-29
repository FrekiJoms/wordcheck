#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const chalk = require("chalk");
const {
  interactiveScan,
  noninteractiveScan,
  renderBanner,
  renderFilePromptUI,
  replPrompt,
} = require("../lib/cli");

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
  renderBanner(false);
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
// Interactive file prompt — uses replPrompt() from cli.js (single definition)
// ---------------------------------------------------------------------------
function promptForFile() {
  renderFilePromptUI();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("SIGINT", () => {
    console.log("\n" + C.dim("  cancelled."));
    rl.close();
    process.exit(0);
  });

  const ask = () => {
    rl.question(replPrompt(), (answer) => {
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
      interactiveScan(resolved);
    });
  };

  ask();
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
    interactiveScan(resolved);
  }
}

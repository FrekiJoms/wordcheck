#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { interactiveScan, noninteractiveScan, renderBanner } = require("../lib/cli");

const args = process.argv.slice(2);
const version = require("../package.json").version;

function printUsage() {
  renderBanner();
  console.log("  Usage: wordcheck <document.docx>\n");
  console.log("  Options:");
  console.log("    -n, --noninteractive   Non-interactive mode (for piping)");
  console.log("    -v, --version          Show version");
  console.log("    -h, --help             Show this help\n");
  console.log("  Examples:");
  console.log("    wordcheck my_paper.docx");
  console.log("    wordcheck my_paper.docx -n | more");
}

if (args.includes("--version") || args.includes("-v")) {
  console.log("wordcheck " + version);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const noninteractive = args.includes("--noninteractive") || args.includes("-n");
const filePath = args.find((a) => !a.startsWith("-"));

if (!filePath) {
  printUsage();
  process.exit(0);
}

const resolved = path.resolve(filePath);
if (!fs.existsSync(resolved)) {
  console.error("Error: File not found: " + filePath);
  process.exit(1);
}

if (!resolved.endsWith(".docx")) {
  console.error("Error: Only .docx files are supported");
  process.exit(1);
}

if (noninteractive) {
  noninteractiveScan(resolved);
} else {
  interactiveScan(resolved);
}

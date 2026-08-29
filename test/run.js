#!/usr/bin/env node
"use strict";
/**
 * Test runner wrapper — runs test/index.js and writes results to
 * test/results.txt so we can read them back via the VS Code MCP.
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const outFile = path.join(__dirname, "results.txt");

try {
  const out = execSync("node test/index.js", {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  fs.writeFileSync(outFile, "EXIT:0\n" + out);
  process.stdout.write(out);
  process.exit(0);
} catch (e) {
  const combined = "EXIT:" + (e.status || 1) + "\n" + (e.stdout || "") + "\n" + (e.stderr || "");
  fs.writeFileSync(outFile, combined);
  process.stdout.write(combined);
  process.exit(e.status || 1);
}

"use strict";

const path = require("path");
const readline = require("readline");
const chalk = require("chalk");
const boxen = require("boxen");
const { scanDisk, suggestFixes } = require("./scanner");

const BANNER = `
    __        __   _    _____                  _             _
   \\ \\      / /__| |__|_   _|__ _ __ _ __ ___| |_ ___  __ _| |
    \\ \\ /\\ / / _ \\ '_ \\| | |/ _ \\ '__| '_ \` _ \\ __/ _ \\/ _\` | |
     \\ V  V /  __/ |_) | | |  __/ |  | | | | | ||  __/ (_| | |
      \\_/\\_/ \\___|_.__/|_|_|\\___|_|  |_| |_| |_|\\___|\\__,_|_|
`;

function clear() {
  process.stdout.write(process.platform === "win32" ? "\x1Bc" : "\x1B[2J\x1B[3J\x1B[H");
}

function renderBanner() {
  console.log(chalk.hex("#5B8DEF")(BANNER));
  console.log(chalk.dim("  AI-Tell Scanner for Word Documents\n"));
}

function renderFileInfo(result) {
  const pctColor = result.aiPercentage >= 50 ? chalk.red : result.aiPercentage >= 25 ? chalk.yellow : chalk.green;
  const lines = [
    `${chalk.bold("File:")}            ${chalk.magenta(path.basename(result.filename))}`,
    `${chalk.bold("Body Paragraphs:")} ${result.totalBody}`,
    `${chalk.bold("Total Score:")}     ${chalk.cyan(result.totalScore)}`,
    `${chalk.bold("AI Likelihood:")}   ${pctColor(result.aiPercentage.toFixed(0) + "%")}`,
  ];
  console.log(boxen(lines.join("\n"), { title: chalk.bold.blue("File Overview"), padding: 1, margin: { left: 1 }, borderStyle: "round", width: 60 }));
}

function renderRiskSummary(result) {
  const total = result.totalBody || 1;
  const bar = (count, color) => color("\u2588".repeat(Math.max(1, Math.floor((count / total) * 25))));

  console.log(chalk.bold.blue("\n  Risk Breakdown"));
  console.log(chalk.dim("  " + "-".repeat(40)));
  console.log(`  ${chalk.red.bold("HIGH")}    ${String(result.highCount).padStart(3)}  ${bar(result.highCount, chalk.red)}`);
  console.log(`  ${chalk.yellow.bold("MEDIUM")}  ${String(result.mediumCount).padStart(3)}  ${bar(result.mediumCount, chalk.yellow)}`);
  console.log(`  ${chalk.green.bold("LOW")}     ${String(result.lowCount).padStart(3)}  ${bar(result.lowCount, chalk.green)}`);
  console.log();
}

function renderParagraphList(result, showLow = false) {
  console.log(chalk.bold.blue("  Paragraph Analysis"));
  console.log(chalk.dim("  " + "-".repeat(70)));
  console.log(chalk.dim(`  ${"#".padEnd(5)} ${"Risk".padEnd(10)} ${"Score".padEnd(7)} Preview`));
  console.log(chalk.dim("  " + "-".repeat(70)));

  for (const p of result.paragraphs) {
    if (p.level === "SKIP") continue;
    if (p.level === "LOW" && !showLow) continue;

    const riskColor = p.level === "HIGH" ? chalk.red : p.level === "MEDIUM" ? chalk.yellow : chalk.green;
    const preview = p.text.length > 50 ? p.text.slice(0, 50).replace(/\n/g, " ") + "..." : p.text.replace(/\n/g, " ");
    console.log(`  ${String(p.index).padEnd(5)} ${riskColor(p.level.padEnd(10))} ${chalk.cyan(String(p.score).padEnd(7))} ${chalk.dim(preview)}`);
  }
  console.log();
}

function renderParagraphDetail(para) {
  const riskColor = para.level === "HIGH" ? chalk.red : para.level === "MEDIUM" ? chalk.yellow : chalk.green;
  console.log(`\n  ${chalk.bold("Paragraph " + para.index)} - ${riskColor(para.level)} (score: ${para.score})`);
  console.log(chalk.dim("  " + "-".repeat(60)));

  // Wrap text in a box
  const maxWidth = 56;
  const words = para.text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxWidth && line) {
      lines.push(line.trim());
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(line.trim());
  console.log(boxen(lines.join("\n"), { padding: 1, borderStyle: "single", width: 60, margin: { left: 2 } }));

  console.log(`  ${chalk.bold("Words:")}        ${para.wordCount}`);
  console.log(`  ${chalk.bold("Sentences:")}    ${para.sentenceCount}`);
  console.log(`  ${chalk.bold("Citations:")}    ${para.citationCount}`);
  console.log(`  ${chalk.bold("Contractions:")} ${para.hasContractions ? chalk.green("Yes") : chalk.red("No")}`);
  console.log(`  ${chalk.bold("Em-dashes:")}    ${para.emDashCount}`);

  if (para.flags.length > 0) {
    console.log(`\n  ${chalk.bold("AI Tells Found:")}`);
    for (const f of para.flags) {
      console.log(`    ${chalk.yellow(">")} ${f.text} ${chalk.dim("+" + f.weight)}`);
    }
  }

  const suggestions = suggestFixes(para);
  if (suggestions.length > 0) {
    console.log(`\n  ${chalk.bold("Suggested Fixes:")}`);
    suggestions.forEach((s, i) => console.log(`    ${chalk.green((i + 1) + ".")} ${s}`));
  }
  console.log();
}

function renderRecommendations(result) {
  const allFlags = result.paragraphs.flatMap((p) => p.flags);
  console.log(`\n  ${chalk.bold("Recommendations:")}\n`);

  const phraseFlags = allFlags.filter((f) => f.category === "phrase");
  if (phraseFlags.length > 0) {
    console.log(`  ${chalk.yellow("1.")} Replace AI phrases:`);
    const seen = new Set();
    for (const f of phraseFlags) {
      const key = f.text.split(" x")[0];
      if (!seen.has(key)) { console.log(`       ${f.text}`); seen.add(key); }
    }
  }

  const starterFlags = allFlags.filter((f) => f.category === "starter");
  if (starterFlags.length > 0) {
    console.log(`  ${chalk.yellow("2.")} Vary sentence starters:`);
    for (const f of starterFlags) console.log(`       ${f.text}`);
  }

  const uniFlags = allFlags.filter((f) => f.category === "uniformity");
  if (uniFlags.length > 0) {
    console.log(`  ${chalk.yellow("3.")} Vary sentence lengths:`);
    for (const f of uniFlags) console.log(`       ${f.text}`);
  }

  const noCon = result.paragraphs.filter((p) => !p.hasContractions && p.wordCount > 30);
  if (noCon.length > 0) console.log(`  ${chalk.yellow("4.")} Add contractions (don't, it's, can't, etc.)`);

  const dashFlags = allFlags.filter((f) => f.category === "dash");
  if (dashFlags.length > 0) console.log(`  ${chalk.yellow("5.")} Replace em-dashes with commas or parentheses`);
}

async function interactiveScan(filePath) {
  clear();
  renderBanner();

  console.log(chalk.dim(`  Scanning ${chalk.magenta(path.basename(filePath))}...\n`));

  let result;
  try {
    result = await scanDisk(filePath);
  } catch (e) {
    console.log(chalk.red(`  Error: ${e.message}`));
    return;
  }

  renderFileInfo(result);
  renderRiskSummary(result);
  renderParagraphList(result, false);

  console.log(`  ${chalk.bold.blue("Commands:")} ${chalk.bold("<number>")} = detail | ${chalk.bold("all")} = show low | ${chalk.bold("fix")} = recs | ${chalk.bold("rescan")} | ${chalk.bold("quit")}`);
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => {
    rl.question(chalk.bold.blue("wordcheck> "), async (answer) => {
      const cmd = answer.trim().toLowerCase();
      if (!cmd) { prompt(); return; }
      if (cmd === "quit" || cmd === "exit" || cmd === "q") { console.log("  Bye!"); rl.close(); return; }
      if (cmd === "all") { renderParagraphList(result, true); }
      else if (cmd === "fix") { renderRecommendations(result); }
      else if (cmd === "rescan") {
        console.log("  Rescanning...");
        try {
          result = await scanDisk(filePath);
          renderFileInfo(result);
          renderRiskSummary(result);
          renderParagraphList(result, false);
        } catch (e) { console.log(chalk.red(`  Error: ${e.message}`)); }
      }
      else if (/^\d+$/.test(cmd)) {
        const para = result.paragraphs.find((p) => p.index === parseInt(cmd));
        if (para) renderParagraphDetail(para);
        else console.log(chalk.red(`  Paragraph ${cmd} not found.`));
      }
      else { console.log(chalk.red(`  Unknown command: ${cmd}`)); }
      prompt();
    });
  };
  prompt();
}

async function noninteractiveScan(filePath) {
  let result;
  try {
    result = await scanDisk(filePath);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  renderFileInfo(result);
  renderRiskSummary(result);
  renderParagraphList(result, true);
  renderRecommendations(result);
}

module.exports = { interactiveScan, noninteractiveScan, renderBanner };

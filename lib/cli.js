"use strict";

const path = require("path");
const readline = require("readline");
const chalk = require("chalk");
const { scanDisk, suggestFixes } = require("./scanner");
const { renderWordmark } = require("./wordmark");

// ---------------------------------------------------------------------------
// Color palette — OpenCode-inspired dark theme
// ---------------------------------------------------------------------------
const C = {
  brand:  chalk.hex("#5B8DEF"),   // WordCheck blue — banner / section headers
  pink:   chalk.hex("#FF79C6"),   // keyword / label accent
  cyan:   chalk.hex("#8BE9FD"),   // values / scores
  green:  chalk.hex("#50FA7B"),   // LOW risk / positive
  yellow: chalk.hex("#F1FA8C"),   // MEDIUM risk / warnings
  red:    chalk.hex("#FF5555"),   // HIGH risk / errors
  dim:    chalk.hex("#6272A4"),   // secondary text
  white:  chalk.hex("#F8F8F2"),   // primary body text
  bar:    chalk.hex("#FF79C6"),   // left accent bar │
};

const VERSION = require("../package.json").version;

// ---------------------------------------------------------------------------
// Commands — single source of truth for the REPL
// ---------------------------------------------------------------------------
const COMMANDS = [
  { key: "<number>", desc: "inspect paragraph" },
  { key: "all",     desc: "show low-risk"      },
  { key: "fix",     desc: "recommendations"    },
  { key: "rescan",  desc: "re-analyse"         },
  { key: "help",    desc: "commands"           },
  { key: "quit",    desc: "exit"               },
];

// ---------------------------------------------------------------------------
// Terminal utilities
// ---------------------------------------------------------------------------
function clear() {
  process.stdout.write(
    process.platform === "win32" ? "\x1Bc" : "\x1B[2J\x1B[3J\x1B[H"
  );
}

function termWidth() {
  return Math.min(process.stdout.columns || 80, 100);
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

/** Full-width status bar with green ● indicator */
function renderStatusBar(label = "") {
  const w = termWidth();
  const left  = `  ${C.green("●")} ${C.pink("wordcheck")}  ${C.dim("v" + VERSION)}`;
  const right = label ? C.dim(label + "  ") : C.dim("ready  ");
  const leftV  = left.replace(/\x1B\[[0-9;]*m/g, "");
  const rightV = right.replace(/\x1B\[[0-9;]*m/g, "");
  const gap = Math.max(1, w - leftV.length - rightV.length);
  console.log(C.dim("─".repeat(w)));
  console.log(left + " ".repeat(gap) + right);
}

/** Keyboard hints row */
function renderKeyHints() {
  const hints = COMMANDS.map((c) => `${C.white.bold(c.key)} ${C.dim(c.desc)}`);
  console.log("  " + hints.join(C.dim("   ·   ")));
  console.log();
}

// ---------------------------------------------------------------------------
// Banners — full (launch / loading) and short (results / rescan)
// ---------------------------------------------------------------------------
function renderBanner(short = false) {
  console.log();
  const wordmark = renderWordmark();
  // short mode: show top, middle, and bottom lines only (lines 0, 3, 6)
  const lines = short ? [wordmark[0], wordmark[3], wordmark[6]] : wordmark;
  for (const line of lines) console.log("  " + line);
  console.log();
  if (!short) {
    console.log(C.dim("  AI-Agent for detecting AI-generated text in Word documents"));
    console.log();
  }
}

// ---------------------------------------------------------------------------
// REPL prompt — single definition, used everywhere
// ---------------------------------------------------------------------------
function replPrompt() {
  return C.bar("  │ ") + C.pink.bold("wordcheck") + C.dim(" › ");
}

// ---------------------------------------------------------------------------
// File prompt UI (no-arg launch)
// ---------------------------------------------------------------------------
function renderFilePromptUI() {
  clear();
  renderBanner(false);
  console.log(C.bar("  │ ") + C.dim("Select a Word document to analyse"));
  console.log(C.bar("  │ ") + C.dim("Paste a file path and press Enter"));
  console.log();
  renderKeyHints();
  renderStatusBar("no document loaded");
  console.log();
}

// ---------------------------------------------------------------------------
// Scan loading state
// ---------------------------------------------------------------------------
function renderScanningState(filename) {
  clear();
  renderBanner(false);
  console.log(C.bar("  │ ") + C.dim("Scanning ") + C.pink(filename) + C.dim("..."));
  console.log(C.bar("  │ ") + C.dim("Analysing paragraphs · detecting AI-tell patterns"));
  console.log();
}

// ---------------------------------------------------------------------------
// File overview
// ---------------------------------------------------------------------------
function renderFileInfo(result) {
  const pct = result.aiPercentage;
  const pctColor = pct >= 50 ? C.red : pct >= 25 ? C.yellow : C.green;
  const verdict  = pct >= 50 ? "likely AI-assisted" : pct >= 25 ? "mixed signals" : "reads human";

  console.log();
  console.log(C.bar("  │ ") + C.white.bold(path.basename(result.filename)));
  console.log(
    C.bar("  │ ") + C.dim("paragraphs ") + C.cyan(String(result.totalBody)) +
    C.dim("   score ") + C.cyan(String(result.totalScore)) +
    C.dim("   ai likelihood ") + pctColor(pct.toFixed(0) + "%") +
    C.dim("  ·  ") + pctColor(verdict)
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Risk breakdown
// ---------------------------------------------------------------------------
function renderRiskSummary(result) {
  const total = result.totalBody || 1;
  const barWidth = 20;
  const filled = (count) => Math.max(0, Math.round((count / total) * barWidth));

  const highBar  = C.red(   "█".repeat(filled(result.highCount)));
  const medBar   = C.yellow("█".repeat(filled(result.mediumCount)));
  const lowBar   = C.green( "█".repeat(filled(result.lowCount)));
  const emptyBar = C.dim(   "░".repeat(
    Math.max(0, barWidth - filled(result.highCount) - filled(result.mediumCount) - filled(result.lowCount))
  ));

  console.log(
    "  " + C.red.bold("HIGH") + "  " + String(result.highCount).padStart(2) + "  " +
    C.yellow.bold("MED") + "  " + String(result.mediumCount).padStart(2) + "  " +
    C.green.bold("LOW") + "  " + String(result.lowCount).padStart(2) + "    " +
    highBar + medBar + lowBar + emptyBar
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Paragraph list
// ---------------------------------------------------------------------------
function renderParagraphList(result, showLow = false) {
  const w = termWidth();

  console.log(
    "  " + C.dim("  # ") + C.dim("risk      ") + C.dim("score  ") + C.dim("paragraph preview")
  );
  console.log("  " + C.dim("─".repeat(Math.min(w - 4, 72))));

  let shown = 0;
  for (const p of result.paragraphs) {
    if (p.level === "SKIP") continue;
    if (p.level === "LOW" && !showLow) continue;

    const riskColor = p.level === "HIGH" ? C.red : p.level === "MEDIUM" ? C.yellow : C.green;
    const riskDot   = p.level === "HIGH" ? C.red("●") : p.level === "MEDIUM" ? C.yellow("●") : C.green("●");
    const preview   = p.text.replace(/\s+/g, " ").slice(0, 52);
    const ellipsis  = p.text.length > 52 ? C.dim("…") : "";

    console.log(
      "  " +
      C.dim(String(p.index).padStart(3)) + " " +
      riskDot + " " + riskColor(p.level.padEnd(7)) + "  " +
      C.cyan(String(p.score).padEnd(5)) + "  " +
      C.dim(preview) + ellipsis
    );
    shown++;
  }

  if (shown === 0) {
    console.log("  " + C.dim("  no paragraphs at this filter level"));
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Paragraph detail
// ---------------------------------------------------------------------------
function renderParagraphDetail(para) {
  const riskColor = para.level === "HIGH" ? C.red : para.level === "MEDIUM" ? C.yellow : C.green;
  const riskDot   = para.level === "HIGH" ? C.red("●") : para.level === "MEDIUM" ? C.yellow("●") : C.green("●");

  console.log();
  console.log(
    C.bar("  │ ") +
    C.white.bold("Paragraph " + para.index) + "  " +
    riskDot + " " + riskColor(para.level) + C.dim("  score " + para.score)
  );
  console.log(C.bar("  │"));

  const maxWidth = 64;
  const words = para.text.replace(/\s+/g, " ").trim().split(" ");
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxWidth && line) {
      console.log(C.bar("  │ ") + C.dim(line.trim()));
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) console.log(C.bar("  │ ") + C.dim(line.trim()));

  console.log(C.bar("  │"));
  console.log(
    C.bar("  │ ") +
    C.dim("words ") + C.cyan(String(para.wordCount)) +
    C.dim("   sentences ") + C.cyan(String(para.sentenceCount)) +
    C.dim("   citations ") + C.cyan(String(para.citationCount)) +
    C.dim("   contractions ") + (para.hasContractions ? C.green("yes") : C.red("no")) +
    C.dim("   em-dashes ") + C.cyan(String(para.emDashCount))
  );

  if (para.flags.length > 0) {
    console.log(C.bar("  │"));
    console.log(C.bar("  │ ") + C.pink.bold("AI tells"));
    for (const f of para.flags) {
      console.log(C.bar("  │ ") + C.yellow("  ›  ") + C.white(f.text) + C.dim("  +" + f.weight));
    }
  }

  const suggestions = suggestFixes(para);
  if (suggestions.length > 0) {
    console.log(C.bar("  │"));
    console.log(C.bar("  │ ") + C.pink.bold("suggested fixes"));
    suggestions.forEach((s, i) => {
      console.log(C.bar("  │ ") + C.green("  " + (i + 1) + ".  ") + C.white(s));
    });
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------
function renderRecommendations(result) {
  const allFlags = result.paragraphs.flatMap((p) => p.flags);

  console.log();
  console.log(C.bar("  │ ") + C.pink.bold("Recommendations"));
  console.log(C.bar("  │"));

  let n = 0;

  const phraseFlags = allFlags.filter((f) => f.category === "phrase");
  if (phraseFlags.length > 0) {
    n++;
    console.log(C.bar("  │ ") + C.yellow("  " + n + ".  ") + C.white("Replace AI phrases"));
    const seen = new Set();
    for (const f of phraseFlags) {
      const key = f.text.split(" x")[0];
      if (!seen.has(key)) { console.log(C.bar("  │ ") + C.dim("       " + f.text)); seen.add(key); }
    }
  }

  const starterFlags = allFlags.filter((f) => f.category === "starter");
  if (starterFlags.length > 0) {
    n++;
    console.log(C.bar("  │ ") + C.yellow("  " + n + ".  ") + C.white("Vary sentence starters"));
    for (const f of starterFlags) console.log(C.bar("  │ ") + C.dim("       " + f.text));
  }

  const uniFlags = allFlags.filter((f) => f.category === "uniformity");
  if (uniFlags.length > 0) {
    n++;
    console.log(C.bar("  │ ") + C.yellow("  " + n + ".  ") + C.white("Vary sentence lengths"));
    for (const f of uniFlags) console.log(C.bar("  │ ") + C.dim("       " + f.text));
  }

  const noCon = result.paragraphs.filter((p) => !p.hasContractions && p.wordCount > 30);
  if (noCon.length > 0) {
    n++;
    console.log(C.bar("  │ ") + C.yellow("  " + n + ".  ") + C.white("Add contractions") + C.dim("  don't · it's · can't · we're"));
  }

  const dashFlags = allFlags.filter((f) => f.category === "dash");
  if (dashFlags.length > 0) {
    n++;
    console.log(C.bar("  │ ") + C.yellow("  " + n + ".  ") + C.white("Replace em-dashes") + C.dim("  use commas or parentheses"));
  }

  if (n === 0) {
    console.log(C.bar("  │ ") + C.green("  ✓  No major issues. The document reads naturally."));
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Interactive scan
// ---------------------------------------------------------------------------
async function interactiveScan(filePath) {
  renderScanningState(path.basename(filePath));

  let result;
  try {
    result = await scanDisk(filePath);
  } catch (e) {
    console.error(C.red("  ✗  Error: " + e.message));
    console.error(C.dim("  Check that the file is a valid, non-corrupted .docx document."));
    process.exit(1);
  }

  clear();
  renderBanner(true);  // short banner on results screen — preserves space for data
  renderFileInfo(result);
  renderRiskSummary(result);
  renderParagraphList(result, false);
  renderKeyHints();
  renderStatusBar(path.basename(filePath));
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("SIGINT", () => {
    console.log("\n" + C.dim("  bye."));
    rl.close();
    process.exit(0);
  });

  const prompt = () => {
    rl.question(replPrompt(), async (answer) => {
      const cmd = answer.trim().toLowerCase();

      if (!cmd) { prompt(); return; }

      if (cmd === "quit" || cmd === "exit" || cmd === "q") {
        console.log(C.dim("  bye."));
        rl.close();
        return;
      }

      if (cmd === "help") {
        renderKeyHints();
      } else if (cmd === "all") {
        renderParagraphList(result, true);
      } else if (cmd === "fix") {
        renderRecommendations(result);
      } else if (cmd === "rescan") {
        renderScanningState(path.basename(filePath));
        try {
          result = await scanDisk(filePath);
          clear();
          renderBanner(true);  // short banner on rescan too
          renderFileInfo(result);
          renderRiskSummary(result);
          renderParagraphList(result, false);
          renderKeyHints();
          renderStatusBar(path.basename(filePath));
          console.log();
        } catch (e) {
          console.error(C.red("  ✗  Error during rescan: " + e.message));
        }
      } else if (/^\d+$/.test(cmd)) {
        const para = result.paragraphs.find((p) => p.index === parseInt(cmd, 10));
        if (para) {
          renderParagraphDetail(para);
        } else {
          console.error(C.red("  ✗  ") + C.dim(`Paragraph ${cmd} not found. Use a number from the list.`));
        }
      } else {
        console.error(C.red("  ✗  ") + C.dim(`Unknown command "${cmd}". Type `) + C.white.bold("help") + C.dim(" to see commands."));
      }

      prompt();
    });
  };

  prompt();
}

// ---------------------------------------------------------------------------
// Non-interactive scan
// ---------------------------------------------------------------------------
async function noninteractiveScan(filePath) {
  let result;
  try {
    result = await scanDisk(filePath);
  } catch (e) {
    console.error("Error: " + e.message);
    process.exit(1);
  }

  renderFileInfo(result);
  renderRiskSummary(result);
  renderParagraphList(result, true);
  renderRecommendations(result);
}

module.exports = {
  interactiveScan,
  noninteractiveScan,
  renderBanner,
  renderFilePromptUI,
  replPrompt,   // exported so bin/wordcheck.js uses the same definition
};

"use strict";

const chalk = require("chalk");

// ---------------------------------------------------------------------------
// Colors for diff
// ---------------------------------------------------------------------------
const C = {
  bgRed:    chalk.bgRed.white,
  bgGreen:  chalk.bgGreen.black,
  bgYellow: chalk.bgYellow.black,
  red:      chalk.hex("#FF5555"),
  green:    chalk.hex("#50FA7B"),
  dim:      chalk.hex("#6272A4"),
  white:    chalk.hex("#F8F8F2"),
  cyan:     chalk.hex("#8BE9FD"),
  pink:     chalk.hex("#FF79C6"),
  yellow:   chalk.hex("#F1FA8C"),
};

// ---------------------------------------------------------------------------
// Word-level diff using LCS
// ---------------------------------------------------------------------------
function wordDiff(oldText, newText) {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  const m = oldWords.length;
  const n = newWords.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldWords[i - 1] === newWords[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const oldSpans = [];
  const newSpans = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      oldSpans.unshift({ text: oldWords[i - 1], type: "same" });
      newSpans.unshift({ text: newWords[j - 1], type: "same" });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      newSpans.unshift({ text: newWords[j - 1], type: "added" });
      j--;
    } else {
      oldSpans.unshift({ text: oldWords[i - 1], type: "removed" });
      i--;
    }
  }

  return { oldSpans, newSpans };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function visibleLen(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, "").length;
}

function truncPad(text, width) {
  if (!text) return " ".repeat(width);
  const stripped = text.replace(/\x1B\[[0-9;]*m/g, "");
  if (stripped.length > width) return text.slice(0, width - 1) + "\u2026";
  return text + " ".repeat(Math.max(0, width - stripped.length));
}

function padTo(str, width) {
  const vis = visibleLen(str);
  if (vis >= width) return str;
  return str + " ".repeat(width - vis);
}

// ---------------------------------------------------------------------------
// Render word spans with color
// ---------------------------------------------------------------------------
function renderWordSpans(spans, side, width) {
  let result = "";
  let used = 0;

  for (const span of spans) {
    if (used >= width) break;
    const remaining = width - used;
    const text = span.text.slice(0, remaining);

    if (span.type === "same") {
      result += C.dim(text);
    } else if (span.type === "removed") {
      result += side === "old" ? C.bgRed(text) : C.red(text);
    } else if (span.type === "added") {
      result += side === "new" ? C.bgGreen(text) : C.green(text);
    }
    used += text.length;
  }

  return padTo(result, width);
}

// ---------------------------------------------------------------------------
// Side-by-side diff — VSCode style
// Shows ORIGINAL on left, MODIFIED on right with clear column separation
// ---------------------------------------------------------------------------
function renderSideBySideDiff(original, modified, options = {}) {
  const termWidth = options.width || Math.min(process.stdout.columns || 80, 100);
  const margin = "  ";
  const separator = " \u2502 ";
  const gutter = 4;
  const available = termWidth - margin.length * 2 - gutter * 2 - separator.length;
  const colWidth = Math.floor(available / 2);
  const lineLen = margin.length + gutter + colWidth + separator.length + gutter + colWidth;

  const origWords = original.replace(/\s+/g, " ").trim().split(" ");
  const modWords = modified.replace(/\s+/g, " ").trim().split(" ");

  // Simple word-level diff
  const wd = wordDiff(original, modified);

  const output = [];

  // Header
  output.push(
    margin +
    C.red.bold(truncPad("ORIGINAL", gutter + colWidth)) +
    C.dim(" \u2502 ") +
    C.green.bold(truncPad("MODIFIED", gutter + colWidth))
  );
  output.push(margin + C.dim("\u2500".repeat(lineLen - margin.length * 2)));

  // Build aligned lines from spans
  const oldLines = buildLines(wd.oldSpans, colWidth);
  const newLines = buildLines(wd.newSpans, colWidth);
  const maxLines = Math.max(oldLines.length, newLines.length);

  for (let idx = 0; idx < maxLines; idx++) {
    const oldLine = oldLines[idx] || { text: "", type: "same" };
    const newLine = newLines[idx] || { text: "", type: "same" };

    const num = String(idx + 1).padStart(gutter);
    let leftCell, rightCell;

    if (oldLine.type === "removed" && newLine.type === "added") {
      // Both changed
      leftCell = C.red(num + " ") + C.bgRed(truncPad(oldLine.text, colWidth - gutter));
      rightCell = C.green(num + " ") + C.bgGreen(truncPad(newLine.text, colWidth - gutter));
    } else if (oldLine.type === "removed") {
      leftCell = C.red(num + " ") + C.bgRed(truncPad(oldLine.text, colWidth - gutter));
      rightCell = C.dim(num + " ") + C.dim(" ".repeat(colWidth - gutter));
    } else if (newLine.type === "added") {
      leftCell = C.dim(num + " ") + C.dim(" ".repeat(colWidth - gutter));
      rightCell = C.green(num + " ") + C.bgGreen(truncPad(newLine.text, colWidth - gutter));
    } else {
      leftCell = C.dim(num + " ") + C.dim(truncPad(oldLine.text, colWidth - gutter));
      rightCell = C.dim(num + " ") + C.dim(truncPad(newLine.text, colWidth - gutter));
    }

    output.push(margin + leftCell + C.dim(" \u2502 ") + rightCell);
  }

  // Footer
  output.push(margin + C.dim("\u2500".repeat(lineLen - margin.length * 2)));

  // Stats
  const adds = wd.newSpans.filter(s => s.type === "added").length;
  const dels = wd.oldSpans.filter(s => s.type === "removed").length;
  output.push(
    margin +
    C.green("+ " + adds + " added") + "  " +
    C.red("- " + dels + " removed")
  );

  return output;
}

// Build display lines from spans, wrapping at colWidth
function buildLines(spans, colWidth) {
  const lines = [];
  let currentText = "";
  let currentType = "same";

  for (const span of spans) {
    const words = span.text.split(/(\s+)/);
    for (const w of words) {
      if ((currentText + w).length > colWidth && currentText.length > 0) {
        lines.push({ text: currentText.trim(), type: currentType });
        currentText = w;
        currentType = span.type;
      } else {
        currentText += w;
        if (span.type !== "same") currentType = span.type;
      }
    }
  }
  if (currentText.trim()) {
    lines.push({ text: currentText.trim(), type: currentType });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Inline diff — single column with +/- markers
// ---------------------------------------------------------------------------
function renderInlineDiff(original, modified, options = {}) {
  const termWidth = options.width || Math.min(process.stdout.columns || 80, 80);
  const colWidth = termWidth - 8;
  const margin = "  ";

  const wd = wordDiff(original, modified);
  const output = [];

  // Header
  output.push(margin + C.pink.bold("DIFF"));
  output.push(margin + C.dim("\u2500".repeat(termWidth - 6)));

  // Old (removed)
  const oldLines = buildLines(wd.oldSpans, colWidth);
  for (const line of oldLines) {
    if (line.type === "removed") {
      output.push(margin + C.red("  - ") + C.bgRed(truncPad(line.text, colWidth)));
    } else {
      output.push(margin + C.dim("    ") + C.dim(truncPad(line.text, colWidth)));
    }
  }

  // Separator
  output.push(margin + C.dim("  " + "\u2500".repeat(colWidth)));

  // New (added)
  const newLines = buildLines(wd.newSpans, colWidth);
  for (const line of newLines) {
    if (line.type === "added") {
      output.push(margin + C.green("  + ") + C.bgGreen(truncPad(line.text, colWidth)));
    } else {
      output.push(margin + C.dim("    ") + C.dim(truncPad(line.text, colWidth)));
    }
  }

  // Footer
  output.push(margin + C.dim("\u2500".repeat(termWidth - 6)));

  // Stats
  const adds = wd.newSpans.filter(s => s.type === "added").length;
  const dels = wd.oldSpans.filter(s => s.type === "removed").length;
  output.push(margin + C.green("+ " + adds) + "  " + C.red("- " + dels));

  return output;
}

module.exports = { renderSideBySideDiff, renderInlineDiff, wordDiff };

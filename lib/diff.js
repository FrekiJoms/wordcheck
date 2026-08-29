"use strict";

const chalk = require("chalk");

// ---------------------------------------------------------------------------
// Colors for diff
// ---------------------------------------------------------------------------
const C = {
  bgRed:    chalk.bgRed.white,
  bgGreen:  chalk.bgGreen.black,
  red:      chalk.hex("#FF5555"),
  green:    chalk.hex("#50FA7B"),
  dim:      chalk.hex("#6272A4"),
  white:    chalk.hex("#F8F8F2"),
  cyan:     chalk.hex("#8BE9FD"),
  pink:     chalk.hex("#FF79C6"),
  yellow:   chalk.hex("#F1FA8C"),
  bar:      chalk.hex("#BD93F9"),
};

// ---------------------------------------------------------------------------
// Word-level diff — finds changed spans within a line
// ---------------------------------------------------------------------------
function wordDiff(oldLine, newLine) {
  const oldWords = oldLine.split(/(\s+)/);
  const newWords = newLine.split(/(\s+)/);

  // LCS-based word diff
  const m = oldWords.length;
  const n = newWords.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find diff spans
  const oldSpans = []; // { text, type: 'same' | 'removed' }
  const newSpans = []; // { text, type: 'same' | 'added' }

  let i = m, j = n;
  const oldParts = [];
  const newParts = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      oldParts.unshift({ text: oldWords[i - 1], type: "same" });
      newParts.unshift({ text: newWords[j - 1], type: "same" });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      newParts.unshift({ text: newWords[j - 1], type: "added" });
      j--;
    } else {
      oldParts.unshift({ text: oldWords[i - 1], type: "removed" });
      i--;
    }
  }

  return { oldSpans: oldParts, newSpans: newParts };
}

// ---------------------------------------------------------------------------
// Render a single diff line — with word-level highlighting
// ---------------------------------------------------------------------------
function renderOldLine(text, width) {
  const pad = " ".repeat(Math.max(0, width - text.length));
  return C.red("  - ") + C.dim(text) + pad;
}

function renderNewLine(text, width) {
  const pad = " ".repeat(Math.max(0, width - text.length));
  return C.green("  + ") + C.white(text) + pad;
}

function renderSameLine(text, width) {
  const pad = " ".repeat(Math.max(0, width - text.length));
  return C.dim("    ") + C.dim(text) + pad;
}

function renderChangedOld(text, width) {
  const pad = " ".repeat(Math.max(0, width - text.length));
  return C.red("  ~ ") + C.bgRed(text) + pad;
}

function renderChangedNew(text, width) {
  const pad = " ".repeat(Math.max(0, width - text.length));
  return C.green("  ~ ") + C.bgGreen(text) + pad;
}

// ---------------------------------------------------------------------------
// Side-by-side diff — VSCode style
// Renders: [gutter] [left: original] [separator] [right: modified]
// ---------------------------------------------------------------------------
function renderSideBySideDiff(original, modified, options = {}) {
  const termWidth = options.width || Math.min(process.stdout.columns || 80, 120);
  const gutterWidth = 6; // line numbers
  const separatorWidth = 3; // " │ "
  const contentWidth = Math.floor((termWidth - gutterWidth * 2 - separatorWidth - 8) / 2);

  const origLines = wrapText(original, contentWidth);
  const modLines = wrapText(modified, contentWidth);

  // Compute line-level diff
  const diff = computeLineDiff(origLines, modLines);

  const output = [];

  // Header
  const headerPad = " ".repeat(Math.max(0, contentWidth - 8));
  output.push(
    C.dim("  ") +
    C.red.bold(" ORIGINAL".padEnd(contentWidth + gutterWidth)) +
    C.dim(" │ ") +
    C.green.bold(" MODIFIED".padEnd(contentWidth + gutterWidth))
  );
  output.push(C.dim("  " + "─".repeat(termWidth - 6)));

  // Diff lines
  for (const entry of diff) {
    const leftNum = entry.oldNum !== null ? String(entry.oldNum).padStart(3) : "   ";
    const rightNum = entry.newNum !== null ? String(entry.newNum).padStart(3) : "   ";

    if (entry.type === "same") {
      const left = C.dim(leftNum + " │ ") + C.dim(truncPad(entry.oldText, contentWidth));
      const right = C.dim(rightNum + " │ ") + C.dim(truncPad(entry.newText, contentWidth));
      output.push(C.dim("  ") + left + C.dim(" │ ") + right);
    } else if (entry.type === "removed") {
      const left = C.red(leftNum + " │ ") + C.bgRed(truncPad(entry.oldText, contentWidth));
      const right = C.dim("   " + " │ ") + C.dim(" ".repeat(contentWidth));
      output.push(C.dim("  ") + left + C.dim(" │ ") + right);
    } else if (entry.type === "added") {
      const left = C.dim("   " + " │ ") + C.dim(" ".repeat(contentWidth));
      const right = C.green(rightNum + " │ ") + C.bgGreen(truncPad(entry.newText, contentWidth));
      output.push(C.dim("  ") + left + C.dim(" │ ") + right);
    } else if (entry.type === "changed") {
      // Word-level diff for changed lines
      const wd = wordDiff(entry.oldText || "", entry.newText || "");
      const leftText = renderWordSpans(wd.oldSpans, "old", contentWidth);
      const rightText = renderWordSpans(wd.newSpans, "new", contentWidth);
      const left = C.yellow(leftNum + " │ ") + leftText;
      const right = C.yellow(rightNum + " │ ") + rightText;
      output.push(C.dim("  ") + left + C.dim(" │ ") + right);
    }
  }

  // Footer
  output.push(C.dim("  " + "─".repeat(termWidth - 6)));

  // Stats
  const adds = diff.filter((d) => d.type === "added").length;
  const dels = diff.filter((d) => d.type === "removed").length;
  const changes = diff.filter((d) => d.type === "changed").length;
  output.push(
    C.dim("  ") +
    C.green(`+${adds} added`) + C.dim("  ") +
    C.red(`-${dels} removed`) + C.dim("  ") +
    C.yellow(`~${changes} modified`)
  );

  return output;
}

// ---------------------------------------------------------------------------
// Inline diff — single column, shows changes with highlights
// ---------------------------------------------------------------------------
function renderInlineDiff(original, modified, options = {}) {
  const termWidth = options.width || Math.min(process.stdout.columns || 80, 100);
  const contentWidth = termWidth - 10;

  const origLines = wrapText(original, contentWidth);
  const modLines = wrapText(modified, contentWidth);
  const diff = computeLineDiff(origLines, modLines);

  const output = [];

  output.push(C.dim("  " + "─".repeat(termWidth - 6)));
  output.push(C.pink.bold("  diff"));
  output.push(C.dim("  " + "─".repeat(termWidth - 6)));

  for (const entry of diff) {
    if (entry.type === "same") {
      output.push(C.dim("    " + truncPad(entry.oldText, contentWidth)));
    } else if (entry.type === "removed") {
      output.push(C.red("  - " + truncPad(entry.oldText, contentWidth)));
    } else if (entry.type === "added") {
      output.push(C.green("  + " + truncPad(entry.newText, contentWidth)));
    } else if (entry.type === "changed") {
      const wd = wordDiff(entry.oldText || "", entry.newText || "");
      output.push(C.yellow("  ~ ") + renderWordSpans(wd.oldSpans, "old", contentWidth));
      output.push(C.yellow("  ~ ") + renderWordSpans(wd.newSpans, "new", contentWidth));
    }
  }

  output.push(C.dim("  " + "─".repeat(termWidth - 6)));

  const adds = diff.filter((d) => d.type === "added").length;
  const dels = diff.filter((d) => d.type === "removed").length;
  const changes = diff.filter((d) => d.type === "changed").length;
  output.push(
    C.dim("  ") +
    C.green(`+${adds}`) + C.dim(" ") +
    C.red(`-${dels}`) + C.dim(" ") +
    C.yellow(`~${changes}`)
  );

  return output;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap text to fit within a given width */
function wrapText(text, width) {
  if (!text) return [""];
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    if ((line + " " + word).trim().length > width && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.length > 0 ? lines : [""];
}

/** Truncate and pad a string to exact width */
function truncPad(text, width) {
  if (!text) return " ".repeat(width);
  const stripped = text.replace(/\x1B\[[0-9;]*m/g, "");
  if (stripped.length > width) return text.slice(0, width - 1) + "…";
  const pad = width - stripped.length;
  return text + " ".repeat(Math.max(0, pad));
}

/** Render word spans with color */
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

  // Pad to width
  const stripped = result.replace(/\x1B\[[0-9;]*m/g, "");
  if (stripped.length < width) {
    result += " ".repeat(width - stripped.length);
  }

  return result;
}

/** Compute line-level diff using LCS */
function computeLineDiff(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result = [];
  let i = m, j = n;
  let oldNum = m, newNum = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({
        type: "same",
        oldText: oldLines[i - 1],
        newText: newLines[j - 1],
        oldNum: i,
        newNum: j,
      });
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i - 1][j - 1] + 1 >= Math.max(dp[i - 1][j], dp[i][j - 1])) {
      // Changed (similar lines)
      result.unshift({
        type: "changed",
        oldText: oldLines[i - 1],
        newText: newLines[j - 1],
        oldNum: i,
        newNum: j,
      });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({
        type: "added",
        oldText: null,
        newText: newLines[j - 1],
        oldNum: null,
        newNum: j,
      });
      j--;
    } else {
      result.unshift({
        type: "removed",
        oldText: oldLines[i - 1],
        newText: null,
        oldNum: i,
        newNum: null,
      });
      i--;
    }
  }

  return result;
}

module.exports = { renderSideBySideDiff, renderInlineDiff, wordDiff };

"use strict";

// ---------------------------------------------------------------------------
// Table renderer — proper Unicode box-drawing with ANSI-safe padding
// ---------------------------------------------------------------------------

// Box-drawing chars
const BOX = {
  tl: "\u250C", // ┌
  tr: "\u2510", // ┐
  bl: "\u2514", // └
  br: "\u2518", // ┘
  h:  "\u2500", // ─
  v:  "\u2502", // │
  lt: "\u251C", // ├
  rt: "\u2524", // ┤
  tt: "\u252C", // ┬
  bt: "\u2534", // ┴
  cr: "\u253C", // ┼
  dv: "\u2502", // │ (double)
  dh: "\u2550", // ═
  dtl: "\u2554", // ╔
  dtr: "\u2557", // ╗
  dbl: "\u255A", // ╚
  dbr: "\u255D", // ╝
  dlt: "\u2560", // ╠
  drt: "\u2563", // ╣
  dtt: "\u2566", // ╦
  dbt: "\u2569", // ╩
  dcr: "\u256C", // ╬
};

const ANSI_PATTERN = /\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]/g;

/** Strip terminal control sequences before measuring text. */
function stripAnsi(str) {
  return String(str ?? "").replace(ANSI_PATTERN, "");
}

/** Strip ANSI escape codes to get visible length. */
function visibleLen(str) {
  return stripAnsi(str).replace(/[\r\n]/g, " ").length;
}

/** Truncate styled text without allowing it to exceed a terminal row. */
function truncateVisible(str, width) {
  const plain = stripAnsi(str).replace(/[\r\n]/g, " ");
  if (width <= 0) return "";
  if (plain.length <= width) return str;
  return plain.slice(0, Math.max(0, width - 1)) + "\u2026";
}

/** Keep a cell on one terminal row. */
function oneLine(str) {
  return String(str ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Strip HTML tags from text */
function stripHtml(text) {
  if (!text) return "";
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pad or truncate string to exact visible width (ANSI-safe) */
function padVisible(str, width) {
  str = oneLine(str);
  if (width <= 0) return "";
  const vis = visibleLen(str);
  if (vis === width) return str;
  if (vis > width) {
    return truncateVisible(str, width);
  }
  return str + " ".repeat(width - vis);
}

/**
 * Render a styled table with proper Unicode box-drawing.
 * Column widths auto-adjust to fit content if not specified.
 *
 * @param {object} opts
 * @param {Array<string>} opts.headers - Column header labels
 * @param {Array<number>} [opts.widths] - Column widths (auto-calculated if omitted)
 * @param {Array<Array<string>>} opts.rows - Row data (each cell can include ANSI colors)
 * @param {number} [opts.maxWidth] - Max total table width (default: terminal width - 4)
 * @param {function} [opts.headerStyle] - Chalk function for header text
 * @param {function} [opts.dimStyle] - Chalk function for borders
 * @param {string} [opts.margin] - Left margin (default "  ")
 * @returns {Array<string>} Lines of rendered table
 */
function renderTable(opts) {
  const {
    headers,
    widths: explicitWidths,
    rows,
    maxWidth,
    headerStyle = (s) => s,
    dimStyle = (s) => s,
    margin = "  ",
  } = opts;

  const lines = [];
  const D = dimStyle;
  const safeHeaders = (headers || []).map(oneLine);
  const numCols = safeHeaders.length;
  const safeRows = (rows || []).map((row) =>
    safeHeaders.map((_, i) => oneLine(row?.[i] ?? ""))
  );

  if (numCols === 0) return [];

  // Auto-calculate column widths from content
  let widths;
  if (explicitWidths) {
    widths = [...explicitWidths];
  } else {
    widths = safeHeaders.map((h, i) => {
      const headerLen = visibleLen(h);
      let maxLen = headerLen;
      for (const row of safeRows) {
        if (row[i]) {
          const cellLen = visibleLen(row[i]);
          if (cellLen > maxLen) maxLen = cellLen;
        }
      }
      return Math.max(3, maxLen);
    });
  }

  // Enforce max width. A table row uses sum(widths) + 3*n + 1 columns.
  const maxW = maxWidth || process.stdout.columns || 80;
  const available = Math.max(numCols * 3, maxW - margin.length - numCols * 3 - 1);
  let excess = widths.reduce((sum, width) => sum + width, 0) - available;
  while (excess > 0) {
    const index = widths.reduce((best, width, i) => width > widths[best] ? i : best, 0);
    if (widths[index] <= 3) break;
    widths[index]--;
    excess--;
  }

  // Top border
  lines.push(margin + D(BOX.tl + widths.map((w) => BOX.h.repeat(w + 2)).join(BOX.tt) + BOX.tr));

  // Header row
  const headerCells = safeHeaders.map((h, i) => padVisible(headerStyle(h), widths[i]));
  lines.push(margin + D(BOX.v + " ") + headerCells.join(D(" " + BOX.v + " ")) + D(" " + BOX.v));

  // Header separator
  lines.push(margin + D(BOX.lt + widths.map((w) => BOX.h.repeat(w + 2)).join(BOX.cr) + BOX.rt));

  // Data rows
  for (const row of safeRows) {
    const cells = safeHeaders.map((_, i) => padVisible(row[i], widths[i]));
    lines.push(margin + D(BOX.v + " ") + cells.join(D(" " + BOX.v + " ")) + D(" " + BOX.v));
  }

  // Bottom border
  lines.push(margin + D(BOX.bl + widths.map((w) => BOX.h.repeat(w + 2)).join(BOX.bt) + BOX.br));

  return lines;
}

/**
 * Render a panel (single-column box with content lines).
 */
function renderPanel(opts) {
  const {
    title,
    lines: contentLines,
    width,
    titleStyle = (s) => s,
    dimStyle = (s) => s,
    margin = "  ",
  } = opts;

  const D = dimStyle;
  const safeLines = (contentLines || []).map(oneLine);
  const requested = width || Math.max(0, ...safeLines.map((l) => visibleLen(l))) + 4;
  const w = Math.max(4, Math.min(requested, (process.stdout.columns || requested) - margin.length - 2));
  const result = [];

  // Top
  result.push(margin + D(BOX.tl + BOX.h.repeat(w) + BOX.tr));

  // Title
  if (title) {
    result.push(margin + D(BOX.v + " ") + padVisible(titleStyle(title), w - 2) + D(" " + BOX.v));
    result.push(margin + D(BOX.lt + BOX.h.repeat(w) + BOX.rt));
  }

  // Content
  for (const line of safeLines) {
    result.push(margin + D(BOX.v + " ") + padVisible(line, w - 2) + D(" " + BOX.v));
  }

  // Bottom
  result.push(margin + D(BOX.bl + BOX.h.repeat(w) + BOX.br));

  return result;
}

module.exports = { renderTable, renderPanel, BOX, visibleLen, truncateVisible, padVisible, stripAnsi, stripHtml };

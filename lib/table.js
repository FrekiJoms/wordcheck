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

/** Strip ANSI escape codes to get visible length */
function visibleLen(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, "").length;
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
  const vis = visibleLen(str);
  if (vis === width) return str;
  if (vis > width) {
    // Truncate — strip ANSI, cut, re-wrap is too complex, just slice the raw string
    const stripped = str.replace(/\x1B\[[0-9;]*m/g, "");
    if (stripped.length <= width) return str;
    return stripped.slice(0, width - 1) + "\u2026";
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
  const numCols = headers.length;

  // Auto-calculate column widths from content
  let widths;
  if (explicitWidths) {
    widths = [...explicitWidths];
  } else {
    widths = headers.map((h, i) => {
      const headerLen = visibleLen(headerStyle(h));
      let maxLen = headerLen;
      for (const row of rows) {
        if (row[i]) {
          const cellLen = visibleLen(row[i]);
          if (cellLen > maxLen) maxLen = cellLen;
        }
      }
      return Math.max(3, maxLen);
    });
  }

  // Enforce max width by truncating widest columns first
  const totalWidth = widths.reduce((s, w) => s + w, 0) + numCols * 3 + 2;
  const maxW = maxWidth || (process.stdout.columns || 80) - margin.length;
  if (totalWidth > maxW) {
    const excess = totalWidth - maxW;
    // Reduce widest columns proportionally
    const sorted = widths.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
    let remaining = excess;
    for (const { w, i } of sorted) {
      if (remaining <= 0) break;
      const reduce = Math.min(remaining, Math.max(0, w - 6));
      widths[i] -= reduce;
      remaining -= reduce;
    }
  }

  // Top border
  lines.push(margin + D(BOX.tl + widths.map((w) => BOX.h.repeat(w + 2)).join(BOX.tt) + BOX.tr));

  // Header row
  const headerCells = headers.map((h, i) => padVisible(headerStyle(h), widths[i]));
  lines.push(margin + D(BOX.v + " ") + headerCells.join(D(" " + BOX.v + " ")) + D(" " + BOX.v));

  // Header separator
  lines.push(margin + D(BOX.lt + widths.map((w) => BOX.h.repeat(w + 2)).join(BOX.cr) + BOX.rt));

  // Data rows
  for (const row of rows) {
    const cells = row.map((cell, i) => padVisible(cell, widths[i]));
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
  const w = width || Math.max(...contentLines.map((l) => visibleLen(l))) + 4;
  const result = [];

  // Top
  result.push(margin + D(BOX.tl + BOX.h.repeat(w) + BOX.tr));

  // Title
  if (title) {
    result.push(margin + D(BOX.v + " ") + padVisible(titleStyle(title), w - 2) + D(" " + BOX.v));
    result.push(margin + D(BOX.lt + BOX.h.repeat(w) + BOX.rt));
  }

  // Content
  for (const line of contentLines) {
    result.push(margin + D(BOX.v + " ") + padVisible(line, w - 2) + D(" " + BOX.v));
  }

  // Bottom
  result.push(margin + D(BOX.bl + BOX.h.repeat(w) + BOX.br));

  return result;
}

module.exports = { renderTable, renderPanel, BOX, visibleLen, padVisible, stripHtml };

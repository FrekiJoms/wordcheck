"use strict";

const C = require("./colors");

/**
 * Render a compact severity distribution bar for the fixed header.
 * The bar is sized from the available terminal width and never wraps.
 */
function renderSeverityBar(summary, maxWidth = 80) {
  const high = summary.bySeverity?.HIGH || 0;
  const medium = summary.bySeverity?.MEDIUM || 0;
  const low = summary.bySeverity?.LOW || 0;
  const total = high + medium + low;

  if (total === 0) return C.dim("risk none");

  const labels = ` H:${high} M:${medium} L:${low}`;
  const barWidth = Math.max(12, Math.min(42, maxWidth - labels.length - 9));
  const counts = [high, medium, low];
  const widths = allocateSegments(counts, total, barWidth);
  const bar = [
    C.red("█".repeat(widths[0])),
    C.yellow("█".repeat(widths[1])),
    C.green("█".repeat(widths[2])),
  ].join("");

  return C.dim("risk ") + bar + C.dim(labels);
}

function allocateSegments(counts, total, width) {
  const result = counts.map((count) => count > 0 ? Math.max(1, Math.floor((count / total) * width)) : 0);
  let used = result.reduce((sum, value) => sum + value, 0);

  while (used > width) {
    const index = result.findIndex((value, i) => value > 1 && counts[i] > 0);
    if (index === -1) break;
    result[index]--;
    used--;
  }

  while (used < width) {
    const index = counts.indexOf(Math.max(...counts));
    result[index]++;
    used++;
  }

  return result;
}

module.exports = { renderSeverityBar };

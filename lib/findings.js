"use strict";

// ---------------------------------------------------------------------------
// Finding model — single source of truth for all document findings
// ---------------------------------------------------------------------------

/** Finding status lifecycle: NEW → REVIEWED → APPROVED → FIXED/FAILED → VERIFIED */
const FindingStatus = Object.freeze({
  NEW: "NEW",
  REVIEWED: "REVIEWED",
  APPROVED: "APPROVED",
  SKIPPED: "SKIPPED",
  FIXED: "FIXED",
  FAILED: "FAILED",
  VERIFIED: "VERIFIED",
});

/** Finding categories */
const FindingCategory = Object.freeze({
  AI_PHRASE: "ai_phrase",
  SENTENCE_STARTER: "sentence_starter",
  UNIFORMITY: "uniformity",
  LENGTH: "length",
  CITATION: "citation",
  EM_DASH: "em_dash",
  CONTRACTION: "contraction",
  STYLE: "style",
  GRAMMAR: "grammar",
  FORMAT: "format",
});

/** Severity levels */
const Severity = Object.freeze({
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

let _findingId = 0;

/**
 * Create a structured finding.
 *
 * @param {object} opts
 * @param {string} opts.category - FindingCategory value
 * @param {string} opts.severity - Severity value
 * @param {string} opts.title - Short human-readable title
 * @param {string} opts.description - Longer description
 * @param {string} opts.evidence - The flagged text snippet
 * @param {number} opts.paragraphIndex - Document paragraph index
 * @param {string} opts.originalContent - Original paragraph text
 * @param {string} [opts.suggestedFix] - Suggested replacement text
 * @param {number} [opts.confidence] - 0-100 confidence score
 * @param {boolean} [opts.fixable] - Whether this can be auto-fixed
 * @returns {object} Finding
 */
function createFinding(opts) {
  _findingId++;
  return {
    id: `F-${String(_findingId).padStart(4, "0")}`,
    category: opts.category,
    severity: opts.severity || Severity.LOW,
    title: opts.title,
    description: opts.description || "",
    evidence: opts.evidence || "",
    paragraphIndex: opts.paragraphIndex,
    originalContent: opts.originalContent || "",
    suggestedFix: opts.suggestedFix || null,
    confidence: opts.confidence ?? 50,
    fixable: opts.fixable ?? false,
    status: FindingStatus.NEW,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fixHistory: [],
  };
}

/**
 * Transition a finding to a new status.
 * Validates the transition is legal.
 */
function transitionFinding(finding, newStatus, meta = {}) {
  const validTransitions = {
    [FindingStatus.NEW]: [FindingStatus.REVIEWED, FindingStatus.APPROVED, FindingStatus.SKIPPED],
    [FindingStatus.REVIEWED]: [FindingStatus.APPROVED, FindingStatus.SKIPPED],
    [FindingStatus.APPROVED]: [FindingStatus.FIXED, FindingStatus.FAILED, FindingStatus.SKIPPED],
    [FindingStatus.SKIPPED]: [FindingStatus.REVIEWED],
    [FindingStatus.FIXED]: [FindingStatus.VERIFIED, FindingStatus.FAILED],
    [FindingStatus.FAILED]: [FindingStatus.APPROVED, FindingStatus.SKIPPED],
    [FindingStatus.VERIFIED]: [],
  };

  const allowed = validTransitions[finding.status] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid transition: ${finding.status} → ${newStatus}. ` +
      `Allowed: ${allowed.join(", ") || "none"}`
    );
  }

  finding.status = newStatus;
  finding.updatedAt = Date.now();
  if (meta.note) {
    finding.fixHistory.push({
      from: finding.status,
      to: newStatus,
      note: meta.note,
      timestamp: Date.now(),
    });
  }
  return finding;
}

/**
 * Convert scanner paragraph flags into structured findings.
 */
function flagsToFindings(para) {
  const findings = [];

  for (const flag of para.flags) {
    let category = FindingCategory.STYLE;
    let fixable = false;
    let suggestedFix = null;

    if (flag.category === "phrase") {
      category = FindingCategory.AI_PHRASE;
      fixable = true;
      // Extract the phrase from the flag text: '"phrase" x2'
      const match = flag.text.match(/^"([^"]+)"/);
      if (match) {
        suggestedFix = `Replace "${match[1]}" with a natural alternative`;
      }
    } else if (flag.category === "starter") {
      category = FindingCategory.SENTENCE_STARTER;
      fixable = true;
      suggestedFix = "Vary sentence starters";
    } else if (flag.category === "uniformity") {
      category = FindingCategory.UNIFORMITY;
      fixable = false;
    } else if (flag.category === "length") {
      category = FindingCategory.LENGTH;
      fixable = true;
      suggestedFix = "Break into shorter paragraphs";
    } else if (flag.category === "citation") {
      category = FindingCategory.CITATION;
      fixable = false;
    } else if (flag.category === "dash") {
      category = FindingCategory.EM_DASH;
      fixable = true;
      suggestedFix = "Replace em-dashes with commas or parentheses";
    } else if (flag.category === "contraction") {
      category = FindingCategory.CONTRACTION;
      fixable = true;
      suggestedFix = "Add contractions for a natural tone";
    }

    findings.push(createFinding({
      category,
      severity: flag.weight >= 10 ? Severity.HIGH : flag.weight >= 5 ? Severity.MEDIUM : Severity.LOW,
      title: flag.text,
      description: `Found in paragraph ${para.index}: ${flag.text}`,
      evidence: para.text.slice(0, 200),
      paragraphIndex: para.index,
      originalContent: para.text,
      suggestedFix,
      confidence: Math.min(95, 40 + flag.weight * 5),
      fixable,
    }));
  }

  return findings;
}

/**
 * Build findings from a scan result.
 */
function buildFindings(scanResult) {
  const findings = [];
  for (const para of scanResult.paragraphs) {
    if (para.level === "SKIP") continue;
    findings.push(...flagsToFindings(para));
  }
  return findings;
}

/**
 * Get summary statistics from findings.
 */
function summarizeFindings(findings) {
  const total = findings.length;
  const byStatus = {};
  const bySeverity = {};
  const byCategory = {};
  for (const s of Object.values(FindingStatus)) byStatus[s] = 0;
  for (const s of Object.values(Severity)) bySeverity[s] = 0;
  for (const c of Object.values(FindingCategory)) byCategory[c] = 0;

  for (const f of findings) {
    byStatus[f.status]++;
    bySeverity[f.severity]++;
    byCategory[f.category]++;
  }

  const fixable = findings.filter((f) => f.fixable).length;
  const approved = findings.filter((f) => f.status === FindingStatus.APPROVED).length;
  const fixed = findings.filter((f) => f.status === FindingStatus.FIXED).length;
  const failed = findings.filter((f) => f.status === FindingStatus.FAILED).length;

  return { total, byStatus, bySeverity, byCategory, fixable, approved, fixed, failed };
}

module.exports = {
  FindingStatus,
  FindingCategory,
  Severity,
  createFinding,
  transitionFinding,
  flagsToFindings,
  buildFindings,
  summarizeFindings,
};

"use strict";

// ---------------------------------------------------------------------------
// AI integration — pluggable analysis engine
// Priority: local heuristics (always available), optional API connection
// ---------------------------------------------------------------------------

const { FindingCategory, Severity } = require("./findings");

/**
 * Generate AI-powered analysis for a finding.
 * Uses built-in heuristics; returns a structured recommendation.
 *
 * @param {object} finding - A Finding object
 * @param {object} context - { paragraph, scanResult }
 * @returns {object} { analysis, recommendation, confidence }
 */
function analyzeFinding(finding, context = {}) {
  const para = context.paragraph || {};
  const text = finding.originalContent || "";

  switch (finding.category) {
    case FindingCategory.AI_PHRASE:
      return analyzeAiPhrase(finding, text);
    case FindingCategory.SENTENCE_STARTER:
      return analyzeSentenceStarter(finding, text, para);
    case FindingCategory.UNIFORMITY:
      return analyzeUniformity(finding, text, para);
    case FindingCategory.LENGTH:
      return analyzeLength(finding, text);
    case FindingCategory.EM_DASH:
      return analyzeEmDash(finding, text);
    case FindingCategory.CONTRACTION:
      return analyzeContraction(finding, text);
    case FindingCategory.CITATION:
      return analyzeCitation(finding, text, para);
    default:
      return {
        analysis: finding.description,
        recommendation: finding.suggestedFix || "Manual review recommended",
        confidence: finding.confidence,
      };
  }
}

function analyzeAiPhrase(finding, text) {
  const match = finding.title.match(/^"([^"]+)"/);
  const phrase = match ? match[1] : "";

  const replacements = {
    "present study": ["this research", "the current work", "this project"],
    "the present study": ["this research", "the current work"],
    "this study": ["this research", "the current work"],
    "moreover": ["also", "besides", "on top of that"],
    "furthermore": ["also", "in addition", "besides"],
    "consequently": ["so", "as a result", "because of that"],
    "facilitates": ["helps", "makes easier", "enables"],
    "enhances": ["improves", "boosts", "strengthens"],
    "underpins": ["supports", "holds up", "forms the basis of"],
    "integral": ["essential", "key", "important"],
    "pivotal": ["important", "key", "central"],
    "according to": ["as noted by", "per", "following"],
    "in terms of": ["in regard to", "regarding", "about"],
    "significantly": ["greatly", "noticeably", "clearly"],
    "importantly": ["notably", "worth mentioning"],
    "essentially": ["basically", "in essence", "pretty much"],
    "fundamentally": ["basically", "at its core"],
    "comprehensive": ["thorough", "complete", "detailed"],
    "crucial": ["important", "key", "vital"],
    "it is important": ["it matters", "it's key"],
  };

  const options = replacements[phrase] || [];
  const suggestion = options.length > 0
    ? `Replace "${phrase}" with one of: ${options.map((o) => `"${o}"`).join(", ")}`
    : `Replace "${phrase}" with a more natural, conversational alternative`;

  return {
    analysis: `The phrase "${phrase}" is a common AI tell. It appears formal and formulaic, which makes writing feel generated rather than naturally written.`,
    recommendation: suggestion,
    confidence: Math.min(95, finding.confidence + 10),
  };
}

function analyzeSentenceStarter(finding, text, para) {
  const match = finding.title.match(/starter "([^"]+)"/);
  const word = match ? match[1] : "unknown";
  const sentences = (para.sentences || []);
  const count = sentences.filter((s) => s.split(/\s+/)[0] === word).length;

  return {
    analysis: `The word "${word}" starts ${count} sentences in this paragraph. Repetitive sentence openings are a hallmark of AI-generated text, which tends to follow predictable patterns.`,
    recommendation: `Vary your sentence starters. Try opening some sentences with: a prepositional phrase, a participial phrase, a conjunction, or a dependent clause instead of "${word}".`,
    confidence: Math.min(90, 50 + count * 10),
  };
}

function analyzeUniformity(finding, text, para) {
  const sentences = para.sentences || [];
  const lens = sentences.map((s) => s.split(/\s+/).length);
  const avg = lens.length > 0 ? (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(0) : 0;

  return {
    analysis: `All ${sentences.length} sentences have similar length (~${avg} words each). Human writing naturally varies between short punchy sentences and longer complex ones. Uniform sentence length is a strong AI indicator.`,
    recommendation: `Mix short sentences (5-8 words) with longer ones (15-25 words). Break the pattern. Start a sentence with "But" or "And" — it's natural and breaks uniformity.`,
    confidence: Math.min(85, 60 + sentences.length * 3),
  };
}

function analyzeLength(finding, text) {
  const words = text.split(/\s+/).length;
  return {
    analysis: `This paragraph is ${words} words long. Overly long paragraphs are common in AI output, which tends to pack information densely rather than breaking it into readable chunks.`,
    recommendation: `Break this into 2-3 shorter paragraphs. Each paragraph should focus on one main idea. Aim for 50-100 words per paragraph for academic writing.`,
    confidence: 70,
  };
}

function analyzeEmDash(finding, text) {
  const count = (text.match(/\u2014/g) || []).length;
  return {
    analysis: `Found ${count} em-dash${count > 1 ? "es" : ""} in this paragraph. Em-dashes are disproportionately common in AI-generated text — LLMs overuse them as a punctuation crutch.`,
    recommendation: `Replace em-dashes with: commas (for parenthetical asides), parentheses (for clarifications), or periods (to split into shorter sentences).`,
    confidence: 75,
  };
}

function analyzeContraction(finding, text) {
  return {
    analysis: `This paragraph has no contractions despite being ${text.split(/\s+/).length} words. Human writers naturally use contractions (don't, it's, can't). Their absence signals overly formal, AI-like prose.`,
    recommendation: `Add 2-3 contractions: "don't" instead of "do not", "it's" instead of "it is", "can't" instead of "cannot". This immediately makes the text sound more natural.`,
    confidence: 65,
  };
}

function analyzeCitation(finding, text, para) {
  const cites = para.citationCount || 0;
  return {
    analysis: `Found ${cites} citations in just ${para.sentenceCount || "?"} sentences. This creates a dense, list-like feel rather than flowing analytical prose.`,
    recommendation: `Spread citations across more sentences. Use narrative citations ("Smith (2020) argues...") instead of parenthetical ones to improve readability.`,
    confidence: 60,
  };
}

/**
 * Generate a natural-language rewrite suggestion for a paragraph.
 * Uses heuristics; for full AI rewrite, connect to an API.
 */
function suggestRewrite(paragraphText, findings) {
  let rewritten = paragraphText;

  // Apply phrase replacements
  const phraseReplacements = {
    "the present study": "this research",
    "present study": "this research",
    "moreover": "also",
    "furthermore": "in addition",
    "consequently": "so",
    "facilitates": "helps",
    "enhances": "improves",
    "underpins": "supports",
    "integral": "essential",
    "pivotal": "key",
    "according to": "as noted by",
    "in terms of": "regarding",
    "significantly": "greatly",
    "importantly": "notably",
    "essentially": "basically",
    "fundamentally": "at its core",
    "comprehensive": "thorough",
    "crucial": "important",
    "it is important": "it matters",
  };

  for (const [from, to] of Object.entries(phraseReplacements)) {
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    rewritten = rewritten.replace(re, to);
  }

  // Replace em-dashes
  rewritten = rewritten.replace(/\u2014/g, ", ");

  return {
    original: paragraphText,
    rewritten,
    changed: rewritten !== paragraphText,
    note: "Heuristic rewrite — review before applying. For AI-powered rewrite, connect an AI API.",
  };
}

module.exports = { analyzeFinding, suggestRewrite };

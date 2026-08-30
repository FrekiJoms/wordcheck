"use strict";

// ---------------------------------------------------------------------------
// AI phrase dictionary — weights calibrated for academic writing context
// Only phrases that are genuinely AI-typical are included.
// ---------------------------------------------------------------------------
const AI_PHRASES = {
  // High confidence AI tells (weight 3) — rarely used naturally
  "the present study": 3, "present study": 3,
  "moreover": 3, "furthermore": 3, "consequently": 3,
  "facilitates": 3, "enhances": 3, "underpins": 3,
  "integral": 3, "pivotal": 3, "unquestionably": 3,

  // Medium confidence (weight 2) — sometimes AI-typical
  "in terms of": 2, "it is important to note": 2,
  "essentially": 2, "fundamentally": 2, "comprehensive": 2,
  "crucial": 2, "one of the most": 2, "among the first": 2,

  // Low confidence (weight 1) — mild AI signals
  "this study": 1, "this finding": 1, "this trend": 1,
  "in simple terms": 1, "in simpler terms": 1,
  "to sum up": 1, "taken together": 1,

  // REMOVED (legitimate academic phrases, not AI tells):
  // "this chapter", "related literature", "the literature",
  // "according to", "significantly", "importantly", "notably",
  // "because of this", "because of these", "it matters",
  // "this idea", "one of the",
};

// Pre-compile regexes at module load
const AI_PHRASE_REGEXES = Object.fromEntries(
  Object.entries(AI_PHRASES).map(([phrase, weight]) => [
    phrase,
    { weight, re: new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") },
  ])
);

// ---------------------------------------------------------------------------
// Replacement suggestions
// ---------------------------------------------------------------------------
const REPLACEMENTS = {
  "the present study": ["this research", "the current work"],
  "present study": ["this research", "the current work", "this project"],
  "this study": ["this research", "the current work"],
  "according to": ["as noted by", "per", "following"],
  "in terms of": ["in regard to", "regarding", "about"],
  "moreover": ["also", "besides", "on top of that"],
  "furthermore": ["also", "in addition", "besides"],
  "consequently": ["so", "as a result", "because of that"],
  "significantly": ["greatly", "noticeably", "clearly"],
  "importantly": ["notably", "worth mentioning"],
  "essentially": ["basically", "in essence", "pretty much"],
  "fundamentally": ["basically", "at its core"],
  "comprehensive": ["thorough", "complete", "detailed"],
  "facilitates": ["helps", "makes easier", "enables"],
  "enhances": ["improves", "boosts", "strengthens"],
  "underpins": ["supports", "holds up", "forms the basis of"],
  "crucial": ["important", "key", "vital"],
  "integral": ["essential", "key", "important"],
  "pivotal": ["important", "key", "central"],
  "this chapter": ["here", "in this section"],
  "related literature": ["prior studies", "existing research"],
  "the literature": ["prior work", "existing studies"],
  "in simple terms": ["basically", "essentially"],
  "in simpler terms": ["basically", "put simply"],
  "because of this": ["because of that", "for this reason"],
  "because of these": ["for these reasons", "because of that"],
  "to sum up": ["overall", "basically"],
  "taken together": ["combined", "overall", "looking at everything"],
  "it is important": ["it matters", "it's key"],
  "it matters": ["it's important", "it's relevant"],
  "one of the": ["a key", "an important"],
  "among the first": ["one of the early"],
  "this finding": ["this result", "this outcome"],
  "this trend": ["this pattern", "this direction"],
  "this idea": ["this concept", "this point"],
};

// Contraction list for detection
const CONTRACTIONS = [
  "n't", "'re", "'ve", "it's", "don't", "doesn't", "can't", "isn't",
  "they're", "we're", "that's", "there's", "won't", "haven't", "hasn't",
  "wouldn't", "couldn't", "shouldn't", "let's", "who's", "what's",
];

// Sentence starters that are LEGITIMATE in academic writing — not AI tells
const LEGITIMATE_STARTERS = new Set([
  "the", "a", "an", "in", "on", "at", "for", "with", "by", "from",
  "to", "of", "and", "but", "or", "nor", "so", "yet", "both",
  "since", "while", "although", "because", "if", "when", "where",
  "after", "before", "until", "unless", "whether", "as",
  "one", "two", "some", "many", "most", "all", "each", "every",
  "this", "that", "these", "those",
  "he", "she", "it", "they", "we", "you", "i",
  "his", "her", "its", "their", "our", "your",
  "however", "thus", "therefore", "also", "furthermore", "moreover",
  "according", "based", "given", "despite", "although",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function splitSentences(text) {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
}

function mostCommon(arr) {
  const freq = {};
  for (const item of arr) freq[item] = (freq[item] || 0) + 1;
  let best = null;
  for (const [val, count] of Object.entries(freq)) {
    if (!best || count > best[1]) best = [val, count];
  }
  return best;
}

function stdDev(arr) {
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - avg) ** 2, 0) / arr.length);
}

// ---------------------------------------------------------------------------
// Core scoring — tuned for academic writing
// ---------------------------------------------------------------------------
function scoreParagraph(text, idx) {
  if (text.trim().length < 50) {
    return {
      index: idx, text, score: 0, level: "SKIP", flags: [],
      sentences: [], wordCount: 0, sentenceCount: 0,
      citationCount: 0, hasContractions: false, emDashCount: 0,
    };
  }

  const lower = text.toLowerCase();
  let score = 0;
  const flags = [];

  // 1. AI phrase matching — deduplicate overlapping phrases
  // Sort by length descending so longer phrases consume their spans first
  const sortedPhrases = Object.entries(AI_PHRASE_REGEXES).sort((a, b) => b[0].length - a[0].length);
  let working = lower;
  for (const [phrase, { weight }] of sortedPhrases) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(esc, "gi");
    const matches = [...working.matchAll(re)];
    const count = matches.length;
    if (count > 0) {
      const effectiveScore = weight + (count - 1) * Math.max(1, Math.floor(weight / 2));
      score += effectiveScore;
      flags.push({ text: `"${phrase}" x${count}`, weight: effectiveScore, category: "phrase" });
      // Blank out matched spans so shorter substrings don't double-count
      for (const m of matches) {
        const start = m.index;
        const end = start + m[0].length;
        working = working.slice(0, start) + " ".repeat(m[0].length) + working.slice(end);
      }
    }
  }

  // 2. Sentence analysis
  const sentences = splitSentences(text);
  if (sentences.length > 0) {
    const starters = sentences.map((s) => s.split(/\s+/)[0].toLowerCase()).filter(Boolean);
    const mc = mostCommon(starters);

    // Only flag if the repeated starter is NOT a legitimate academic starter
    // and repeats more than 3 times
    if (mc && mc[1] > 3 && !LEGITIMATE_STARTERS.has(mc[0])) {
      const starterPenalty = (mc[1] - 3) * 2;
      score += starterPenalty;
      flags.push({ text: `starter "${mc[0]}" repeated x${mc[1]}`, weight: starterPenalty, category: "starter" });
    }

    // Uniformity — only flag if very uniform (low std dev)
    const lens = sentences.map((s) => s.split(/\s+/).length);
    if (lens.length > 4) {
      const sd = stdDev(lens);
      if (sd < 3) {
        score += 5;
        flags.push({ text: `uniform sentences (std=${sd.toFixed(1)})`, weight: 5, category: "uniformity" });
      } else if (sd < 5) {
        score += 2;
        flags.push({ text: `somewhat uniform (std=${sd.toFixed(1)})`, weight: 2, category: "uniformity" });
      }
    }
  }

  // 3. Paragraph length — only flag very long paragraphs
  if (text.length > 1200) {
    score += 4;
    flags.push({ text: `very long (${text.length} chars)`, weight: 4, category: "length" });
  } else if (text.length > 800) {
    score += 2;
    flags.push({ text: `long (${text.length} chars)`, weight: 2, category: "length" });
  }

  // 4. Citation density — only flag extreme density
  const cites = (text.match(/\(\d{4}\)/g) || []).length;
  if (cites >= 6 && sentences.length <= 5) {
    score += 4;
    flags.push({ text: `citation-dense (${cites} cites)`, weight: 4, category: "citation" });
  }

  // 5. Em-dashes — only flag multiple
  const em = (text.match(/\u2014/g) || []).length;
  if (em >= 3) {
    score += em * 2;
    flags.push({ text: `em-dash x${em}`, weight: em * 2, category: "dash" });
  }

  // 6. Contractions — REMOVED as false positive for academic writing
  // Academic papers don't use contractions; this is not an AI tell.

  const level = score >= 20 ? "HIGH" : score >= 12 ? "MEDIUM" : "LOW";

  return {
    index: idx,
    text,
    score,
    level,
    flags,
    sentences,
    wordCount: text.split(/\s+/).length,
    sentenceCount: sentences.length,
    citationCount: cites,
    hasContractions: CONTRACTIONS.some((c) => text.includes(c)),
    emDashCount: em,
  };
}

function buildResult(filename, paragraphs) {
  const totalScore = paragraphs.reduce((s, p) => s + p.score, 0);
  // More balanced formula: score per paragraph, scaled to percentage
  const avgScore = paragraphs.length > 0 ? totalScore / paragraphs.length : 0;
  // Map avgScore to percentage: 0 = 0%, 15 = 50%, 30+ = 100%
  const aiPct = Math.min(Math.round((avgScore / 30) * 100), 100);

  return {
    filename,
    paragraphs,
    totalScore,
    aiPercentage: aiPct,
    highCount: paragraphs.filter((p) => p.level === "HIGH").length,
    mediumCount: paragraphs.filter((p) => p.level === "MEDIUM").length,
    lowCount: paragraphs.filter((p) => p.level === "LOW").length,
    totalBody: paragraphs.length,
  };
}

// ---------------------------------------------------------------------------
// DOCX scanning — single mammoth pass
// ---------------------------------------------------------------------------
async function scanDisk(filePath) {
  const mammoth = require("mammoth");

  const htmlResult = await mammoth.convertToHtml({ path: filePath });
  const htmlParas = htmlResult.value.split(/<\/p>/);

  const paragraphs = [];
  let paraIdx = 0;

  for (let i = 0; i < htmlParas.length; i++) {
    const html = htmlParas[i];
    const text = html.replace(/<[^>]+>/g, "").trim();

    // Skip bold-only paragraphs (headings) and short ones
    const isBold = /<(strong|b)>[^<]*<\/(strong|b)>/.test(html) && text.length < 200;
    if (isBold || text.length < 50) continue;

    paraIdx++;
    const scored = scoreParagraph(text, paraIdx);
    paragraphs.push(scored);
  }

  return buildResult(filePath, paragraphs);
}

// ---------------------------------------------------------------------------
// Fix suggestions
// ---------------------------------------------------------------------------
function suggestFixes(para) {
  const suggestions = [];
  const lower = para.text.toLowerCase();

  for (const [phrase, replacements] of Object.entries(REPLACEMENTS)) {
    if (lower.includes(phrase)) {
      suggestions.push(`Replace "${phrase}" with: ${replacements.slice(0, 3).join(", ")}`);
    }
  }

  if (para.emDashCount >= 3) {
    suggestions.push("Replace em-dashes with commas or parentheses");
  }

  const starterFlag = para.flags.find((f) => f.category === "starter");
  if (starterFlag) {
    const match = starterFlag.text.match(/starter "([^"]+)"/);
    if (match) {
      suggestions.push(`Vary sentence starters (currently repeats "${match[1]}")`);
    }
  }

  if (para.wordCount > 150) {
    suggestions.push("Break into shorter paragraphs (aim for 80-120 words)");
  }

  return suggestions;
}

module.exports = { scanDisk, scoreParagraph, buildResult, suggestFixes, AI_PHRASES, REPLACEMENTS };

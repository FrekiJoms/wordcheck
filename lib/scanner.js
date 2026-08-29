"use strict";

const AI_PHRASES = {
  "present study": 3, "the present study": 3, "this study": 2,
  "moreover": 3, "furthermore": 3, "consequently": 3,
  "facilitates": 3, "enhances": 3, "underpins": 3,
  "integral": 3, "pivotal": 3, "unquestionably": 3,
  "according to": 2, "in terms of": 2,
  "significantly": 2, "importantly": 2, "notably": 2,
  "essentially": 2, "fundamentally": 2, "comprehensive": 2,
  "crucial": 2, "it is important": 2,
  "one of the": 2, "among the first": 2,
  "this chapter": 1, "related literature": 1, "the literature": 1,
  "this finding": 1, "this trend": 1, "this idea": 1,
  "in simple terms": 1, "in simpler terms": 1,
  "because of this": 1, "because of these": 1,
  "to sum up": 1, "taken together": 1, "it matters": 1,
};

const CONTRACTIONS = [
  "n't", "'re", "'ve", "it's", "don't", "doesn't", "can't", "isn't",
  "they're", "we're", "that's", "there's", "won't", "haven't", "hasn't",
  "wouldn't", "couldn't", "shouldn't", "let's", "who's", "what's",
];

const REPLACEMENTS = {
  "present study": ["this research", "the current work", "this project"],
  "the present study": ["this research", "the current work"],
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

function scoreParagraph(text, idx) {
  if (text.trim().length < 50) {
    return { index: idx, text, score: 0, level: "SKIP", flags: [], sentences: [], wordCount: 0, sentenceCount: 0, citationCount: 0, hasContractions: false, emDashCount: 0 };
  }

  const lower = text.toLowerCase();
  let score = 0;
  const flags = [];

  // 1. AI phrase matching
  for (const [phrase, weight] of Object.entries(AI_PHRASES)) {
    const count = (lower.match(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    if (count > 0) {
      score += count * weight;
      flags.push({ text: `"${phrase}" x${count}`, weight: count * weight, category: "phrase" });
    }
  }

  // 2. Sentence analysis
  const sentences = splitSentences(text);
  if (sentences.length > 0) {
    const starters = sentences.map((s) => s.split(/\s+/)[0]).filter(Boolean);
    const mc = mostCommon(starters);
    if (mc && mc[1] > 1) {
      score += mc[1] * 2;
      flags.push({ text: `starter "${mc[0]}" repeated x${mc[1]}`, weight: mc[1] * 2, category: "starter" });
    }

    const lens = sentences.map((s) => s.split(/\s+/).length);
    if (lens.length > 3) {
      const sd = stdDev(lens);
      if (sd < 4) {
        score += 5;
        flags.push({ text: `uniform sentences (std=${sd.toFixed(1)})`, weight: 5, category: "uniformity" });
      } else if (sd < 6) {
        score += 2;
        flags.push({ text: `somewhat uniform (std=${sd.toFixed(1)})`, weight: 2, category: "uniformity" });
      }
    }
  }

  // 3. Paragraph length
  if (text.length > 800) {
    score += 3;
    flags.push({ text: `very long (${text.length} chars)`, weight: 3, category: "length" });
  } else if (text.length > 650) {
    score += 1;
    flags.push({ text: `long (${text.length} chars)`, weight: 1, category: "length" });
  }

  // 4. Citation density
  const cites = (text.match(/\(\d{4}\)/g) || []).length;
  if (cites >= 5 && sentences.length <= 6) {
    score += 4;
    flags.push({ text: `citation-dense (${cites} cites)`, weight: 4, category: "citation" });
  }

  // 5. Em-dashes
  const em = (text.match(/\u2014/g) || []).length;
  if (em > 0) {
    score += em * 2;
    flags.push({ text: `em-dash x${em}`, weight: em * 2, category: "dash" });
  }

  // 6. Contractions check
  const hasCon = CONTRACTIONS.some((c) => text.includes(c));
  if (text.length > 300 && !hasCon) {
    score += 3;
    flags.push({ text: "no contractions", weight: 3, category: "contraction" });
  }

  const level = score >= 15 ? "HIGH" : score >= 8 ? "MEDIUM" : "LOW";

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
    hasContractions: hasCon,
    emDashCount: em,
  };
}

function buildResult(filename, paragraphs) {
  const totalScore = paragraphs.reduce((s, p) => s + p.score, 0);
  const maxPossible = (paragraphs.length || 1) * 20;
  const aiPct = Math.min((totalScore / maxPossible) * 100 * 3, 100);

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

async function scanDisk(filePath) {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  const fullText = result.value;

  // mammoth gives us one big string; split by double newlines into paragraphs
  const rawParas = fullText.split(/\n\s*\n/);

  // We also need to detect bold paragraphs to skip them.
  // mammoth's raw text doesn't preserve bold, so we use the html converter for that.
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

function suggestFixes(para) {
  const suggestions = [];
  const lower = para.text.toLowerCase();

  for (const [phrase, replacements] of Object.entries(REPLACEMENTS)) {
    if (lower.includes(phrase)) {
      suggestions.push(`Replace "${phrase}" with: ${replacements.slice(0, 3).join(", ")}`);
    }
  }

  if (!para.hasContractions && para.wordCount > 30) {
    suggestions.push("Add contractions (don't, it's, can't, etc.)");
  }

  if (para.emDashCount > 0) {
    suggestions.push("Replace em-dashes with commas or parentheses");
  }

  if (para.sentenceCount > 3) {
    const starters = para.sentences.map((s) => s.split(/\s+/)[0]).filter(Boolean);
    const mc = mostCommon(starters);
    if (mc && mc[1] > 1) {
      suggestions.push(`Vary sentence starters (currently repeats "${mc[0]}")`);
    }
  }

  return suggestions;
}

module.exports = { scanDisk, scoreParagraph, buildResult, suggestFixes, AI_PHRASES, REPLACEMENTS };

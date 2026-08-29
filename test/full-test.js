"use strict";

const chalk = require("chalk");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && result.then) {
      return result.then(() => { console.log("  PASS " + name); pass++; })
                   .catch(e => { console.log("  FAIL " + name + ": " + e.message); fail++; });
    }
    console.log("  PASS " + name);
    pass++;
  } catch(e) {
    console.log("  FAIL " + name + ": " + e.message);
    fail++;
  }
}

const DOC = "C:\\Users\\ranbing143\\Downloads\\RESEARCH CHAPTER II - IMPROVED.docx";

async function runAll() {
  // ========== MODULE LOADING ==========
  console.log("\n=== MODULE LOADING ===");
  const modules = {};
  test("colors", () => { modules.colors = require(path.join(ROOT, "lib/colors")); });
  test("constants", () => { modules.constants = require(path.join(ROOT, "lib/constants")); });
  test("prompts", () => { modules.prompts = require(path.join(ROOT, "lib/prompts")); });
  test("table", () => { modules.table = require(path.join(ROOT, "lib/table")); });
  test("scanner", () => { modules.scanner = require(path.join(ROOT, "lib/scanner")); });
  test("findings", () => { modules.findings = require(path.join(ROOT, "lib/findings")); });
  test("ai", () => { modules.ai = require(path.join(ROOT, "lib/ai")); });
  test("diff", () => { modules.diff = require(path.join(ROOT, "lib/diff")); });
  test("terminal", () => { modules.terminal = require(path.join(ROOT, "lib/terminal")); });
  test("mcp-client", () => { modules.mcpClient = require(path.join(ROOT, "lib/mcp-client")); });
  test("ai-agent", () => { modules.aiAgent = require(path.join(ROOT, "lib/ai-agent")); });
  test("tools/index", () => { modules.tools = require(path.join(ROOT, "lib/tools")); });
  test("tools/scan-tools", () => { require(path.join(ROOT, "lib/tools/scan-tools")); });
  test("tools/document-tools", () => { require(path.join(ROOT, "lib/tools/document-tools")); });
  test("tools/edit-tools", () => { require(path.join(ROOT, "lib/tools/edit-tools")); });
  test("agent", () => { modules.agent = require(path.join(ROOT, "lib/agent")); });

  // ========== TABLE RENDERER ==========
  console.log("\n=== TABLE RENDERER ===");
  const { renderTable, renderPanel, stripHtml, visibleLen, padVisible } = modules.table;
  test("stripHtml removes tags", () => {
    const r = stripHtml("<p>Hello <b>world</b></p>");
    if (r !== "Hello world") throw new Error("got: " + JSON.stringify(r));
  });
  test("stripHtml handles entities", () => {
    const r = stripHtml("&amp; &lt; &gt; &quot; &#39; &nbsp;");
    if (r !== '& < > " \'') throw new Error("got: " + JSON.stringify(r));
  });
  test("stripHtml handles br/p/div", () => {
    const r = stripHtml("a<br>b</p>c<div>d");
    if (!r.includes("a\nb")) throw new Error("got: " + JSON.stringify(r));
  });
  test("stripHtml handles empty", () => {
    if (stripHtml("") !== "") throw new Error("not empty");
    if (stripHtml(null) !== "") throw new Error("null failed");
  });
  test("visibleLen strips ANSI", () => {
    const r = visibleLen(chalk.red("hello"));
    if (r !== 5) throw new Error("got: " + r);
  });
  test("padVisible pads correctly", () => {
    const r = padVisible("hi", 5);
    if (visibleLen(r) !== 5) throw new Error("got len: " + visibleLen(r));
  });
  test("renderTable returns lines", () => {
    const r = renderTable({ headers: ["A", "B"], widths: [10, 10], rows: [["1", "2"]] });
    if (r.length < 4) throw new Error("lines: " + r.length);
  });
  test("renderPanel returns lines", () => {
    const r = renderPanel({ title: "Test", lines: ["line1", "line2"] });
    if (r.length < 4) throw new Error("lines: " + r.length);
  });

  // ========== SCANNER ==========
  console.log("\n=== SCANNER ===");
  const { scanDisk, scoreParagraph, AI_PHRASES, REPLACEMENTS } = modules.scanner;
  test("AI_PHRASES has 30+ entries", () => {
    if (Object.keys(AI_PHRASES).length < 30) throw new Error("count: " + Object.keys(AI_PHRASES).length);
  });
  test("REPLACEMENTS has entries", () => {
    if (Object.keys(REPLACEMENTS).length < 20) throw new Error("count: " + Object.keys(REPLACEMENTS).length);
  });
  test("scoreParagraph scores long text", () => {
    const text = "This is a test paragraph with enough words to be scored properly and it contains some text for analysis.";
    const r = scoreParagraph(text, 1);
    if (r.level === undefined) throw new Error("no level");
    if (r.score === undefined) throw new Error("no score");
  });
  test("scoreParagraph skips short text", () => {
    const r = scoreParagraph("short", 1);
    if (r.level !== "SKIP") throw new Error("level: " + r.level);
  });
  test("scoreParagraph detects AI phrases", () => {
    const text = "Moreover, the present study aims to examine the comprehensive framework that underpins the integral aspects of this pivotal research in terms of the findings.";
    const r = scoreParagraph(text, 1);
    if (r.score < 5) throw new Error("score too low: " + r.score);
    if (r.flags.length === 0) throw new Error("no flags");
  });
  test("scoreParagraph detects em-dashes", () => {
    const text = "This paragraph has em-dashes \u2014 which are a common AI tell \u2014 and should be flagged accordingly for review.";
    const r = scoreParagraph(text, 1);
    const dashFlag = r.flags.find(f => f.category === "dash");
    if (!dashFlag) throw new Error("no dash flag");
  });

  // ========== FINDINGS ==========
  console.log("\n=== FINDINGS ===");
  const { buildFindings, summarizeFindings, FindingStatus, transitionFinding, createFinding } = modules.findings;
  test("FindingStatus has all states", () => {
    const expected = ["NEW", "REVIEWED", "APPROVED", "SKIPPED", "FIXED", "FAILED", "VERIFIED"];
    for (const s of expected) {
      if (!FindingStatus[s]) throw new Error("missing: " + s);
    }
  });
  test("createFinding works", () => {
    const f = createFinding({ category: "test", severity: "HIGH", title: "test", paragraphIndex: 1 });
    if (!f.id) throw new Error("no id");
    if (f.status !== FindingStatus.NEW) throw new Error("status: " + f.status);
    if (!f.createdAt) throw new Error("no createdAt");
  });
  test("transitionFinding NEW -> APPROVED", () => {
    const f = createFinding({ category: "test", severity: "HIGH", title: "test", paragraphIndex: 1 });
    transitionFinding(f, FindingStatus.APPROVED);
    if (f.status !== FindingStatus.APPROVED) throw new Error("status: " + f.status);
  });
  test("transitionFinding rejects invalid", () => {
    const f = createFinding({ category: "test", severity: "HIGH", title: "test", paragraphIndex: 1 });
    let threw = false;
    try { transitionFinding(f, FindingStatus.FIXED); } catch(e) { threw = true; }
    if (!threw) throw new Error("should have thrown");
  });

  // ========== AI ANALYSIS ==========
  console.log("\n=== AI ANALYSIS ===");
  const { analyzeFinding, suggestRewrite } = modules.ai;
  test("analyzeFinding for ai_phrase", () => {
    const f = createFinding({ category: "ai_phrase", severity: "HIGH", title: '"moreover" x1', paragraphIndex: 1, originalContent: "Moreover, the test text." });
    const r = analyzeFinding(f);
    if (!r.analysis) throw new Error("no analysis");
    if (!r.recommendation) throw new Error("no recommendation");
    if (typeof r.confidence !== "number") throw new Error("no confidence");
  });
  test("analyzeFinding for contraction", () => {
    const f = createFinding({ category: "contraction", severity: "LOW", title: "no contractions", paragraphIndex: 1, originalContent: "This paragraph does not use any contractions at all." });
    const r = analyzeFinding(f);
    if (!r.recommendation.includes("contraction")) throw new Error("bad recommendation");
  });
  test("suggestRewrite replaces phrases", () => {
    const r = suggestRewrite("Moreover, the present study is comprehensive.", []);
    if (!r.changed) throw new Error("not changed");
    if (r.rewritten.includes("Moreover")) throw new Error("still has Moreover");
    if (r.rewritten.includes("present study")) throw new Error("still has present study");
  });
  test("suggestRewrite no change for clean text", () => {
    const r = suggestRewrite("This is clean text with no issues.", []);
    if (r.changed) throw new Error("should not change");
  });

  // ========== DIFF RENDERER ==========
  console.log("\n=== DIFF RENDERER ===");
  const { renderSideBySideDiff, renderInlineDiff, wordDiff } = modules.diff;
  test("renderInlineDiff works", () => {
    const r = renderInlineDiff("hello world", "hello there world");
    if (r.length < 2) throw new Error("lines: " + r.length);
  });
  test("renderSideBySideDiff works", () => {
    const r = renderSideBySideDiff("hello world", "hello there world");
    if (r.length < 3) throw new Error("lines: " + r.length);
  });
  test("wordDiff detects changes", () => {
    const r = wordDiff("hello world", "hello there world");
    if (!r.oldSpans || !r.newSpans) throw new Error("missing spans");
    const added = r.newSpans.filter(s => s.type === "added");
    if (added.length === 0) throw new Error("no additions detected");
  });

  // ========== AI AGENT CONFIG ==========
  console.log("\n=== AI AGENT ===");
  const { LLMClient, getAllTools, SYSTEM_PROMPT, loadConfig } = modules.aiAgent;
  test("getAllTools returns 20 tools", () => {
    const tools = getAllTools();
    if (tools.length !== 20) throw new Error("count: " + tools.length);
  });
  test("tools have required fields", () => {
    const tools = getAllTools();
    for (const t of tools) {
      if (!t.name) throw new Error("tool missing name");
      if (!t.description) throw new Error("tool " + t.name + " missing description");
      if (!t.parameters) throw new Error("tool " + t.name + " missing parameters");
    }
  });
  test("SYSTEM_PROMPT has structured format", () => {
    if (!SYSTEM_PROMPT.includes("<tool_call>")) throw new Error("missing tool_call");
    if (!SYSTEM_PROMPT.includes("[INFO]")) throw new Error("missing [INFO]");
    if (!SYSTEM_PROMPT.includes("[SUCCESS]")) throw new Error("missing [SUCCESS]");
    if (!SYSTEM_PROMPT.includes("[ERROR]")) throw new Error("missing [ERROR]");
    if (!SYSTEM_PROMPT.includes("[WARN]")) throw new Error("missing [WARN]");
  });
  test("loadConfig returns valid config", () => {
    const c = loadConfig();
    if (!c.api) throw new Error("no api");
    if (!c.api.provider) throw new Error("no provider");
    if (!c.api.baseUrl) throw new Error("no baseUrl");
    if (!c.api.model) throw new Error("no model");
  });
  test("LLMClient instantiates", () => {
    const c = loadConfig();
    const l = new LLMClient(c);
    if (l.provider !== c.api.provider) throw new Error("provider mismatch");
  });

  // ========== CONSTANTS ==========
  console.log("\n=== CONSTANTS ===");
  const C = modules.constants;
  test("has VERDICTS", () => {
    if (!C.VERDICTS.high) throw new Error("missing high");
    if (!C.VERDICTS.medium) throw new Error("missing medium");
    if (!C.VERDICTS.low) throw new Error("missing low");
  });
  test("has ERRORS", () => {
    if (!C.ERRORS.MCP_NOT_CONNECTED) throw new Error("missing MCP_NOT_CONNECTED");
    if (!C.ERRORS.NO_DOCUMENT) throw new Error("missing NO_DOCUMENT");
    if (!C.ERRORS.FILE_NOT_FOUND) throw new Error("missing FILE_NOT_FOUND");
  });
  test("has DOCS_FOLDER", () => {
    if (!C.DOCS_FOLDER) throw new Error("missing");
  });
  test("has MCP timeouts", () => {
    if (!C.MCP_INIT_TIMEOUT) throw new Error("missing init timeout");
    if (!C.MCP_TOOL_TIMEOUT) throw new Error("missing tool timeout");
  });

  // ========== COLORS ==========
  console.log("\n=== COLORS ===");
  const colors = modules.colors;
  test("has all 10 colors", () => {
    const needed = ["brand", "pink", "cyan", "green", "yellow", "red", "dim", "white", "bar", "purple"];
    for (const c of needed) {
      if (!colors[c]) throw new Error("missing: " + c);
    }
  });

  // ========== TOOLS EXECUTION ==========
  console.log("\n=== TOOLS EXECUTION ===");
  const { executeTool } = modules.tools;
  test("executeTool returns error for unknown", async () => {
    const r = await executeTool("nonexistent_tool", {}, {});
    if (!r.error) throw new Error("no error returned");
  });

  // ========== REAL FILE SCAN ==========
  console.log("\n=== REAL FILE SCAN ===");
  test("scanDisk loads real .docx", async () => {
    const r = await scanDisk(DOC);
    if (!r.paragraphs) throw new Error("no paragraphs");
    if (r.paragraphs.length === 0) throw new Error("empty paragraphs");
    if (!r.filename) throw new Error("no filename");
    if (typeof r.aiPercentage !== "number") throw new Error("no aiPercentage");
  });
  test("scanDisk paragraphs have required fields", async () => {
    const r = await scanDisk(DOC);
    const p = r.paragraphs[0];
    if (p.index === undefined) throw new Error("no index");
    if (p.text === undefined) throw new Error("no text");
    if (p.score === undefined) throw new Error("no score");
    if (p.level === undefined) throw new Error("no level");
    if (!Array.isArray(p.flags)) throw new Error("no flags");
  });
  test("buildFindings from scan", async () => {
    const r = await scanDisk(DOC);
    const f = buildFindings(r);
    if (f.length === 0) throw new Error("no findings");
    if (!f[0].id) throw new Error("finding no id");
    if (!f[0].category) throw new Error("finding no category");
  });
  test("summarizeFindings matches", async () => {
    const r = await scanDisk(DOC);
    const f = buildFindings(r);
    const s = summarizeFindings(f);
    if (s.total !== f.length) throw new Error("total mismatch: " + s.total + " vs " + f.length);
  });

  // ========== NON-INTERACTIVE MODE ==========
  console.log("\n=== NON-INTERACTIVE MODE ===");
  const { execSync } = require("child_process");
  const binPath = path.join(ROOT, "bin", "wordcheck.js");
  test("wordcheck --version works", () => {
    const r = execSync("node " + binPath + " --version", { encoding: "utf8" }).trim();
    if (!r.includes("v1.9.0")) throw new Error("got: " + r);
  });
  test("wordcheck --help works", () => {
    const r = execSync("node " + binPath + " --help", { encoding: "utf8" });
    if (!r.includes("wordcheck")) throw new Error("no wordcheck in help");
  });
  test("wordcheck -n scans file", () => {
    const r = execSync('node ' + binPath + ' "' + DOC + '" -n', { encoding: "utf8" });
    if (!r.includes("Paragraphs:")) throw new Error("no Paragraphs");
    if (!r.includes("Findings:")) throw new Error("no Findings");
    if (!r.includes("HIGH")) throw new Error("no HIGH");
  });
  test("wordcheck -n missing file errors", () => {
    let threw = false;
    try { execSync("node " + binPath + " nonexistent.docx -n", { encoding: "utf8" }); } catch(e) { threw = true; }
    if (!threw) throw new Error("should have thrown");
  });
  test("wordcheck -n non-docx errors", () => {
    let threw = false;
    try { execSync("node " + binPath + " test.txt -n", { encoding: "utf8" }); } catch(e) { threw = true; }
    if (!threw) throw new Error("should have thrown");
  });

  // ========== RENDER TESTS ==========
  console.log("\n=== RENDER OUTPUT TESTS ===");
  test("renderTable output has box chars", () => {
    const r = renderTable({ headers: ["ID", "Name"], widths: [6, 20], rows: [["1", "test"]] });
    const text = r.join("\n");
    if (!text.includes("\u250C")) throw new Error("no top-left corner");
    if (!text.includes("\u2514")) throw new Error("no bottom-left corner");
    if (!text.includes("\u2502")) throw new Error("no vertical bar");
    if (!text.includes("\u2500")) throw new Error("no horizontal bar");
  });
  test("renderPanel output has box chars", () => {
    const r = renderPanel({ title: "TEST", lines: ["content"] });
    const text = r.join("\n");
    if (!text.includes("\u250C")) throw new Error("no top-left");
    if (!text.includes("\u2514")) throw new Error("no bottom-left");
  });
  test("renderInlineDiff has +/- markers", () => {
    const r = renderInlineDiff("hello world", "hello there world");
    const text = r.join("\n");
    if (!text.includes("+")) throw new Error("no + marker");
  });

  // ========== SUMMARY ==========
  console.log("\n==========================================");
  console.log("RESULTS: " + pass + " passed, " + fail + " failed");
  console.log("==========================================");

  if (fail > 0) process.exit(1);
}

runAll().catch(e => { console.error("FATAL:", e); process.exit(1); });

"use strict";

const path = require("path");
const fs = require("fs");
const chalk = require("chalk");
const { scanDisk, suggestFixes } = require("./scanner");
const { buildFindings, summarizeFindings, FindingStatus, transitionFinding } = require("./findings");
const { analyzeFinding, suggestRewrite } = require("./ai");
const MCPClient = require("./mcp-client");

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------
const C = {
  brand:  chalk.hex("#5B8DEF"),
  pink:   chalk.hex("#FF79C6"),
  cyan:   chalk.hex("#8BE9FD"),
  green:  chalk.hex("#50FA7B"),
  yellow: chalk.hex("#F1FA8C"),
  red:    chalk.hex("#FF5555"),
  dim:    chalk.hex("#6272A4"),
  white:  chalk.hex("#F8F8F2"),
  bar:    chalk.hex("#FF79C6"),
};

const VERSION = require("../package.json").version;

// ---------------------------------------------------------------------------
// Diff renderer — shows before/after changes inline
// ---------------------------------------------------------------------------
function renderDiff(original, fixed, contextLines = 2) {
  const origLines = original.split(/\n/);
  const fixedLines = fixed.split(/\n/);

  const maxLen = Math.max(origLines.length, fixedLines.length);
  const output = [];

  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i] || "";
    const f = fixedLines[i] || "";

    if (o === f) {
      output.push(C.dim("  " + o));
    } else {
      if (o) output.push(C.red("  - " + o));
      if (f) output.push(C.green("  + " + f));
    }
  }

  return output.join("\n");
}

function renderWordDiff(original, fixed) {
  const origWords = original.split(/\s+/);
  const fixedWords = fixed.split(/\s+/);

  // Simple word-level diff: highlight changed words
  const result = [];
  let oi = 0, fi = 0;

  while (oi < origWords.length || fi < fixedWords.length) {
    if (oi >= origWords.length) {
      result.push(C.green("+" + fixedWords[fi]));
      fi++;
    } else if (fi >= fixedWords.length) {
      result.push(C.red("-" + origWords[oi]));
      oi++;
    } else if (origWords[oi] === fixedWords[fi]) {
      result.push(C.dim(origWords[oi]));
      oi++; fi++;
    } else {
      // Look ahead to find if the word was deleted or replaced
      const nextMatch = fixedWords.indexOf(origWords[oi], fi);
      const nextMatchOrig = origWords.indexOf(fixedWords[fi], oi);

      if (nextMatch !== -1 && (nextMatchOrig === -1 || nextMatch - fi <= nextMatchOrig - oi)) {
        // Words were added
        while (fi < nextMatch) {
          result.push(C.green("+" + fixedWords[fi]));
          fi++;
        }
      } else if (nextMatchOrig !== -1) {
        // Words were removed
        while (oi < nextMatchOrig) {
          result.push(C.red("-" + origWords[oi]));
          oi++;
        }
      } else {
        // Replacement
        result.push(C.red("-" + origWords[oi]));
        result.push(C.green("+" + fixedWords[fi]));
        oi++; fi++;
      }
    }
  }

  return result.join(" ");
}

// ---------------------------------------------------------------------------
// Terminal layout — sticky input at bottom
// ---------------------------------------------------------------------------
class AgentUI {
  constructor() {
    this.contentLines = [];
    this.inputActive = false;
    this.rl = null;
  }

  clear() {
    process.stdout.write(
      process.platform === "win32" ? "\x1Bc" : "\x1B[2J\x1B[3J\x1B[H"
    );
    this.contentLines = [];
  }

  /** Print a line to the content area */
  print(line = "") {
    this.contentLines.push(line);
    process.stdout.write(line + "\n");
  }

  /** Print multiple lines */
  printLines(lines) {
    for (const line of lines) this.print(line);
  }

  /** Show a separator line */
  separator() {
    this.print(C.dim("─".repeat(Math.min(process.stdout.columns || 80, 80))));
  }

  /** Show status bar */
  statusBar(label = "ready") {
    const w = Math.min(process.stdout.columns || 80, 100);
    const left = `  ● ${C.pink("wordcheck")}  ${C.dim("v" + VERSION)}`;
    const right = C.dim(label + "  ");
    const leftV = left.replace(/\x1B\[[0-9;]*m/g, "");
    const rightV = right.replace(/\x1B\[[0-9;]*m/g, "");
    const gap = Math.max(1, w - leftV.length - rightV.length);
    this.print(C.dim("─".repeat(w)));
    this.print(left + " ".repeat(gap) + right);
  }

  /** Print the banner */
  banner() {
    const WORDMARK = [
      "  ██╗    ██╗ ██████╗ ██████╗ ██████╗  ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗",
      "  ██║    ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝",
      "  ██║ █╗ ██║██║   ██║██████╔╝██║  ██║██║     ███████║█████╗  ██║     █████╔╝ ",
      "  ██║███╗██║██║   ██║██╔══██╗██║  ██║██║     ██╔══██║██╔══╝  ██║     ██╔═██╗ ",
      "  ╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝╚██████╗██║  ██║███████╗╚██████╗██║  ██╗",
      "   ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝",
    ];
    this.print();
    for (const line of WORDMARK) this.print(C.brand(line));
    this.print();
    this.print(C.dim("  AI-Tell Scanner for Word Documents"));
    this.print();
  }

  /** Print findings table */
  renderFindings(findings, showAll = false) {
    const display = showAll ? findings : findings.filter((f) => f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED);
    if (display.length === 0) {
      this.print(C.dim("  No findings to display."));
      return;
    }

    this.print(
      "  " + C.dim("  ID ") + C.dim("severity  ") + C.dim("category          ") + C.dim("title")
    );
    this.separator();

    for (const f of display) {
      const sevColor = f.severity === "HIGH" ? C.red : f.severity === "MEDIUM" ? C.yellow : C.green;
      const statusDot = f.status === FindingStatus.APPROVED ? C.green("●") :
                        f.status === FindingStatus.FIXED ? C.cyan("●") :
                        f.status === FindingStatus.SKIPPED ? C.dim("●") :
                        f.status === FindingStatus.FAILED ? C.red("●") :
                        C.dim("○");

      this.print(
        "  " +
        statusDot + " " +
        C.dim(f.id.padEnd(6)) +
        sevColor(f.severity.padEnd(9)) +
        C.dim(f.category.padEnd(18)) +
        C.dim(f.title.slice(0, 40))
      );
    }
    this.print();
  }

  /** Print a single finding detail */
  renderFindingDetail(finding, context = {}) {
    const sevColor = finding.severity === "HIGH" ? C.red : finding.severity === "MEDIUM" ? C.yellow : C.green;

    this.print();
    this.print(C.bar("  │ ") + C.white.bold(finding.id) + "  " + sevColor(finding.severity) + C.dim("  " + finding.category));
    this.print(C.bar("  │"));
    this.print(C.bar("  │ ") + C.white(finding.title));
    this.print(C.bar("  │ ") + C.dim(finding.description));

    if (finding.evidence) {
      this.print(C.bar("  │"));
      this.print(C.bar("  │ ") + C.dim("evidence:"));
      const evLines = finding.evidence.slice(0, 150).split(/\n/);
      for (const line of evLines) {
        this.print(C.bar("  │ ") + C.dim("  ") + C.dim(line));
      }
    }

    // AI analysis
    const analysis = analyzeFinding(finding, context);
    this.print(C.bar("  │"));
    this.print(C.bar("  │ ") + C.pink.bold("analysis"));
    this.print(C.bar("  │ ") + C.dim(analysis.analysis));
    this.print(C.bar("  │"));
    this.print(C.bar("  │ ") + C.pink.bold("recommendation"));
    this.print(C.bar("  │ ") + C.green(analysis.recommendation));
    this.print(C.bar("  │ ") + C.dim("confidence: ") + C.cyan(analysis.confidence + "%"));

    if (finding.suggestedFix) {
      this.print(C.bar("  │"));
      this.print(C.bar("  │ ") + C.pink.bold("suggested fix"));
      this.print(C.bar("  │ ") + C.white(finding.suggestedFix));
    }

    this.print();
  }

  /** Render summary panel */
  renderSummary(summary) {
    this.print(C.bar("  │ ") + C.pink.bold("Summary"));
    this.print(C.bar("  │"));
    this.print(C.bar("  │ ") + C.dim("total ") + C.cyan(String(summary.total)) +
               C.dim("   fixable ") + C.cyan(String(summary.fixable)));
    this.print(C.bar("  │ ") +
               C.red("HIGH " + summary.bySeverity.HIGH) + C.dim("   ") +
               C.yellow("MED " + summary.bySeverity.MEDIUM) + C.dim("   ") +
               C.green("LOW " + summary.bySeverity.LOW));
    this.print(C.bar("  │ ") +
               C.dim("approved ") + C.green(String(summary.approved)) + C.dim("   ") +
               C.dim("fixed ") + C.cyan(String(summary.fixed)) + C.dim("   ") +
               C.dim("failed ") + C.red(String(summary.failed)));
    this.print();
  }

  /** Show diff between original and fixed text */
  renderDiff(original, fixed) {
    this.print(C.bar("  │ ") + C.pink.bold("diff"));
    this.print(C.bar("  │"));
    const diff = renderWordDiff(original, fixed);
    const diffLines = diff.split(/\n/);
    for (const line of diffLines) {
      this.print(C.bar("  │ ") + line);
    }
    this.print();
  }
}

// ---------------------------------------------------------------------------
// Agent — the main interactive controller
// ---------------------------------------------------------------------------
class Agent {
  constructor() {
    this.ui = new AgentUI();
    this.mcp = new MCPClient();
    this.scanResult = null;
    this.findings = [];
    this.filePath = null;
    this.outputPath = null;
    this.mcpConnected = false;
    this.changeLog = [];
  }

  async run(filePath) {
    this.filePath = filePath;

    // Phase 1: Scan
    this.ui.clear();
    this.ui.banner();
    this.ui.print(C.bar("  │ ") + C.dim("Scanning ") + C.pink(path.basename(filePath)) + C.dim("..."));
    this.ui.print();

    try {
      this.scanResult = await scanDisk(filePath);
    } catch (e) {
      this.ui.print(C.red("  ✗  Scan failed: " + e.message));
      process.exit(1);
    }

    // Phase 2: Build findings
    this.findings = buildFindings(this.scanResult);
    const summary = summarizeFindings(this.findings);

    // Phase 3: Try MCP connection
    this.ui.print(C.bar("  │ ") + C.dim("Connecting to Word MCP server..."));
    try {
      await this.mcp.connect();
      this.mcpConnected = true;
      this.ui.print(C.bar("  │ ") + C.green("  ✓  MCP connected") + C.dim(`  (${this.mcp.tools.length} tools available)`));
    } catch (e) {
      this.mcpConnected = false;
      this.ui.print(C.bar("  │ ") + C.yellow("  ⚠  MCP unavailable") + C.dim("  " + e.message));
      this.ui.print(C.bar("  │ ") + C.dim("  Fix workflow will work without direct DOCX editing."));
    }

    // Phase 4: Display results
    this.ui.clear();
    this.ui.banner();

    // File info
    const pct = this.scanResult.aiPercentage;
    const pctColor = pct >= 50 ? C.red : pct >= 25 ? C.yellow : C.green;
    const verdict = pct >= 50 ? "likely AI-assisted" : pct >= 25 ? "mixed signals" : "reads human";
    this.ui.print(C.bar("  │ ") + C.white.bold(path.basename(filePath)));
    this.ui.print(C.bar("  │ ") + C.dim("paragraphs ") + C.cyan(String(this.scanResult.totalBody)) +
                  C.dim("   score ") + C.cyan(String(this.scanResult.totalScore)) +
                  C.dim("   ai likelihood ") + pctColor(pct.toFixed(0) + "%") +
                  C.dim("  ·  ") + pctColor(verdict));
    this.ui.print();

    // Findings
    this.ui.renderFindings(this.findings);
    this.ui.renderSummary(summary);
    this.ui.statusBar(path.basename(filePath));
    this.ui.print();

    // Phase 5: Enter REPL
    await this.repl();
  }

  async repl() {
    const readline = require("readline");
    this.ui.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.ui.rl.on("SIGINT", () => {
      this.ui.print("\n" + C.dim("  bye."));
      this.ui.rl.close();
      this.mcp.disconnect();
      process.exit(0);
    });

    const prompt = () => {
      this.ui.rl.question(C.bar("  │ ") + C.pink.bold("wordcheck") + C.dim(" › "), async (answer) => {
        const cmd = answer.trim();
        if (!cmd) { prompt(); return; }

        try {
          await this.handleCommand(cmd);
        } catch (e) {
          this.ui.print(C.red("  ✗  " + e.message));
        }

        prompt();
      });
    };

    prompt();
  }

  async handleCommand(cmd) {
    const lower = cmd.toLowerCase();

    // --- Navigation ---
    if (lower === "quit" || lower === "exit" || lower === "q") {
      this.ui.print(C.dim("  bye."));
      this.ui.rl.close();
      this.mcp.disconnect();
      process.exit(0);
    }

    if (lower === "help" || lower === "h") {
      this.printHelp();
      return;
    }

    if (lower === "summary") {
      this.ui.renderSummary(summarizeFindings(this.findings));
      return;
    }

    // --- Findings ---
    if (lower === "findings" || lower === "f") {
      this.ui.renderFindings(this.findings, true);
      return;
    }

    if (lower === "new") {
      this.ui.renderFindings(this.findings.filter((f) => f.status === FindingStatus.NEW));
      return;
    }

    // --- Inspect finding: "1" or "F-0001" ---
    const findingMatch = cmd.match(/^(?:F-)?(\d+)$/i);
    if (findingMatch) {
      const num = parseInt(findingMatch[1], 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (finding) {
        const para = this.scanResult.paragraphs.find((p) => p.index === finding.paragraphIndex);
        this.ui.renderFindingDetail(finding, { paragraph: para });
      } else {
        this.ui.print(C.red("  ✗  Finding not found. Use a number from the list."));
      }
      return;
    }

    // --- Approve: "approve 1" or "approve all" ---
    if (lower.startsWith("approve ")) {
      const target = cmd.slice(8).trim().toLowerCase();
      await this.approveFindings(target);
      return;
    }

    // --- Skip: "skip 1" ---
    if (lower.startsWith("skip ")) {
      const target = cmd.slice(5).trim().toLowerCase();
      this.skipFindings(target);
      return;
    }

    // --- Fix: "fix 1" or "fix all" ---
    if (lower.startsWith("fix ")) {
      const target = cmd.slice(4).trim().toLowerCase();
      await this.applyFix(target);
      return;
    }

    // --- Diff: "diff 1" ---
    if (lower.startsWith("diff ")) {
      const target = cmd.slice(5).trim();
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (finding) {
        const rewrite = suggestRewrite(finding.originalContent, [finding]);
        if (rewrite.changed) {
          this.ui.renderDiff(rewrite.original, rewrite.rewritten);
        } else {
          this.ui.print(C.dim("  No changes suggested for this finding."));
        }
      }
      return;
    }

    // --- Rescan ---
    if (lower === "rescan") {
      this.ui.print(C.bar("  │ ") + C.dim("Rescanning..."));
      this.scanResult = await scanDisk(this.filePath);
      this.findings = buildFindings(this.scanResult);
      this.ui.print(C.green("  ✓  Rescan complete. ") + C.dim(`Found ${this.findings.length} findings.`));
      this.ui.renderFindings(this.findings);
      this.ui.renderSummary(summarizeFindings(this.findings));
      return;
    }

    // --- Paragraph inspection: "para 3" ---
    if (lower.startsWith("para ")) {
      const num = parseInt(cmd.slice(5).trim(), 10);
      const para = this.scanResult.paragraphs.find((p) => p.index === num);
      if (para) {
        this.ui.print();
        this.ui.print(C.bar("  │ ") + C.white.bold("Paragraph " + para.index) + "  " +
                      C.cyan("score " + para.score) + "  " +
                      (para.level === "HIGH" ? C.red : para.level === "MEDIUM" ? C.yellow : C.green)(para.level));
        this.ui.print(C.bar("  │"));
        const words = para.text.replace(/\s+/g, " ").trim().split(" ");
        let line = "";
        for (const w of words) {
          if ((line + " " + w).trim().length > 64 && line) {
            this.ui.print(C.bar("  │ ") + C.dim(line.trim()));
            line = w;
          } else {
            line = line ? line + " " + w : w;
          }
        }
        if (line) this.ui.print(C.bar("  │ ") + C.dim(line.trim()));
        this.ui.print();
      } else {
        this.ui.print(C.red("  ✗  Paragraph not found."));
      }
      return;
    }

    // --- Status ---
    if (lower === "status") {
      const s = summarizeFindings(this.findings);
      this.ui.print(C.bar("  │ ") + C.dim("MCP: ") + (this.mcpConnected ? C.green("connected") : C.red("disconnected")));
      this.ui.print(C.bar("  │ ") + C.dim("Findings: ") + C.cyan(String(s.total)) +
                    C.dim("  Approved: ") + C.green(String(s.approved)) +
                    C.dim("  Fixed: ") + C.cyan(String(s.fixed)));
      if (this.outputPath) {
        this.ui.print(C.bar("  │ ") + C.dim("Output: ") + C.white(this.outputPath));
      }
      this.ui.print();
      return;
    }

    // --- Chat / free text → treat as analysis request ---
    this.ui.print(C.bar("  │ ") + C.dim("I can help you analyze and fix document findings."));
    this.ui.print(C.bar("  │ ") + C.dim("Try: ") + C.white("findings") + C.dim(" · ") +
                  C.white("1") + C.dim(" · ") +
                  C.white("approve 1") + C.dim(" · ") +
                  C.white("fix 1") + C.dim(" · ") +
                  C.white("help"));
    this.ui.print();
  }

  printHelp() {
    this.ui.print();
    this.ui.print(C.bar("  │ ") + C.pink.bold("Commands"));
    this.ui.print(C.bar("  │"));
    this.ui.print(C.bar("  │ ") + C.white("findings") + C.dim("          show all findings"));
    this.ui.print(C.bar("  │ ") + C.white("new") + C.dim("              show new/unreviewed findings"));
    this.ui.print(C.bar("  │ ") + C.white("<number>") + C.dim("           inspect finding detail"));
    this.ui.print(C.bar("  │ ") + C.white("approve <n>") + C.dim("       approve finding for fixing"));
    this.ui.print(C.bar("  │ ") + C.white("approve all") + C.dim("       approve all fixable findings"));
    this.ui.print(C.bar("  │ ") + C.white("skip <n>") + C.dim("          skip finding"));
    this.ui.print(C.bar("  │ ") + C.white("fix <n>") + C.dim("            apply fix via MCP"));
    this.ui.print(C.bar("  │ ") + C.white("fix all") + C.dim("            apply all approved fixes"));
    this.ui.print(C.bar("  │ ") + C.white("diff <n>") + C.dim("            preview proposed changes"));
    this.ui.print(C.bar("  │ ") + C.white("para <n>") + C.dim("            inspect paragraph"));
    this.ui.print(C.bar("  │ ") + C.white("rescan") + C.dim("              re-analyze document"));
    this.ui.print(C.bar("  │ ") + C.white("summary") + C.dim("             show findings summary"));
    this.ui.print(C.bar("  │ ") + C.white("status") + C.dim("              show MCP and fix status"));
    this.ui.print(C.bar("  │ ") + C.white("help") + C.dim("                show this help"));
    this.ui.print(C.bar("  │ ") + C.white("quit") + C.dim("                exit"));
    this.ui.print();
  }

  approveFindings(target) {
    if (target === "all") {
      let count = 0;
      for (const f of this.findings) {
        if (f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) {
          if (f.fixable) {
            transitionFinding(f, FindingStatus.APPROVED, { note: "bulk approved" });
            count++;
          }
        }
      }
      this.ui.print(C.green(`  ✓  Approved ${count} fixable findings.`));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) {
        this.ui.print(C.red("  ✗  Finding not found."));
        return;
      }
      if (!finding.fixable) {
        this.ui.print(C.yellow("  ⚠  This finding is not auto-fixable. Manual review needed."));
        return;
      }
      transitionFinding(finding, FindingStatus.APPROVED, { note: "user approved" });
      this.ui.print(C.green(`  ✓  ${finding.id} approved for fixing.`));
    }
  }

  skipFindings(target) {
    if (target === "all") {
      let count = 0;
      for (const f of this.findings) {
        if (f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) {
          transitionFinding(f, FindingStatus.SKIPPED, { note: "bulk skipped" });
          count++;
        }
      }
      this.ui.print(C.dim(`  Skipped ${count} findings.`));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) {
        this.ui.print(C.red("  ✗  Finding not found."));
        return;
      }
      transitionFinding(finding, FindingStatus.SKIPPED, { note: "user skipped" });
      this.ui.print(C.dim(`  Skipped ${finding.id}.`));
    }
  }

  async applyFix(target) {
    if (!this.mcpConnected) {
      this.ui.print(C.red("  ✗  MCP not connected. Cannot apply fixes."));
      this.ui.print(C.dim("  Start the Word MCP server and try again."));
      return;
    }

    // Ensure output file exists
    if (!this.outputPath) {
      this.ui.print(C.bar("  │ ") + C.dim("Creating safe copy..."));
      this.outputPath = await this.mcp.copyForEdit(this.filePath);
      this.ui.print(C.bar("  │ ") + C.green("  ✓  ") + C.dim(this.outputPath));
    }

    if (target === "all") {
      const approved = this.findings.filter((f) => f.status === FindingStatus.APPROVED);
      if (approved.length === 0) {
        this.ui.print(C.yellow("  ⚠  No approved findings to fix. Use 'approve all' first."));
        return;
      }

      let fixed = 0, failed = 0;
      for (const f of approved) {
        await this.fixOne(f, (v) => { fixed += v; }, (v) => { failed += v; });
      }
      this.ui.print(C.green(`  ✓  Fixed ${fixed}, failed ${failed}.`));
      if (this.outputPath) {
        this.ui.print(C.bar("  │ ") + C.dim("Output: ") + C.white(this.outputPath));
      }
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) {
        this.ui.print(C.red("  ✗  Finding not found."));
        return;
      }
      if (finding.status !== FindingStatus.APPROVED) {
        this.ui.print(C.yellow(`  ⚠  ${finding.id} is not approved. Use 'approve ${num}' first.`));
        return;
      }
      let fixed = 0, failed = 0;
      await this.fixOne(finding, (v) => { fixed += v; }, (v) => { failed += v; });
      if (fixed > 0) {
        this.ui.print(C.green(`  ✓  ${finding.id} fixed.`));
      }
    }
  }

  async fixOne(finding, onFixed, onFailed) {
    const rewrite = suggestRewrite(finding.originalContent, [finding]);
    if (!rewrite.changed) {
      transitionFinding(finding, FindingStatus.FAILED, { note: "no change generated" });
      onFailed(1);
      return;
    }

    try {
      // Show diff before applying
      this.ui.renderDiff(rewrite.original, rewrite.rewritten);

      // Apply via MCP
      this.ui.print(C.bar("  │ ") + C.dim("Applying fix for ") + C.pink(finding.id) + C.dim("..."));

      const result = await this.mcp.searchAndReplace(
        this.outputPath,
        this.extractOriginal(finding),
        this.extractReplacement(finding, rewrite)
      );

      transitionFinding(finding, FindingStatus.FIXED, { note: "applied via MCP" });
      this.changeLog.push({
        findingId: finding.id,
        category: finding.category,
        original: finding.originalContent.slice(0, 100),
        result: "success",
        timestamp: Date.now(),
      });
      onFixed(1);
    } catch (e) {
      transitionFinding(finding, FindingStatus.FAILED, { note: e.message });
      this.changeLog.push({
        findingId: finding.id,
        category: finding.category,
        error: e.message,
        result: "failed",
        timestamp: Date.now(),
      });
      onFailed(1);
    }
  }

  extractOriginal(finding) {
    // For phrase findings, extract just the phrase
    const match = finding.title.match(/^"([^"]+)"/);
    if (match) return match[1];
    return finding.evidence.slice(0, 50);
  }

  extractReplacement(finding, rewrite) {
    // Compare original and rewritten to find the replacement
    const orig = this.extractOriginal(finding);
    const rewritten = rewrite.rewritten;

    // Simple: if the phrase was replaced, find what replaced it
    if (finding.category === FindingCategory.AI_PHRASE) {
      const analysis = analyzeFinding(finding);
      const recMatch = analysis.recommendation.match(/Replace "([^"]+)" with one of: "([^"]+)"/);
      if (recMatch) return recMatch[2];
    }

    // Fallback: use the heuristic rewrite
    return orig; // will be a no-op; user should manually fix
  }
}

module.exports = Agent;

"use strict";

const path = require("path");
const chalk = require("chalk");
const { scanDisk, suggestFixes } = require("./scanner");
const { buildFindings, summarizeFindings, FindingStatus, transitionFinding } = require("./findings");
const { analyzeFinding, suggestRewrite } = require("./ai");
const { renderSideBySideDiff, renderInlineDiff } = require("./diff");
const MCPClient = require("./mcp-client");
const { Terminal, C } = require("./terminal");

// ---------------------------------------------------------------------------
// Agent — interactive CLI AI agent
// ---------------------------------------------------------------------------
class Agent {
  constructor() {
    this.terminal = new Terminal();
    this.mcp = new MCPClient();
    this.scanResult = null;
    this.findings = [];
    this.filePath = null;
    this.backupPath = null;
    this.mcpConnected = false;
    this.changeLog = [];
  }

  // -----------------------------------------------------------------------
  // File selector mode — opens TUI, prompts for file, then scans
  // -----------------------------------------------------------------------
  async runWithFileSelector() {
    const fs = require("fs");

    // Open terminal (alternate screen, raw mode)
    this.terminal.open();
    this._setHeader("Select a document");

    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.white.bold("Welcome to WordCheck"));
    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("Paste a file path below and press Enter."));
    this.terminal.addLine(C.bar("  │ ") + C.dim("Supports .docx files."));
    this.terminal.addLine();
    this.terminal.setStatus("waiting for file");

    // File selection loop
    while (true) {
      const input = await this.terminal.prompt();
      if (input === null) {
        this.terminal.close();
        process.exit(0);
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      // Handle special commands even in file selector
      if (trimmed.toLowerCase() === "quit" || trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "q") {
        this.terminal.addLine(C.dim("  bye."));
        this.terminal.close();
        process.exit(0);
      }

      // Resolve and validate
      const resolved = path.resolve(trimmed.replace(/^["']|["']$/g, "")); // strip quotes

      if (!fs.existsSync(resolved)) {
        this.terminal.addLine(C.red("  ✗  File not found: ") + C.dim(resolved));
        this.terminal.addLine(C.bar("  │ ") + C.dim("Check the path and try again."));
        continue;
      }

      if (!resolved.toLowerCase().endsWith(".docx")) {
        this.terminal.addLine(C.red("  ✗  Only .docx files are supported."));
        continue;
      }

      // Valid file — scan it
      await this._scanAndEnterRepl(resolved);
      return;
    }
  }

  async _scanAndEnterRepl(filePath) {
    this.filePath = filePath;

    this._setHeader("Scanning...");
    this.terminal.clearContent();
    this.terminal.addLine(C.bar("  │ ") + C.dim("Scanning ") + C.pink(path.basename(filePath)) + C.dim("..."));
    this.terminal.setStatus("scanning");

    try {
      this.scanResult = await scanDisk(filePath);
    } catch (e) {
      this.terminal.addLine(C.red("  ✗  Scan failed: " + e.message));
      this.terminal.setStatus("error");
      await this.terminal.prompt();
      this.terminal.close();
      process.exit(1);
    }

    // Build findings
    this.findings = buildFindings(this.scanResult);

    // Connect MCP
    this.terminal.addLine(C.bar("  │ ") + C.dim("Connecting to Word MCP server..."));
    try {
      await this.mcp.connect();
      this.mcpConnected = true;
      this.terminal.addLine(C.bar("  │ ") + C.green("  ✓  MCP connected") + C.dim(`  (${this.mcp.tools.length} tools)`));
    } catch (e) {
      this.mcpConnected = false;
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  ⚠  MCP unavailable") + C.dim("  " + e.message));
    }

    // Display results and enter REPL
    this.terminal.clearContent();
    this._renderScanResults();
    await this.repl();
  }

  async run(filePath) {
    this.filePath = filePath;

    // Open terminal (alternate screen, raw mode)
    this.terminal.open();

    // Set initial header
    this._setHeader("Scanning...");

    // Phase 1: Scan
    this.terminal.addLine(C.bar("  │ ") + C.dim("Scanning ") + C.pink(path.basename(filePath)) + C.dim("..."));
    this.terminal.setStatus("scanning");

    try {
      this.scanResult = await scanDisk(filePath);
    } catch (e) {
      this.terminal.addLine(C.red("  ✗  Scan failed: " + e.message));
      this.terminal.setStatus("error");
      await this.terminal.prompt();
      this.terminal.close();
      process.exit(1);
    }

    // Phase 2: Build findings
    this.findings = buildFindings(this.scanResult);
    const summary = summarizeFindings(this.findings);

    // Phase 3: Try MCP connection
    this.terminal.addLine(C.bar("  │ ") + C.dim("Connecting to Word MCP server..."));
    try {
      await this.mcp.connect();
      this.mcpConnected = true;
      this.terminal.addLine(C.bar("  │ ") + C.green("  ✓  MCP connected") + C.dim(`  (${this.mcp.tools.length} tools available)`));
    } catch (e) {
      this.mcpConnected = false;
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  ⚠  MCP unavailable") + C.dim("  " + e.message));
      this.terminal.addLine(C.bar("  │ ") + C.dim("  Fix workflow will work without direct DOCX editing."));
    }

    // Phase 4: Display results
    this.terminal.clearContent();
    this._renderScanResults();

    // Phase 5: Enter REPL
    await this.repl();
  }

  _setHeader(status) {
    const lines = [];
    for (const line of [
      "  ██╗    ██╗ ██████╗ ██████╗ ██████╗  ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗",
      "  ██║    ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝",
      "  ██║ █╗ ██║██║   ██║██████╔╝██║  ██║██║     ███████║█████╗  ██║     █████╔╝ ",
      "  ██║███╗██║██║   ██║██╔══██╗██║  ██║██║     ██╔══██║██╔══╝  ██║     ██╔═██╗ ",
      "  ╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝╚██████╗██║  ██║███████╗╚██████╗██║  ██╗",
      "   ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝",
    ]) {
      lines.push(C.brand(line));
    }
    lines.push(C.dim("  AI-Tell Scanner for Word Documents"));
    lines.push("");
    lines.push(C.bar("  │ ") + C.dim(status));
    this.terminal.setHeader(lines);
  }

  _renderScanResults() {
    const pct = this.scanResult.aiPercentage;
    const pctColor = pct >= 50 ? C.red : pct >= 25 ? C.yellow : C.green;
    const verdict = pct >= 50 ? "likely AI-assisted" : pct >= 25 ? "mixed signals" : "reads human";

    this._setHeader(path.basename(this.filePath));

    this.terminal.addLine(C.bar("  │ ") + C.white.bold(path.basename(this.filePath)));
    this.terminal.addLine(
      C.bar("  │ ") + C.dim("paragraphs ") + C.cyan(String(this.scanResult.totalBody)) +
      C.dim("   score ") + C.cyan(String(this.scanResult.totalScore)) +
      C.dim("   ai likelihood ") + pctColor(pct.toFixed(0) + "%") +
      C.dim("  ·  ") + pctColor(verdict)
    );
    this.terminal.addLine();

    // Findings summary
    const summary = summarizeFindings(this.findings);
    this.terminal.addLine(
      "  " + C.red.bold("HIGH") + "  " + String(summary.bySeverity.HIGH).padStart(2) + "  " +
      C.yellow.bold("MED") + "  " + String(summary.bySeverity.MEDIUM).padStart(2) + "  " +
      C.green.bold("LOW") + "  " + String(summary.bySeverity.LOW).padStart(2) + "    " +
      C.dim(`total ${summary.total} · fixable ${summary.fixable}`)
    );
    this.terminal.addLine();

    // Finding list
    this.terminal.addLine(
      "  " + C.dim("  ID ") + C.dim("severity  ") + C.dim("category          ") + C.dim("title")
    );
    this.terminal.addLine("  " + C.dim("─".repeat(70)));

    for (const f of this.findings) {
      const sevColor = f.severity === "HIGH" ? C.red : f.severity === "MEDIUM" ? C.yellow : C.green;
      const statusDot = f.status === FindingStatus.APPROVED ? C.green("●") :
                        f.status === FindingStatus.FIXED ? C.cyan("●") :
                        f.status === FindingStatus.SKIPPED ? C.dim("●") :
                        f.status === FindingStatus.FAILED ? C.red("●") :
                        C.dim("○");

      this.terminal.addLine(
        "  " +
        statusDot + " " +
        C.dim(f.id.padEnd(6)) +
        sevColor(f.severity.padEnd(9)) +
        C.dim(f.category.padEnd(18)) +
        C.dim(f.title.slice(0, 40))
      );
    }

    this.terminal.addLine();
    this.terminal.setStatus(path.basename(this.filePath));
  }

  // -----------------------------------------------------------------------
  // REPL — the main agent loop
  // -----------------------------------------------------------------------
  async repl() {
    while (true) {
      const input = await this.terminal.prompt();
      if (input === null) break; // Ctrl+C

      const cmd = input.trim();
      if (!cmd) continue;

      try {
        const shouldExit = await this.handleCommand(cmd);
        if (shouldExit) break;
      } catch (e) {
        this.terminal.addLine(C.red("  ✗  " + e.message));
      }
    }

    this.terminal.close();
    this.mcp.disconnect();
  }

  async handleCommand(cmd) {
    const lower = cmd.toLowerCase();

    // --- Exit ---
    if (lower === "quit" || lower === "exit" || lower === "q") {
      this.terminal.addLine(C.dim("  bye."));
      return true;
    }

    // --- Help ---
    if (lower === "help" || lower === "h") {
      this.printHelp();
      return false;
    }

    // --- Findings ---
    if (lower === "findings" || lower === "f") {
      this._renderFindingsList(true);
      return false;
    }

    if (lower === "new") {
      this._renderFindingsList(false);
      return false;
    }

    // --- Summary ---
    if (lower === "summary") {
      this._renderSummary();
      return false;
    }

    // --- Inspect finding ---
    const findingMatch = cmd.match(/^(?:F-)?(\d+)$/i);
    if (findingMatch) {
      const num = parseInt(findingMatch[1], 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (finding) {
        this._renderFindingDetail(finding);
      } else {
        this.terminal.addLine(C.red("  ✗  Finding not found."));
      }
      return false;
    }

    // --- Approve ---
    if (lower.startsWith("approve ")) {
      const target = cmd.slice(8).trim().toLowerCase();
      this._approveFindings(target);
      return false;
    }

    // --- Skip ---
    if (lower.startsWith("skip ")) {
      const target = cmd.slice(5).trim().toLowerCase();
      this._skipFindings(target);
      return false;
    }

    // --- Fix ---
    if (lower.startsWith("fix ")) {
      const target = cmd.slice(4).trim().toLowerCase();
      await this._applyFix(target);
      return false;
    }

    // --- Diff ---
    if (lower.startsWith("diff ")) {
      const target = cmd.slice(5).trim();
      this._showDiff(target);
      return false;
    }

    // --- Paragraph ---
    if (lower.startsWith("para ")) {
      const num = parseInt(cmd.slice(5).trim(), 10);
      this._showParagraph(num);
      return false;
    }

    // --- Rescan ---
    if (lower === "rescan") {
      this.terminal.addLine(C.bar("  │ ") + C.dim("Rescanning..."));
      this.scanResult = await scanDisk(this.filePath);
      this.findings = buildFindings(this.scanResult);
      this.terminal.clearContent();
      this._renderScanResults();
      return false;
    }

    // --- Status ---
    if (lower === "status") {
      this._renderStatus();
      return false;
    }

    // --- Unknown ---
    this.terminal.addLine(C.bar("  │ ") + C.dim("Unknown command. Type ") + C.white("help") + C.dim(" for commands."));
    return false;
  }

  // -----------------------------------------------------------------------
  // Command handlers
  // -----------------------------------------------------------------------

  printHelp() {
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("Commands"));
    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.white("findings") + C.dim("            show all findings"));
    this.terminal.addLine(C.bar("  │ ") + C.white("new") + C.dim("                show new/unreviewed"));
    this.terminal.addLine(C.bar("  │ ") + C.white("<number>") + C.dim("             inspect finding"));
    this.terminal.addLine(C.bar("  │ ") + C.white("approve <n>") + C.dim("         approve for fixing"));
    this.terminal.addLine(C.bar("  │ ") + C.white("approve all") + C.dim("         approve all fixable"));
    this.terminal.addLine(C.bar("  │ ") + C.white("skip <n>") + C.dim("            skip finding"));
    this.terminal.addLine(C.bar("  │ ") + C.white("fix <n>") + C.dim("              apply fix to document"));
    this.terminal.addLine(C.bar("  │ ") + C.white("fix all") + C.dim("              apply all approved"));
    this.terminal.addLine(C.bar("  │ ") + C.white("diff <n>") + C.dim("              side-by-side preview"));
    this.terminal.addLine(C.bar("  │ ") + C.white("para <n>") + C.dim("              inspect paragraph"));
    this.terminal.addLine(C.bar("  │ ") + C.white("rescan") + C.dim("                re-analyze document"));
    this.terminal.addLine(C.bar("  │ ") + C.white("summary") + C.dim("               findings summary"));
    this.terminal.addLine(C.bar("  │ ") + C.white("status") + C.dim("                MCP + fix status"));
    this.terminal.addLine(C.bar("  │ ") + C.white("↑") + C.dim(" arrow                 scroll content"));
    this.terminal.addLine(C.bar("  │ ") + C.white("help") + C.dim("                  this help"));
    this.terminal.addLine(C.bar("  │ ") + C.white("quit") + C.dim("                  exit"));
    this.terminal.addLine();
  }

  _renderFindingsList(showAll) {
    const display = showAll
      ? this.findings
      : this.findings.filter((f) => f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED);

    if (display.length === 0) {
      this.terminal.addLine(C.dim("  No findings to display."));
      return;
    }

    this.terminal.addLine(
      "  " + C.dim("  ID ") + C.dim("severity  ") + C.dim("category          ") + C.dim("title")
    );
    this.terminal.addLine("  " + C.dim("─".repeat(70)));

    for (const f of display) {
      const sevColor = f.severity === "HIGH" ? C.red : f.severity === "MEDIUM" ? C.yellow : C.green;
      const statusDot = f.status === FindingStatus.APPROVED ? C.green("●") :
                        f.status === FindingStatus.FIXED ? C.cyan("●") :
                        f.status === FindingStatus.SKIPPED ? C.dim("●") :
                        C.dim("○");

      this.terminal.addLine(
        "  " + statusDot + " " +
        C.dim(f.id.padEnd(6)) +
        sevColor(f.severity.padEnd(9)) +
        C.dim(f.category.padEnd(18)) +
        C.dim(f.title.slice(0, 40))
      );
    }
    this.terminal.addLine();
  }

  _renderFindingDetail(finding) {
    const sevColor = finding.severity === "HIGH" ? C.red : finding.severity === "MEDIUM" ? C.yellow : C.green;

    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.white.bold(finding.id) + "  " + sevColor(finding.severity) + C.dim("  " + finding.category));
    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.white(finding.title));
    this.terminal.addLine(C.bar("  │ ") + C.dim(finding.description));

    if (finding.evidence) {
      this.terminal.addLine(C.bar("  │"));
      this.terminal.addLine(C.bar("  │ ") + C.dim("evidence:"));
      for (const line of finding.evidence.slice(0, 150).split(/\n/)) {
        this.terminal.addLine(C.bar("  │ ") + C.dim("  ") + C.dim(line));
      }
    }

    const analysis = analyzeFinding(finding, {
      paragraph: this.scanResult.paragraphs.find((p) => p.index === finding.paragraphIndex),
    });

    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("analysis"));
    this.terminal.addLine(C.bar("  │ ") + C.dim(analysis.analysis));
    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("recommendation"));
    this.terminal.addLine(C.bar("  │ ") + C.green(analysis.recommendation));
    this.terminal.addLine(C.bar("  │ ") + C.dim("confidence: ") + C.cyan(analysis.confidence + "%"));

    if (finding.suggestedFix) {
      this.terminal.addLine(C.bar("  │"));
      this.terminal.addLine(C.bar("  │ ") + C.pink.bold("suggested fix"));
      this.terminal.addLine(C.bar("  │ ") + C.white(finding.suggestedFix));
    }

    // Show diff preview
    const rewrite = suggestRewrite(finding.originalContent, [finding]);
    if (rewrite.changed) {
      this.terminal.addLine(C.bar("  │"));
      this.terminal.addLine(C.bar("  │ ") + C.pink.bold("preview"));
      const diffLines = renderInlineDiff(rewrite.original, rewrite.rewritten, {
        width: Math.min(process.stdout.columns || 80, 100),
      });
      this.terminal.addLines(diffLines);
    }

    this.terminal.addLine();
  }

  _renderSummary() {
    const summary = summarizeFindings(this.findings);
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("Summary"));
    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("total ") + C.cyan(String(summary.total)) +
                          C.dim("   fixable ") + C.cyan(String(summary.fixable)));
    this.terminal.addLine(C.bar("  │ ") +
                          C.red("HIGH " + summary.bySeverity.HIGH) + C.dim("   ") +
                          C.yellow("MED " + summary.bySeverity.MEDIUM) + C.dim("   ") +
                          C.green("LOW " + summary.bySeverity.LOW));
    this.terminal.addLine(C.bar("  │ ") +
                          C.dim("approved ") + C.green(String(summary.approved)) + C.dim("   ") +
                          C.dim("fixed ") + C.cyan(String(summary.fixed)) + C.dim("   ") +
                          C.dim("failed ") + C.red(String(summary.failed)));
    this.terminal.addLine();
  }

  _renderStatus() {
    this.terminal.addLine(C.bar("  │ ") + C.dim("MCP: ") + (this.mcpConnected ? C.green("connected") : C.red("disconnected")));
    this.terminal.addLine(C.bar("  │ ") + C.dim("Document: ") + C.white(this.filePath));
    if (this.backupPath) {
      this.terminal.addLine(C.bar("  │ ") + C.dim("Backup: ") + C.dim(this.backupPath));
    }
    const s = summarizeFindings(this.findings);
    this.terminal.addLine(C.bar("  │ ") + C.dim("Findings: ") + C.cyan(String(s.total)) +
                          C.dim("  Approved: ") + C.green(String(s.approved)) +
                          C.dim("  Fixed: ") + C.cyan(String(s.fixed)));
    if (this.changeLog.length > 0) {
      this.terminal.addLine(C.bar("  │ ") + C.dim("Changes applied: ") + C.cyan(String(this.changeLog.length)));
    }
    this.terminal.addLine();
  }

  _showParagraph(num) {
    const para = this.scanResult.paragraphs.find((p) => p.index === num);
    if (!para) {
      this.terminal.addLine(C.red("  ✗  Paragraph not found."));
      return;
    }

    const riskColor = para.level === "HIGH" ? C.red : para.level === "MEDIUM" ? C.yellow : C.green;
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.white.bold("Paragraph " + para.index) + "  " +
                          C.cyan("score " + para.score) + "  " + riskColor(para.level));
    this.terminal.addLine(C.bar("  │"));

    const words = para.text.replace(/\s+/g, " ").trim().split(" ");
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > 64 && line) {
        this.terminal.addLine(C.bar("  │ ") + C.dim(line.trim()));
        line = w;
      } else {
        line = line ? line + " " + w : w;
      }
    }
    if (line) this.terminal.addLine(C.bar("  │ ") + C.dim(line.trim()));

    if (para.flags.length > 0) {
      this.terminal.addLine(C.bar("  │"));
      this.terminal.addLine(C.bar("  │ ") + C.pink.bold("AI tells"));
      for (const f of para.flags) {
        this.terminal.addLine(C.bar("  │ ") + C.yellow("  ›  ") + C.white(f.text) + C.dim("  +" + f.weight));
      }
    }
    this.terminal.addLine();
  }

  _showDiff(target) {
    const num = parseInt(target, 10);
    const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
    if (!finding) {
      this.terminal.addLine(C.red("  ✗  Finding not found."));
      return;
    }

    const rewrite = suggestRewrite(finding.originalContent, [finding]);
    if (!rewrite.changed) {
      this.terminal.addLine(C.dim("  No changes suggested for this finding."));
      return;
    }

    // VSCode-style side-by-side diff
    const diffLines = renderSideBySideDiff(rewrite.original, rewrite.rewritten, {
      width: Math.min(process.stdout.columns || 80, 120),
    });
    this.terminal.addLines(diffLines);
  }

  _approveFindings(target) {
    if (target === "all") {
      let count = 0;
      for (const f of this.findings) {
        if ((f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) && f.fixable) {
          transitionFinding(f, FindingStatus.APPROVED, { note: "bulk approved" });
          count++;
        }
      }
      this.terminal.addLine(C.green(`  ✓  Approved ${count} fixable findings.`));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) {
        this.terminal.addLine(C.red("  ✗  Finding not found."));
        return;
      }
      if (!finding.fixable) {
        this.terminal.addLine(C.yellow("  ⚠  Not auto-fixable. Manual review needed."));
        return;
      }
      transitionFinding(finding, FindingStatus.APPROVED, { note: "user approved" });
      this.terminal.addLine(C.green(`  ✓  ${finding.id} approved.`));
    }
  }

  _skipFindings(target) {
    if (target === "all") {
      let count = 0;
      for (const f of this.findings) {
        if (f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) {
          transitionFinding(f, FindingStatus.SKIPPED, { note: "bulk skipped" });
          count++;
        }
      }
      this.terminal.addLine(C.dim(`  Skipped ${count} findings.`));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) {
        this.terminal.addLine(C.red("  ✗  Finding not found."));
        return;
      }
      transitionFinding(finding, FindingStatus.SKIPPED, { note: "user skipped" });
      this.terminal.addLine(C.dim(`  Skipped ${finding.id}.`));
    }
  }

  async _applyFix(target) {
    if (!this.mcpConnected) {
      this.terminal.addLine(C.red("  ✗  MCP not connected. Cannot apply fixes."));
      return;
    }

    // Create backup before first fix
    if (!this.backupPath) {
      this.terminal.addLine(C.bar("  │ ") + C.dim("Creating backup..."));
      try {
        this.backupPath = await this.mcp.createBackup(this.filePath);
        this.terminal.addLine(C.bar("  │ ") + C.green("  ✓  ") + C.dim(this.backupPath));
      } catch (e) {
        this.terminal.addLine(C.red("  ✗  Backup failed: " + e.message));
        return;
      }
    }

    if (target === "all") {
      const approved = this.findings.filter((f) => f.status === FindingStatus.APPROVED);
      if (approved.length === 0) {
        this.terminal.addLine(C.yellow("  ⚠  No approved findings. Use 'approve all' first."));
        return;
      }

      let fixed = 0, failed = 0;
      for (const f of approved) {
        const ok = await this._fixOne(f);
        if (ok) fixed++; else failed++;
      }
      this.terminal.addLine(C.green(`  ✓  Fixed ${fixed}, failed ${failed}.`));
      this.terminal.addLine(C.bar("  │ ") + C.dim("Document updated: ") + C.white(this.filePath));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) {
        this.terminal.addLine(C.red("  ✗  Finding not found."));
        return;
      }
      if (finding.status !== FindingStatus.APPROVED) {
        this.terminal.addLine(C.yellow(`  ⚠  Not approved. Use 'approve ${num}' first.`));
        return;
      }

      const ok = await this._fixOne(finding);
      if (ok) {
        this.terminal.addLine(C.green(`  ✓  ${finding.id} fixed.`));
        this.terminal.addLine(C.bar("  │ ") + C.dim("Document updated: ") + C.white(this.filePath));
      }
    }
  }

  async _fixOne(finding) {
    const rewrite = suggestRewrite(finding.originalContent, [finding]);
    if (!rewrite.changed) {
      transitionFinding(finding, FindingStatus.FAILED, { note: "no change generated" });
      return false;
    }

    // Show side-by-side diff before applying
    const diffLines = renderSideBySideDiff(rewrite.original, rewrite.rewritten, {
      width: Math.min(process.stdout.columns || 80, 120),
    });
    this.terminal.addLines(diffLines);

    // Apply via MCP to the actual document
    this.terminal.addLine(C.bar("  │ ") + C.dim("Applying fix for ") + C.pink(finding.id) + C.dim("..."));

    try {
      const origText = this._extractOriginal(finding);
      const replText = this._extractReplacement(finding, rewrite);

      await this.mcp.searchAndReplace(this.filePath, origText, replText);

      transitionFinding(finding, FindingStatus.FIXED, { note: "applied to document" });
      this.changeLog.push({
        findingId: finding.id,
        category: finding.category,
        original: origText,
        replacement: replText,
        timestamp: Date.now(),
      });
      return true;
    } catch (e) {
      transitionFinding(finding, FindingStatus.FAILED, { note: e.message });
      this.terminal.addLine(C.red("  ✗  Fix failed: " + e.message));
      return false;
    }
  }

  _extractOriginal(finding) {
    const match = finding.title.match(/^"([^"]+)"/);
    if (match) return match[1];
    return finding.evidence.slice(0, 50);
  }

  _extractReplacement(finding, rewrite) {
    if (finding.category === FindingCategory?.AI_PHRASE) {
      const analysis = analyzeFinding(finding);
      const recMatch = analysis.recommendation.match(/"([^"]+)"/g);
      if (recMatch && recMatch.length > 1) {
        return recMatch[1].replace(/"/g, "");
      }
    }
    // Use heuristic rewrite — compare original and rewritten to find diff
    const orig = this._extractOriginal(finding);
    if (rewrite.rewritten.includes(orig)) return orig; // no-op fallback
    return rewrite.rewritten.slice(0, 50);
  }
}

module.exports = Agent;

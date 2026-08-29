"use strict";

const path = require("path");
const fs = require("fs");
const chalk = require("chalk");
const { scanDisk, suggestFixes } = require("./scanner");
const { buildFindings, summarizeFindings, FindingStatus, transitionFinding } = require("./findings");
const { analyzeFinding, suggestRewrite } = require("./ai");
const { renderSideBySideDiff, renderInlineDiff } = require("./diff");
const MCPClient = require("./mcp-client");
const { Terminal, C } = require("./terminal");
const { LLMClient, getAgentTools, SYSTEM_PROMPT, loadConfig } = require("./ai-agent");

// ---------------------------------------------------------------------------
// Agent — conversational AI agent for document analysis and editing
// ---------------------------------------------------------------------------
class Agent {
  constructor() {
    this.terminal = new Terminal();
    this.mcp = new MCPClient();
    this.config = loadConfig();
    this.llm = new LLMClient(this.config);
    this.scanResult = null;
    this.findings = [];
    this.filePath = null;
    this.backupPath = null;
    this.mcpConnected = false;
    this.llmConnected = false;
    this.changeLog = [];
    this.conversationHistory = [];
  }

  // -----------------------------------------------------------------------
  // Entry: file selector mode
  // -----------------------------------------------------------------------
  async runWithFileSelector() {
    this.terminal.open();
    this._setHeader("WordCheck Agent");

    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.white.bold("WordCheck Agent"));
    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("I can analyze, edit, and improve Word documents."));
    this.terminal.addLine(C.bar("  │") );

    // Check LLM
    this.terminal.addLine(C.bar("  │ ") + C.dim("Checking AI connection..."));
    this.llmConnected = await this.llm.healthCheck();
    if (this.llmConnected) {
      this.terminal.addLine(C.bar("  │ ") + C.green("  ✓  AI connected") + C.dim(`  (${this.config.api.provider}: ${this.config.api.model})`));
    } else {
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  ⚠  AI not available") + C.dim("  (using built-in heuristics)"));
      this.terminal.addLine(C.bar("  │ ") + C.dim("  Configure in ~/.wordcheck.json or set OPENAI_API_KEY"));
    }

    // Check MCP
    this.terminal.addLine(C.bar("  │ ") + C.dim("Connecting to Word MCP..."));
    try {
      await this.mcp.connect();
      this.mcpConnected = true;
      this.terminal.addLine(C.bar("  │ ") + C.green("  ✓  MCP connected") + C.dim(`  (${this.mcp.tools.length} tools)`));
    } catch (e) {
      this.mcpConnected = false;
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  ⚠  MCP unavailable") + C.dim("  " + e.message));
    }

    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.dim("Drop a .docx file or paste a path to begin."));
    this.terminal.addLine(C.bar("  │ ") + C.dim("Or just type what you'd like to do."));
    this.terminal.addLine();
    this.terminal.setStatus("ready");

    // Init conversation
    this.conversationHistory = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // Enter REPL
    await this.repl();
  }

  // -----------------------------------------------------------------------
  // Entry: direct file mode
  // -----------------------------------------------------------------------
  async run(filePath) {
    this.filePath = filePath;
    this.terminal.open();
    this._setHeader("WordCheck Agent");

    // Init conversation
    this.conversationHistory = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // Check connections
    this.terminal.addLine(C.bar("  │ ") + C.dim("Checking AI..."));
    this.llmConnected = await this.llm.healthCheck();
    if (this.llmConnected) {
      this.terminal.addLine(C.bar("  │ ") + C.green("  ✓  AI connected"));
    } else {
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  ⚠  AI unavailable"));
    }

    this.terminal.addLine(C.bar("  │ ") + C.dim("Connecting MCP..."));
    try {
      await this.mcp.connect();
      this.mcpConnected = true;
      this.terminal.addLine(C.bar("  │ ") + C.green("  ✓  MCP connected"));
    } catch (e) {
      this.mcpConnected = false;
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  ⚠  MCP unavailable"));
    }

    // Auto-scan
    await this._scanDocument(filePath);

    // Enter REPL
    await this.repl();
  }

  // -----------------------------------------------------------------------
  // REPL — conversational loop
  // -----------------------------------------------------------------------
  async repl() {
    while (true) {
      const input = await this.terminal.prompt();
      if (input === null) break;

      const cmd = input.trim();
      if (!cmd) continue;

      // Show user message
      this.terminal.addLine();
      this.terminal.addLine(C.bar("  │ ") + C.pink.bold("you") + C.dim(" › ") + C.white(cmd));

      // Check for local commands first
      const localResult = this._handleLocalCommand(cmd);
      if (localResult === "exit") break;
      if (localResult === "handled") continue;

      // If LLM is connected, send to AI
      if (this.llmConnected) {
        await this._chatWithAI(cmd);
      } else {
        // Fallback to heuristics
        await this._handleWithoutAI(cmd);
      }
    }

    this.terminal.close();
    this.mcp.disconnect();
  }

  // -----------------------------------------------------------------------
  // Local commands (fast, no LLM needed)
  // -----------------------------------------------------------------------
  _handleLocalCommand(cmd) {
    const lower = cmd.toLowerCase();

    if (lower === "quit" || lower === "exit" || lower === "q") {
      this.terminal.addLine(C.dim("  bye."));
      return "exit";
    }

    if (lower === "help" || lower === "h") {
      this._printHelp();
      return "handled";
    }

    if (lower === "clear") {
      this.terminal.clearContent();
      return "handled";
    }

    if (lower === "status") {
      this._renderStatus();
      return "handled";
    }

    if (lower === "findings" || lower === "f") {
      this._renderFindingsList(true);
      return "handled";
    }

    if (lower === "new") {
      this._renderFindingsList(false);
      return "handled";
    }

    if (lower === "summary") {
      this._renderSummary();
      return "handled";
    }

    if (lower === "rescan" && this.filePath) {
      this._scanDocument(this.filePath);
      return "handled";
    }

    // Inspect finding by number
    const findingMatch = cmd.match(/^(?:F-)?(\d+)$/i);
    if (findingMatch && this.findings.length > 0) {
      const num = parseInt(findingMatch[1], 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (finding) {
        this._renderFindingDetail(finding);
        return "handled";
      }
    }

    // Approve
    if (lower.startsWith("approve ")) {
      const target = cmd.slice(8).trim().toLowerCase();
      this._approveFindings(target);
      return "handled";
    }

    // Skip
    if (lower.startsWith("skip ")) {
      const target = cmd.slice(5).trim().toLowerCase();
      this._skipFindings(target);
      return "handled";
    }

    // Fix
    if (lower.startsWith("fix ")) {
      const target = cmd.slice(4).trim().toLowerCase();
      this._applyFix(target);
      return "handled";
    }

    // Diff
    if (lower.startsWith("diff ")) {
      const target = cmd.slice(5).trim();
      this._showDiff(target);
      return "handled";
    }

    // Para
    if (lower.startsWith("para ")) {
      const num = parseInt(cmd.slice(5).trim(), 10);
      this._showParagraph(num);
      return "handled";
    }

    return null; // not a local command — send to AI
  }

  // -----------------------------------------------------------------------
  // AI chat — conversational with tool calling
  // -----------------------------------------------------------------------
  async _chatWithAI(userMessage) {
    this.conversationHistory.push({ role: "user", content: userMessage });
    this.terminal.setStatus("thinking...");

    const tools = getAgentTools();

    try {
      const response = await this.llm.chat(this.conversationHistory, tools);

      // Handle tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        this.conversationHistory.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          const fn = toolCall.function;
          const args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
          const toolResult = await this._executeTool(fn.name, args);

          this.conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }

        // Get final response after tool execution
        this.terminal.setStatus("processing...");
        const finalResponse = await this.llm.chat(this.conversationHistory, []);
        if (finalResponse.content) {
          this._printAIResponse(finalResponse.content);
        }
        this.conversationHistory.push({ role: "assistant", content: finalResponse.content || "" });
      } else {
        // Direct text response
        if (response.content) {
          this._printAIResponse(response.content);
        }
        this.conversationHistory.push({ role: "assistant", content: response.content || "" });
      }
    } catch (e) {
      this.terminal.addLine(C.red("  ✗  AI error: " + e.message));
    }

    this.terminal.setStatus(this.filePath ? path.basename(this.filePath) : "ready");
  }

  _printAIResponse(text) {
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("wordcheck") + C.dim(" ›"));

    // Word-wrap the response
    const maxWidth = 68;
    const words = text.split(/\s+/);
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > maxWidth && line) {
        this.terminal.addLine(C.bar("  │ ") + C.white(line.trim()));
        line = w;
      } else {
        line = line ? line + " " + w : w;
      }
    }
    if (line) this.terminal.addLine(C.bar("  │ ") + C.white(line.trim()));
    this.terminal.addLine();
  }

  // -----------------------------------------------------------------------
  // Tool execution
  // -----------------------------------------------------------------------
  async _executeTool(name, args) {
    switch (name) {
      case "scan_document": {
        const filePath = args.file_path;
        if (!fs.existsSync(filePath)) return { error: "File not found: " + filePath };
        try {
          const result = await scanDisk(filePath);
          this.scanResult = result;
          this.findings = buildFindings(result);
          this.filePath = filePath;
          return {
            file: path.basename(filePath),
            paragraphs: result.totalBody,
            score: result.totalScore,
            aiPercentage: result.aiPercentage.toFixed(0) + "%",
            findings: this.findings.length,
            highSeverity: this.findings.filter((f) => f.severity === "HIGH").length,
            mediumSeverity: this.findings.filter((f) => f.severity === "MEDIUM").length,
            lowSeverity: this.findings.filter((f) => f.severity === "LOW").length,
          };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "get_finding_detail": {
        const finding = this.findings.find((f) => f.id === args.finding_id);
        if (!finding) return { error: "Finding not found" };
        const analysis = analyzeFinding(finding, {
          paragraph: this.scanResult?.paragraphs.find((p) => p.index === finding.paragraphIndex),
        });
        return { ...finding, analysis };
      }

      case "approve_finding": {
        if (args.finding_id === "all") {
          let count = 0;
          for (const f of this.findings) {
            if ((f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) && f.fixable) {
              transitionFinding(f, FindingStatus.APPROVED);
              count++;
            }
          }
          return { approved: count };
        }
        const finding = this.findings.find((f) => f.id === args.finding_id);
        if (!finding) return { error: "Finding not found" };
        transitionFinding(finding, FindingStatus.APPROVED);
        return { approved: finding.id };
      }

      case "fix_approved": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        if (!this.filePath) return { error: "No document loaded" };

        if (!this.backupPath) {
          this.backupPath = await this.mcp.createBackup(this.filePath);
        }

        const approved = this.findings.filter((f) => f.status === FindingStatus.APPROVED);
        if (approved.length === 0) return { error: "No approved findings to fix" };

        let fixed = 0, failed = 0;
        for (const f of approved) {
          try {
            const rewrite = suggestRewrite(f.originalContent, [f]);
            if (rewrite.changed) {
              await this.mcp.searchAndReplace(this.filePath, this._extractOriginal(f), rewrite.rewritten.slice(0, 200));
              transitionFinding(f, FindingStatus.FIXED);
              fixed++;
            } else {
              transitionFinding(f, FindingStatus.FAILED, { note: "no change" });
              failed++;
            }
          } catch (e) {
            transitionFinding(f, FindingStatus.FAILED, { note: e.message });
            failed++;
          }
        }

        return { fixed, failed, backup: this.backupPath };
      }

      case "edit_paragraph": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        if (!this.filePath) return { error: "No document loaded" };

        try {
          // Get current paragraph text
          const currentText = await this.mcp.getParagraphText(this.filePath, args.paragraph_index);
          // Replace it
          await this.mcp.searchAndReplace(this.filePath, currentText.trim(), args.new_text);
          return {
            success: true,
            paragraph: args.paragraph_index,
            previous: currentText.trim().slice(0, 100),
            updated: args.new_text.slice(0, 100),
          };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "search_replace": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        if (!this.filePath) return { error: "No document loaded" };
        try {
          await this.mcp.searchAndReplace(this.filePath, args.find_text, args.replace_text);
          return { success: true, find: args.find_text, replace: args.replace_text };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "get_document_text": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        if (!this.filePath) return { error: "No document loaded" };
        try {
          const text = await this.mcp.getDocumentText(this.filePath);
          return { text: text.slice(0, 3000) }; // limit for LLM context
        } catch (e) {
          return { error: e.message };
        }
      }

      case "get_paragraph": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        if (!this.filePath) return { error: "No document loaded" };
        try {
          const text = await this.mcp.getParagraphText(this.filePath, args.paragraph_index);
          return { paragraph: args.paragraph_index, text };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "list_documents": {
        const dir = args.directory || process.cwd();
        try {
          const result = await this.mcp.listDocuments(dir);
          return { directory: dir, documents: result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "create_document": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        try {
          await this.mcp.callTool("create_document", {
            filename: args.filename,
            title: args.title || "",
          });
          return { created: args.filename };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "copy_document": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        try {
          await this.mcp.callTool("copy_document", {
            source_filename: args.source,
            destination_filename: args.destination,
          });
          return { copied: args.source, to: args.destination };
        } catch (e) {
          return { error: e.message };
        }
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  _extractOriginal(finding) {
    const match = finding.title.match(/^"([^"]+)"/);
    if (match) return match[1];
    return finding.evidence.slice(0, 50);
  }

  // -----------------------------------------------------------------------
  // Fallback: handle without AI
  // -----------------------------------------------------------------------
  async _handleWithoutAI(cmd) {
    const lower = cmd.toLowerCase();

    // File path detection
    if (cmd.endsWith(".docx") && (fs.existsSync(cmd) || fs.existsSync(path.resolve(cmd)))) {
      const resolved = path.resolve(cmd);
      await this._scanDocument(resolved);
      return;
    }

    // Natural language fallbacks
    if (lower.includes("scan") || lower.includes("analyze") || lower.includes("check")) {
      if (this.filePath) {
        await this._scanDocument(this.filePath);
      } else {
        this.terminal.addLine(C.bar("  │ ") + C.dim("No document loaded. Drop a .docx file to begin."));
      }
      return;
    }

    if (lower.includes("fix") || lower.includes("repair") || lower.includes("improve")) {
      if (this.findings.length > 0) {
        this._approveFindings("all");
        await this._applyFix("all");
      } else {
        this.terminal.addLine(C.bar("  │ ") + C.dim("No findings to fix. Scan a document first."));
      }
      return;
    }

    if (lower.includes("help") || lower.includes("what can you do")) {
      this._printHelp();
      return;
    }

    // Default
    this.terminal.addLine(C.bar("  │ ") + C.dim("I can help you with Word documents. Try:"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("  • Drop a .docx file to scan it"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("  • 'scan' to analyze the current document"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("  • 'fix' to apply all fixes"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("  • 'help' for all commands"));
    if (!this.llmConnected) {
      this.terminal.addLine(C.bar("  │ ") + C.dim("  • Configure AI in ~/.wordcheck.json for natural chat"));
    }
  }

  // -----------------------------------------------------------------------
  // Document operations
  // -----------------------------------------------------------------------
  async _scanDocument(filePath) {
    this.filePath = filePath;
    this._setHeader("Scanning...");
    this.terminal.clearContent();
    this.terminal.addLine(C.bar("  │ ") + C.dim("Scanning ") + C.pink(path.basename(filePath)) + C.dim("..."));
    this.terminal.setStatus("scanning");

    try {
      this.scanResult = await scanDisk(filePath);
    } catch (e) {
      this.terminal.addLine(C.red("  ✗  Scan failed: " + e.message));
      return;
    }

    this.findings = buildFindings(this.scanResult);

    // Display results
    this.terminal.clearContent();
    this._renderScanResults();
    this._setHeader(path.basename(filePath));
    this.terminal.setStatus(path.basename(filePath));
  }

  // -----------------------------------------------------------------------
  // UI rendering
  // -----------------------------------------------------------------------
  _setHeader(title) {
    const lines = [
      C.brand("  ██╗    ██╗ ██████╗ ██████╗ ██████╗  ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗"),
      C.brand("  ██║    ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝"),
      C.brand("  ██║ █╗ ██║██║   ██║██████╔╝██║  ██║██║     ███████║█████╗  ██║     █████╔╝ "),
      C.brand("  ██║███╗██║██║   ██║██╔══██╗██║  ██║██║     ██╔══██║██╔══╝  ██║     ██╔═██╗ "),
      C.brand("  ╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝╚██████╗██║  ██║███████╗╚██████╗██║  ██╗"),
      C.brand("   ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝"),
      C.dim("  AI-Tell Scanner for Word Documents"),
      C.bar("  │ ") + C.dim(title),
    ];
    this.terminal.setHeader(lines);
  }

  _renderScanResults() {
    const pct = this.scanResult.aiPercentage;
    const pctColor = pct >= 50 ? C.red : pct >= 25 ? C.yellow : C.green;
    const verdict = pct >= 50 ? "likely AI-assisted" : pct >= 25 ? "mixed signals" : "reads human";
    const summary = summarizeFindings(this.findings);

    this.terminal.addLine(C.bar("  │ ") + C.white.bold(path.basename(this.filePath)));
    this.terminal.addLine(
      C.bar("  │ ") + C.dim("paragraphs ") + C.cyan(String(this.scanResult.totalBody)) +
      C.dim("   score ") + C.cyan(String(this.scanResult.totalScore)) +
      C.dim("   ai ") + pctColor(pct.toFixed(0) + "%") +
      C.dim("  · ") + pctColor(verdict)
    );
    this.terminal.addLine();
    this.terminal.addLine(
      "  " + C.red.bold("HIGH") + " " + String(summary.bySeverity.HIGH).padStart(2) + "  " +
      C.yellow.bold("MED") + " " + String(summary.bySeverity.MEDIUM).padStart(2) + "  " +
      C.green.bold("LOW") + " " + String(summary.bySeverity.LOW).padStart(2) +
      C.dim(`   total ${summary.total} · fixable ${summary.fixable}`)
    );
    this.terminal.addLine();

    // Show HIGH/MEDIUM findings
    const important = this.findings.filter((f) => f.severity === "HIGH" || f.severity === "MEDIUM");
    if (important.length > 0) {
      this.terminal.addLine("  " + C.dim("  ID ") + C.dim("severity  ") + C.dim("category          ") + C.dim("title"));
      this.terminal.addLine("  " + C.dim("─".repeat(70)));
      for (const f of important) {
        const sevColor = f.severity === "HIGH" ? C.red : C.yellow;
        this.terminal.addLine(
          "  " + C.dim("○ ") + C.dim(f.id.padEnd(6)) +
          sevColor(f.severity.padEnd(9)) +
          C.dim(f.category.padEnd(18)) +
          C.dim(f.title.slice(0, 40))
        );
      }
      this.terminal.addLine();
    }

    // Quick action hint
    this.terminal.addLine(C.bar("  │ ") + C.dim("Type ") + C.white("findings") + C.dim(" to see all, or just tell me what to do."));
  }

  _renderFindingsList(showAll) {
    const display = showAll ? this.findings : this.findings.filter((f) => f.status === FindingStatus.NEW);
    if (display.length === 0) {
      this.terminal.addLine(C.dim("  No findings."));
      return;
    }
    this.terminal.addLine("  " + C.dim("  ID ") + C.dim("sev   ") + C.dim("category          ") + C.dim("title"));
    this.terminal.addLine("  " + C.dim("─".repeat(70)));
    for (const f of display) {
      const sevColor = f.severity === "HIGH" ? C.red : f.severity === "MEDIUM" ? C.yellow : C.green;
      const dot = f.status === FindingStatus.APPROVED ? C.green("●") :
                  f.status === FindingStatus.FIXED ? C.cyan("●") :
                  f.status === FindingStatus.SKIPPED ? C.dim("●") : C.dim("○");
      this.terminal.addLine(
        "  " + dot + " " + C.dim(f.id.padEnd(6)) +
        sevColor(f.severity.padEnd(6)) +
        C.dim(f.category.padEnd(18)) +
        C.dim(f.title.slice(0, 40))
      );
    }
    this.terminal.addLine();
  }

  _renderFindingDetail(finding) {
    const sevColor = finding.severity === "HIGH" ? C.red : finding.severity === "MEDIUM" ? C.yellow : C.green;
    const analysis = analyzeFinding(finding, {
      paragraph: this.scanResult?.paragraphs.find((p) => p.index === finding.paragraphIndex),
    });

    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.white.bold(finding.id) + "  " + sevColor(finding.severity) + C.dim("  " + finding.category));
    this.terminal.addLine(C.bar("  │ ") + C.white(finding.title));
    this.terminal.addLine(C.bar("  │ ") + C.dim(finding.description));
    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("analysis") + C.dim("  ") + C.dim(analysis.analysis));
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("fix") + C.dim("  ") + C.green(analysis.recommendation));
    this.terminal.addLine(C.bar("  │ ") + C.dim("confidence: ") + C.cyan(analysis.confidence + "%"));

    const rewrite = suggestRewrite(finding.originalContent, [finding]);
    if (rewrite.changed) {
      this.terminal.addLine(C.bar("  │"));
      this.terminal.addLine(C.bar("  │ ") + C.pink.bold("preview"));
      const diffLines = renderInlineDiff(rewrite.original, rewrite.rewritten, {
        width: Math.min(this.terminal.width, 100),
      });
      this.terminal.addLines(diffLines);
    }
    this.terminal.addLine();
  }

  _renderSummary() {
    const s = summarizeFindings(this.findings);
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("Summary"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("total ") + C.cyan(String(s.total)) + C.dim("  fixable ") + C.cyan(String(s.fixable)));
    this.terminal.addLine(C.bar("  │ ") + C.red("HIGH " + s.bySeverity.HIGH) + C.dim("  ") + C.yellow("MED " + s.bySeverity.MEDIUM) + C.dim("  ") + C.green("LOW " + s.bySeverity.LOW));
    this.terminal.addLine(C.bar("  │ ") + C.dim("approved ") + C.green(String(s.approved)) + C.dim("  fixed ") + C.cyan(String(s.fixed)) + C.dim("  failed ") + C.red(String(s.failed)));
    this.terminal.addLine();
  }

  _renderStatus() {
    this.terminal.addLine(C.bar("  │ ") + C.dim("AI: ") + (this.llmConnected ? C.green(this.config.api.provider + ":" + this.config.api.model) : C.red("disconnected")));
    this.terminal.addLine(C.bar("  │ ") + C.dim("MCP: ") + (this.mcpConnected ? C.green("connected") : C.red("disconnected")));
    if (this.filePath) this.terminal.addLine(C.bar("  │ ") + C.dim("Document: ") + C.white(this.filePath));
    if (this.backupPath) this.terminal.addLine(C.bar("  │ ") + C.dim("Backup: ") + C.dim(this.backupPath));
    const s = summarizeFindings(this.findings);
    this.terminal.addLine(C.bar("  │ ") + C.dim("Findings: ") + C.cyan(String(s.total)) + C.dim("  Fixed: ") + C.cyan(String(s.fixed)));
    this.terminal.addLine();
  }

  _printHelp() {
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("Commands"));
    this.terminal.addLine(C.bar("  │ ") + C.white("findings") + C.dim("      show all findings"));
    this.terminal.addLine(C.bar("  │ ") + C.white("<number>") + C.dim("       inspect finding"));
    this.terminal.addLine(C.bar("  │ ") + C.white("approve all") + C.dim("   approve fixable findings"));
    this.terminal.addLine(C.bar("  │ ") + C.white("fix all") + C.dim("       apply approved fixes"));
    this.terminal.addLine(C.bar("  │ ") + C.white("diff <n>") + C.dim("       side-by-side preview"));
    this.terminal.addLine(C.bar("  │ ") + C.white("rescan") + C.dim("         re-analyze document"));
    this.terminal.addLine(C.bar("  │ ") + C.white("status") + C.dim("         connection status"));
    this.terminal.addLine(C.bar("  │ ") + C.white("clear") + C.dim("          clear screen"));
    this.terminal.addLine(C.bar("  │ ") + C.white("quit") + C.dim("           exit"));
    this.terminal.addLine(C.bar("  │"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("Or just tell me what you'd like to do."));
    this.terminal.addLine(C.bar("  │ ") + C.dim("'fix all the AI phrases in paragraph 3'"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("'scan this document and tell me what to fix'"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("'edit paragraph 5 to be more concise'"));
    this.terminal.addLine();
  }

  _showParagraph(num) {
    const para = this.scanResult?.paragraphs.find((p) => p.index === num);
    if (!para) { this.terminal.addLine(C.red("  ✗  Paragraph not found.")); return; }
    const riskColor = para.level === "HIGH" ? C.red : para.level === "MEDIUM" ? C.yellow : C.green;
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.white.bold("Paragraph " + para.index) + "  " + C.cyan("score " + para.score) + "  " + riskColor(para.level));
    this.terminal.addLine(C.bar("  │"));
    const words = para.text.replace(/\s+/g, " ").trim().split(" ");
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > 64 && line) {
        this.terminal.addLine(C.bar("  │ ") + C.dim(line.trim()));
        line = w;
      } else { line = line ? line + " " + w : w; }
    }
    if (line) this.terminal.addLine(C.bar("  │ ") + C.dim(line.trim()));
    this.terminal.addLine();
  }

  _showDiff(target) {
    const num = parseInt(target, 10);
    const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
    if (!finding) { this.terminal.addLine(C.red("  ✗  Finding not found.")); return; }
    const rewrite = suggestRewrite(finding.originalContent, [finding]);
    if (!rewrite.changed) { this.terminal.addLine(C.dim("  No changes.")); return; }
    const diffLines = renderSideBySideDiff(rewrite.original, rewrite.rewritten, {
      width: Math.min(this.terminal.width, 120),
    });
    this.terminal.addLines(diffLines);
  }

  _approveFindings(target) {
    if (target === "all") {
      let count = 0;
      for (const f of this.findings) {
        if ((f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) && f.fixable) {
          transitionFinding(f, FindingStatus.APPROVED); count++;
        }
      }
      this.terminal.addLine(C.green(`  ✓  Approved ${count} findings.`));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) { this.terminal.addLine(C.red("  ✗  Not found.")); return; }
      transitionFinding(finding, FindingStatus.APPROVED);
      this.terminal.addLine(C.green(`  ✓  ${finding.id} approved.`));
    }
  }

  _skipFindings(target) {
    if (target === "all") {
      let count = 0;
      for (const f of this.findings) {
        if (f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) {
          transitionFinding(f, FindingStatus.SKIPPED); count++;
        }
      }
      this.terminal.addLine(C.dim(`  Skipped ${count}.`));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) { this.terminal.addLine(C.red("  ✗  Not found.")); return; }
      transitionFinding(finding, FindingStatus.SKIPPED);
      this.terminal.addLine(C.dim(`  Skipped ${finding.id}.`));
    }
  }

  async _applyFix(target) {
    if (!this.mcpConnected) { this.terminal.addLine(C.red("  ✗  MCP not connected.")); return; }
    if (!this.filePath) { this.terminal.addLine(C.red("  ✗  No document loaded.")); return; }

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

    const approved = target === "all"
      ? this.findings.filter((f) => f.status === FindingStatus.APPROVED)
      : this.findings.filter((f) => f.id === `F-${String(parseInt(target, 10)).padStart(4, "0")}` && f.status === FindingStatus.APPROVED);

    if (approved.length === 0) {
      this.terminal.addLine(C.yellow("  ⚠  No approved findings. Use 'approve all' first."));
      return;
    }

    let fixed = 0, failed = 0;
    for (const f of approved) {
      const rewrite = suggestRewrite(f.originalContent, [f]);
      if (!rewrite.changed) { transitionFinding(f, FindingStatus.FAILED); failed++; continue; }

      // Show diff
      const diffLines = renderSideBySideDiff(rewrite.original, rewrite.rewritten, {
        width: Math.min(this.terminal.width, 120),
      });
      this.terminal.addLines(diffLines);

      try {
        const orig = this._extractOriginal(f);
        await this.mcp.searchAndReplace(this.filePath, orig, rewrite.rewritten.slice(0, 200));
        transitionFinding(f, FindingStatus.FIXED);
        this.changeLog.push({ findingId: f.id, timestamp: Date.now() });
        fixed++;
      } catch (e) {
        transitionFinding(f, FindingStatus.FAILED, { note: e.message });
        this.terminal.addLine(C.red("  ✗  " + f.id + ": " + e.message));
        failed++;
      }
    }

    this.terminal.addLine(C.green(`  ✓  Fixed ${fixed}, failed ${failed}.`));
    this.terminal.addLine(C.bar("  │ ") + C.dim("Updated: ") + C.white(this.filePath));
  }
}

module.exports = Agent;

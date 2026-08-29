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
    this.terminal.addLine(C.bar("  │"));

    // Check LLM
    this.terminal.addLine(C.bar("  │ ") + C.dim("Checking AI..."));
    this.llmConnected = await this.llm.healthCheck();
    if (this.llmConnected) {
      this.terminal.addLine(C.bar("  │ ") + C.green("  ✓  AI connected") + C.dim(`  (${this.config.api.provider}: ${this.config.api.model})`));
    } else {
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  ⚠  AI not available") + C.dim("  (heuristics only)"));
    }

    // Check MCP
    this.terminal.addLine(C.bar("  │ ") + C.dim("Connecting MCP..."));
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
    this.terminal.addLine(C.bar("  │ ") + C.dim("Type /help for commands. Anything else is sent to AI."));
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
  // Local commands — all start with / to avoid confusion with AI input
  // -----------------------------------------------------------------------
  _handleLocalCommand(cmd) {
    const trimmed = cmd.trim();
    if (!trimmed.startsWith("/")) return null; // not a command — send to AI

    const parts = trimmed.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");

    switch (command) {
      case "quit":
      case "exit":
      case "q":
        this.terminal.addLine(C.dim("  bye."));
        return "exit";

      case "help":
      case "h":
        this._printHelp();
        return "handled";

      case "clear":
      case "cls":
        this.terminal.clearContent();
        return "handled";

      case "status":
        this._renderStatus();
        return "handled";

      case "findings":
      case "f":
        this._renderFindingsList(true);
        return "handled";

      case "new":
        this._renderFindingsList(false);
        return "handled";

      case "summary":
        this._renderSummary();
        return "handled";

      case "rescan":
        if (this.filePath) {
          this._scanDocument(this.filePath);
        } else {
          this.terminal.addLine(C.red("  ✗  No document loaded."));
        }
        return "handled";

      case "approve":
        this._approveFindings(args || "all");
        return "handled";

      case "skip":
        this._skipFindings(args || "all");
        return "handled";

      case "fix":
        if (!args) {
          this.terminal.addLine(C.yellow("  Usage: /fix <number> or /fix all"));
        } else {
          this._applyFix(args);
        }
        return "handled";

      case "diff":
        if (!args) {
          this.terminal.addLine(C.yellow("  Usage: /diff <finding-number>"));
        } else {
          this._showDiff(args);
        }
        return "handled";

      case "para":
      case "p":
        if (!args) {
          this.terminal.addLine(C.yellow("  Usage: /para <paragraph-number>"));
        } else {
          this._showParagraph(parseInt(args, 10));
        }
        return "handled";

      case "open":
        if (this.filePath) {
          const { exec } = require("child_process");
          exec(`start "" "${this.filePath}"`);
          this.terminal.addLine(C.green("  ✓  Opening ") + C.white(this.filePath));
        } else {
          this.terminal.addLine(C.red("  ✗  No document loaded."));
        }
        return "handled";

      case "file":
        if (this.filePath) {
          this.terminal.addLine(C.bar("  │ ") + C.white(this.filePath));
        } else {
          this.terminal.addLine(C.dim("  No document loaded."));
        }
        return "handled";

      default:
        this.terminal.addLine(C.dim("  Unknown command: /" + command + "  Type /help for commands."));
        return "handled";
    }
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
    const os = require("os");
    const { exec } = require("child_process");

    // Helper: resolve filename - use filePath if not provided
    const getFilename = () => args.filename || this.filePath;
    const docsFolder = path.join(os.homedir(), "Documents");

    switch (name) {
      // --- WordCheck analysis ---
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
            path: filePath,
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

        return { fixed, failed, backup: this.backupPath, document: this.filePath };
      }

      // --- MCP document tools ---
      case "create_document": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        try {
          // Default to Documents folder if just a filename
          let filePath = args.filename;
          if (!path.isAbsolute(filePath)) {
            filePath = path.join(docsFolder, filePath);
          }

          await this.mcp.callTool("create_document", {
            filename: filePath,
            title: args.title || "",
            author: args.author || "",
          });

          this.filePath = filePath;
          return {
            created: filePath,
            message: `Document created at ${filePath}`,
            open_hint: "You can open it with: open_document",
          };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "open_document": {
        const filePath = args.file_path || this.filePath;
        if (!filePath) return { error: "No document path specified" };
        if (!fs.existsSync(filePath)) return { error: "File not found: " + filePath };

        try {
          // Windows: start command opens in default app
          exec(`start "" "${filePath}"`, (err) => {
            if (err) console.error("Failed to open:", err.message);
          });
          return { opened: filePath, message: `Opening ${filePath} in default application...` };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "get_document_text": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const text = await this.mcp.getDocumentText(filename);
          return { filename, text: text.slice(0, 3000) };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "get_paragraph": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const text = await this.mcp.getParagraphText(filename, args.paragraph_index);
          return { filename, paragraph: args.paragraph_index, text };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "search_replace": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          await this.mcp.searchAndReplace(filename, args.find_text, args.replace_text);
          return { success: true, filename, find: args.find_text, replace: args.replace_text };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "add_paragraph": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("add_paragraph", {
            filename,
            text: args.text,
            style: args.style,
            font_name: args.font_name,
            font_size: args.font_size,
            bold: args.bold,
            italic: args.italic,
            color: args.color,
          });
          return { success: true, filename, result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "add_heading": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("add_heading", {
            filename,
            text: args.text,
            level: args.level || 1,
            font_name: args.font_name,
            font_size: args.font_size,
            bold: args.bold,
            italic: args.italic,
          });
          return { success: true, filename, result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "delete_paragraph": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("delete_paragraph", {
            filename,
            paragraph_index: args.paragraph_index,
          });
          return { success: true, filename, deleted: args.paragraph_index, result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "add_table": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("add_table", {
            filename,
            rows: args.rows,
            cols: args.cols,
            data: args.data,
          });
          return { success: true, filename, result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "convert_to_pdf": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("convert_to_pdf", {
            filename,
            output_filename: args.output_filename,
          });
          return { success: true, filename, result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "list_documents": {
        const dir = args.directory || docsFolder;
        try {
          const result = await this.mcp.listDocuments(dir);
          return { directory: dir, documents: result };
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

      case "get_document_info": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("get_document_info", { filename });
          return { filename, info: result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "get_document_outline": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("get_document_outline", { filename });
          return { filename, outline: result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "find_text_in_document": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("find_text_in_document", {
            filename,
            text_to_find: args.text_to_find,
          });
          return { filename, search: args.text_to_find, result };
        } catch (e) {
          return { error: e.message };
        }
      }

      case "format_text": {
        if (!this.mcpConnected) return { error: "MCP not connected" };
        const filename = getFilename();
        if (!filename) return { error: "No document loaded" };
        try {
          const result = await this.mcp.callTool("format_text", {
            filename,
            paragraph_index: args.paragraph_index,
            start_pos: args.start_pos,
            end_pos: args.end_pos,
            bold: args.bold,
            italic: args.italic,
            underline: args.underline,
            color: args.color,
            font_size: args.font_size,
            font_name: args.font_name,
          });
          return { success: true, filename, result };
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
    const w = Math.min(this.terminal.width - 4, 76);

    this.terminal.addLine();
    this.terminal.addLine(C.bar("  ┌") + C.dim("─".repeat(w)) + C.bar("┐"));
    this.terminal.addLine(C.bar("  │ ") + C.white.bold(path.basename(this.filePath)).padEnd(w - 2) + C.bar(" │"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("paragraphs ") + C.cyan(String(this.scanResult.totalBody)) +
      C.dim("  score ") + C.cyan(String(this.scanResult.totalScore)) +
      C.dim("  ai ") + pctColor(pct.toFixed(0) + "%") +
      C.dim("  ") + pctColor(verdict));
    this.terminal.addLine(C.bar("  ├") + C.dim("─".repeat(w)) + C.bar("┤"));
    this.terminal.addLine(C.bar("  │ ") +
      C.red.bold(" HIGH ") + " " + String(summary.bySeverity.HIGH).padStart(3) + "   " +
      C.yellow.bold(" MED ") + " " + String(summary.bySeverity.MEDIUM).padStart(3) + "   " +
      C.green.bold(" LOW ") + " " + String(summary.bySeverity.LOW).padStart(3) +
      C.dim("    total ") + C.cyan(String(summary.total)) +
      C.dim("  fixable ") + C.cyan(String(summary.fixable)));
    this.terminal.addLine(C.bar("  └") + C.dim("─".repeat(w)) + C.bar("┘"));
    this.terminal.addLine();

    // Findings table
    const important = this.findings.filter((f) => f.severity === "HIGH" || f.severity === "MEDIUM");
    if (important.length > 0) {
      this.terminal.addLine(C.pink.bold("  FINDINGS"));
      this.terminal.addLine(C.dim("  ┌──────┬──────────┬──────────────────┬────────────────────────────────┐"));
      this.terminal.addLine(C.dim("  │ ") + C.white.bold("ID  ") + C.dim(" │ ") + C.white.bold("Severity") + C.dim(" │ ") + C.white.bold("Category        ") + C.dim(" │ ") + C.white.bold("Title                          ") + C.dim("│"));
      this.terminal.addLine(C.dim("  ├──────┼──────────┼──────────────────┼────────────────────────────────┤"));
      for (const f of important) {
        const sevColor = f.severity === "HIGH" ? C.red : C.yellow;
        const sevBg = f.severity === "HIGH" ? chalk.bgRed.white : chalk.bgYellow.black;
        const id = f.id.padEnd(5);
        const sev = (" " + f.severity + " ").padEnd(8);
        const cat = f.category.padEnd(16);
        const title = f.title.slice(0, 30).padEnd(30);
        this.terminal.addLine(C.dim("  │ ") + C.dim(id) + C.dim(" │ ") + sevBg(sev) + C.dim(" │ ") + C.dim(cat) + C.dim(" │ ") + C.dim(title) + C.dim(" │"));
      }
      this.terminal.addLine(C.dim("  └──────┴──────────┴──────────────────┴────────────────────────────────┘"));
      this.terminal.addLine();
    }

    // Quick action
    this.terminal.addLine(C.bar("  │ ") + C.dim("Type ") + C.white("/findings") + C.dim(" to see all, or chat with me about the document."));
  }

  _renderFindingsList(showAll) {
    const display = showAll ? this.findings : this.findings.filter((f) => f.status === FindingStatus.NEW);
    if (display.length === 0) {
      this.terminal.addLine(C.dim("  No findings."));
      return;
    }

    this.terminal.addLine();
    this.terminal.addLine(C.dim("  ┌──────┬──────┬──────────────────┬──────────────────────────────────────┐"));
    this.terminal.addLine(C.dim("  │ ") + C.white.bold("ID  ") + C.dim(" │ ") + C.white.bold("Sev ") + C.dim(" │ ") + C.white.bold("Category        ") + C.dim(" │ ") + C.white.bold("Title                                ") + C.dim("│"));
    this.terminal.addLine(C.dim("  ├──────┼──────┼──────────────────┼──────────────────────────────────────┤"));

    for (const f of display) {
      const sevColor = f.severity === "HIGH" ? C.red : f.severity === "MEDIUM" ? C.yellow : C.green;
      const sevBg = f.severity === "HIGH" ? chalk.bgRed.white :
                    f.severity === "MEDIUM" ? chalk.bgYellow.black : chalk.bgGreen.black;
      const statusDot = f.status === FindingStatus.APPROVED ? C.green("●") :
                        f.status === FindingStatus.FIXED ? C.cyan("●") :
                        f.status === FindingStatus.SKIPPED ? C.dim("○") :
                        f.status === FindingStatus.FAILED ? C.red("●") : C.dim("○");

      const id = f.id.padEnd(5);
      const sev = (" " + f.severity + " ").padEnd(3);
      const cat = f.category.padEnd(16);
      const title = f.title.slice(0, 36).padEnd(36);

      this.terminal.addLine(
        C.dim("  │ ") + statusDot + C.dim(id) + C.dim(" │ ") + sevBg(sev) + C.dim(" │ ") + C.dim(cat) + C.dim(" │ ") + C.dim(title) + C.dim(" │")
      );
    }

    this.terminal.addLine(C.dim("  └──────┴──────┴──────────────────┴──────────────────────────────────────┘"));
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
    const w = Math.min(this.terminal.width - 4, 60);
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  ┌") + C.dim("─".repeat(w)) + C.bar("┐"));
    this.terminal.addLine(C.bar("  │ ") + C.pink.bold("COMMANDS").padEnd(w - 2) + C.bar(" │"));
    this.terminal.addLine(C.bar("  ├") + C.dim("─".repeat(w)) + C.bar("┤"));

    const cmds = [
      ["/findings", "show all findings"],
      ["/new", "show new/unreviewed findings"],
      ["/approve all", "approve all fixable findings"],
      ["/approve <n>", "approve finding #n"],
      ["/skip <n>", "skip finding #n"],
      ["/fix all", "apply all approved fixes"],
      ["/fix <n>", "apply fix for finding #n"],
      ["/diff <n>", "side-by-side diff preview"],
      ["/para <n>", "inspect paragraph #n"],
      ["/rescan", "re-analyze document"],
      ["/open", "open document in Word"],
      ["/file", "show current file path"],
      ["/summary", "findings summary"],
      ["/status", "connection status"],
      ["/clear", "clear screen"],
      ["/help", "this help"],
      ["/quit", "exit"],
    ];

    for (const [cmd, desc] of cmds) {
      this.terminal.addLine(C.bar("  │ ") + C.white(cmd.padEnd(16)) + C.dim(desc.padEnd(w - 20)) + C.bar(" │"));
    }

    this.terminal.addLine(C.bar("  ├") + C.dim("─".repeat(w)) + C.bar("┤"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("Anything without / is sent to AI.").padEnd(w - 2) + C.bar(" │"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("'fix the AI phrases in paragraph 3'").padEnd(w - 2) + C.bar(" │"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("'create a new document called report.docx'").padEnd(w - 2) + C.bar(" │"));
    this.terminal.addLine(C.bar("  └") + C.dim("─".repeat(w)) + C.bar("┘"));
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

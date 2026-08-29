"use strict";

const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const os = require("os");
const chalk = require("chalk");
const { scanDisk, suggestFixes } = require("./scanner");
const { buildFindings, summarizeFindings, FindingStatus, transitionFinding } = require("./findings");
const { analyzeFinding, suggestRewrite } = require("./ai");
const { renderSideBySideDiff, renderInlineDiff } = require("./diff");
const MCPClient = require("./mcp-client");
const { Terminal, C } = require("./terminal");
const { LLMClient, getAllTools, SYSTEM_PROMPT, loadConfig } = require("./ai-agent");
const { executeTool } = require("./tools");
const Const = require("./constants");
const { renderTable, renderPanel, BOX, visibleLen, padVisible, stripHtml } = require("./table");

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

    const tools = getAllTools();

    try {
      const response = await this.llm.chat(this.conversationHistory, tools);

      // Path 1: Native function calling (OpenAI-compatible)
      if (response.toolCalls && response.toolCalls.length > 0) {
        this.conversationHistory.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls,
        });

        // Show any text content before tool calls
        if (response.content) {
          this._printAIResponse(response.content);
        }

        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          const fn = toolCall.function;
          let args;
          try {
            args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
          } catch (e) {
            args = {};
          }

          // Render and execute
          this._renderToolCallFromAI(fn.name, args);
          const toolResult = await this._executeTool(fn.name, args);
          this._renderToolResult(fn.name, args, toolResult);

          // Show diff for edit operations
          if (fn.name === "search_replace" || fn.name === "add_paragraph" || fn.name === "add_heading") {
            this._showFixDiff(fn.name, args, toolResult);
          }

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
        // Path 2: Text-only response (may contain <tool_call> blocks)
        if (response.content) {
          this._printAIResponse(response.content);
        }
        this.conversationHistory.push({ role: "assistant", content: response.content || "" });
      }
    } catch (e) {
      this.terminal.addLine(C.red("  \u2717 AI error: " + e.message));
    }

    this.terminal.setStatus(this.filePath ? path.basename(this.filePath) : "ready");
  }

  _printAIResponse(text) {
    this.terminal.addLine();

    // Strip HTML tags first
    const clean = stripHtml(text);
    const lines = clean.split("\n");
    let inToolCall = false;
    let toolCallLines = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // --- Tool call block start ---
      if (trimmed.startsWith("<tool_call>")) {
        inToolCall = true;
        toolCallLines = [];
        continue;
      }

      // --- Tool call block end ---
      if (trimmed.startsWith("</tool_call>")) {
        inToolCall = false;
        this._renderToolCallBlock(toolCallLines);
        toolCallLines = [];
        continue;
      }

      // --- Inside tool call ---
      if (inToolCall) {
        toolCallLines.push(trimmed);
        continue;
      }

      // --- Status prefixes (Unicode icons, no emojis) ---
      if (trimmed.startsWith("[SUCCESS]")) {
        const msg = trimmed.replace("[SUCCESS]", "").trim();
        this.terminal.addLine(C.bar("  ") + C.green("\u2713") + C.white(" " + msg));
        continue;
      }
      if (trimmed.startsWith("[ERROR]")) {
        const msg = trimmed.replace("[ERROR]", "").trim();
        this.terminal.addLine(C.bar("  ") + C.red("\u2717") + C.white(" " + msg));
        continue;
      }
      if (trimmed.startsWith("[WARN]")) {
        const msg = trimmed.replace("[WARN]", "").trim();
        this.terminal.addLine(C.bar("  ") + C.yellow("\u26A0") + C.white(" " + msg));
        continue;
      }
      if (trimmed.startsWith("[INFO]")) {
        const msg = trimmed.replace("[INFO]", "").trim();
        this.terminal.addLine(C.bar("  ") + C.cyan("\u2139") + C.dim(" " + msg));
        continue;
      }

      // --- Headers ---
      if (trimmed.startsWith("## ")) {
        const header = trimmed.replace(/^##\s+/, "");
        this.terminal.addLine();
        this.terminal.addLine(C.pink.bold("  " + header));
        continue;
      }
      if (trimmed.startsWith("### ")) {
        const header = trimmed.replace(/^###\s+/, "");
        this.terminal.addLine(C.white.bold("  " + header));
        continue;
      }

      // --- List items ---
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        const item = trimmed.slice(2).replace(/\*\*(.+?)\*\*/g, (_, m) => C.white.bold(m));
        this.terminal.addLine(C.dim("    \u2022 ") + item);
        continue;
      }
      if (/^\d+\.\s/.test(trimmed)) {
        const item = trimmed.replace(/^\d+\.\s+/, "").replace(/\*\*(.+?)\*\*/g, (_, m) => C.white.bold(m));
        const num = trimmed.match(/^(\d+)\./)[1];
        this.terminal.addLine(C.cyan("    " + num + ". ") + item);
        continue;
      }

      // --- Empty line ---
      if (!trimmed) {
        this.terminal.addLine();
        continue;
      }

      // --- Standard text (with inline bold) ---
      const rendered = trimmed.replace(/\*\*(.+?)\*\*/g, (_, m) => C.white.bold(m));
      this.terminal.addLine("  " + C.white(rendered));
    }

    this.terminal.addLine();
  }

  _renderToolCallBlock(lines) {
    let funcName = "";
    const params = {};

    for (const line of lines) {
      const funcMatch = line.match(/\[FUNCTION\]:\s*(\w+)/);
      if (funcMatch) { funcName = funcMatch[1]; continue; }
      const paramMatch = line.match(/<param name="(\w+)">(.+?)<\/param>/);
      if (paramMatch) { params[paramMatch[1]] = paramMatch[2]; continue; }
    }

    // Unicode icon map (box-drawing based, no emojis)
    const icons = {
      scan_document:        "\u2609", // ☉
      create_document:      "\u270E", // ✎
      open_document:        "\u27A4", // ➤
      get_document_text:    "\u2630", // ☰
      get_paragraph:        "\u2630", // ☰
      search_replace:       "\u21C4", // ⇄
      add_paragraph:        "\u2795", // ➕
      add_heading:          "\u2795", // ➕
      delete_paragraph:     "\u2716", // ✖
      format_text:          "\u2592", // ▒
      add_table:            "\u25A6", // ▦
      convert_to_pdf:       "\u27A4", // ➤
      copy_document:        "\u2398", // ⎘
      approve_finding:      "\u2713", // ✓
      fix_approved:         "\u2692", // ⚒
      list_documents:       "\u2630", // ☰
      get_document_info:    "\u2139", // ℹ
      get_document_outline: "\u2630", // ☰
      find_text_in_document:"\u2315", // ⌕
    };
    const icon = icons[funcName] || "\u2692"; // ⚒

    // Use table renderer for clean layout
    const w = Math.min(this.terminal.width - 6, 50);
    const lines_out = [];

    for (const [key, val] of Object.entries(params)) {
      const displayVal = val.length > 40 ? val.slice(0, 40) + "\u2026" : val;
      lines_out.push(C.cyan(key) + C.dim(": ") + C.dim(displayVal));
    }

    if (lines_out.length === 0) {
      lines_out.push(C.dim("no parameters"));
    }

    const panel = renderPanel({
      title: C.pink(icon + " " + funcName),
      lines: lines_out,
      width: w,
      dimStyle: C.dim,
    });
    this.terminal.addLines(panel);
  }

  _renderToolCallFromAI(name, args) {
    const icons = {
      scan_document: "\u2609", create_document: "\u270E", open_document: "\u27A4",
      get_document_text: "\u2630", get_paragraph: "\u2630", search_replace: "\u21C4",
      add_paragraph: "\u2795", add_heading: "\u2795", delete_paragraph: "\u2716",
      format_text: "\u2592", add_table: "\u25A6", convert_to_pdf: "\u27A4",
      copy_document: "\u2398", approve_finding: "\u2713", fix_approved: "\u2692",
      list_documents: "\u2630", get_document_info: "\u2139", get_document_outline: "\u2630",
      find_text_in_document: "\u2315",
    };
    const icon = icons[name] || "\u2692";

    // Build param lines
    const paramLines = [];
    for (const [key, val] of Object.entries(args)) {
      const displayVal = String(val).length > 50 ? String(val).slice(0, 50) + "\u2026" : String(val);
      paramLines.push(C.cyan(key) + C.dim(": ") + C.white(displayVal));
    }

    if (paramLines.length === 0) {
      paramLines.push(C.dim("no parameters"));
    }

    const panel = renderPanel({
      title: C.pink(icon + " " + name),
      lines: paramLines,
      width: Math.min(this.terminal.width - 6, 50),
      dimStyle: C.dim,
    });
    this.terminal.addLines(panel);
  }

  _showFixDiff(name, args, result) {
    if (result.error) return;

    if (name === "search_replace" && args.find_text && args.replace_text) {
      this.terminal.addLine();
      const diffLines = renderInlineDiff(args.find_text, args.replace_text, {
        width: Math.min(this.terminal.width - 6, 80),
      });
      this.terminal.addLines(diffLines);
    }

    if (name === "fix_approved" && result.fixed > 0) {
      this.terminal.addLine();
      this.terminal.addLine(C.green("  \u2713") + C.dim(" Applied ") + C.cyan(String(result.fixed)) + C.dim(" fixes to ") + C.white(result.document || "document"));
    }
  }

  // -----------------------------------------------------------------------
  // Tool execution — with inline result rendering
  // -----------------------------------------------------------------------
  async _executeTool(name, args) {
    const context = {
      fs, path, exec, os,
      mcp: this.mcp,
      mcpConnected: this.mcpConnected,
      filePath: this.filePath,
      scanResult: this.scanResult,
      findings: this.findings,
      backupPath: this.backupPath,
      modules: { scanDisk, buildFindings, summarizeFindings, FindingStatus, transitionFinding, suggestRewrite, analyzeFinding },
    };

    const result = await executeTool(name, args, context);

    // Sync state back from context
    if (context.filePath !== this.filePath) this.filePath = context.filePath;
    if (context.scanResult !== this.scanResult) this.scanResult = context.scanResult;
    if (context.findings !== this.findings) this.findings = context.findings;
    if (context.backupPath !== this.backupPath) this.backupPath = context.backupPath;

    return result;
  }

  _renderToolResult(name, args, result) {
    if (result.error) {
      this.terminal.addLine(C.red("  \u2717 ") + C.dim(result.error));
      return;
    }

    switch (name) {
      case "scan_document":
        if (result.path) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Scanned ") + C.white(result.file));
          this.terminal.addLine(C.dim("    paragraphs ") + C.cyan(String(result.paragraphs)) +
            C.dim("  findings ") + C.cyan(String(result.findings)) +
            C.dim("  ai ") + C.cyan(result.aiPercentage));
          if (this.scanResult && this.findings.length > 0) {
            this.terminal.clearContent();
            this._renderScanResults();
          }
        }
        break;

      case "create_document":
        if (result.created) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Created ") + C.white(result.created));
        }
        break;

      case "open_document":
        if (result.opened) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Opening ") + C.white(result.opened));
        }
        break;

      case "search_replace":
        if (result.success) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Replaced ") + C.white(result.find) + C.dim(" \u2192 ") + C.green(result.replace));
        }
        break;

      case "add_paragraph":
      case "add_heading":
        if (result.success) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Added to ") + C.white(result.filename));
        }
        break;

      case "delete_paragraph":
        if (result.success) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Deleted paragraph ") + C.cyan(String(result.deleted)));
        }
        break;

      case "fix_approved":
        if (result.fixed !== undefined) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Fixed ") + C.cyan(String(result.fixed)) + C.dim("  Failed ") + C.red(String(result.failed)));
          if (result.document) {
            this.terminal.addLine(C.dim("    Document: ") + C.white(result.document));
          }
        }
        break;

      case "approve_finding":
        if (result.approved) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Approved ") + C.cyan(String(result.approved)));
        }
        break;

      case "get_document_text":
        if (result.text) {
          const clean = stripHtml(result.text);
          this.terminal.addLine(C.dim("  Document text (") + C.cyan(String(clean.length)) + C.dim(" chars)"));
          const preview = clean.slice(0, 500).split("\n").slice(0, 5);
          for (const line of preview) {
            this.terminal.addLine(C.dim("    ") + C.dim(line.slice(0, 70)));
          }
          if (clean.length > 500) {
            this.terminal.addLine(C.dim("    ..."));
          }
        }
        break;

      case "get_paragraph":
        if (result.text) {
          const clean = stripHtml(result.text);
          this.terminal.addLine(C.dim("  Paragraph ") + C.cyan(String(result.paragraph)));
          const words = clean.replace(/\s+/g, " ").trim().split(" ");
          let line = "";
          for (const w of words) {
            if ((line + " " + w).trim().length > 64 && line) {
              this.terminal.addLine(C.dim("    ") + C.dim(line.trim()));
              line = w;
            } else { line = line ? line + " " + w : w; }
          }
          if (line) this.terminal.addLine(C.dim("    ") + C.dim(line.trim()));
        }
        break;

      case "convert_to_pdf":
        if (result.success) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Converted to PDF"));
        }
        break;

      case "list_documents":
        if (result.documents) {
          const docs = typeof result.documents === "string" ? stripHtml(result.documents).split("\n") : [String(result.documents)];
          this.terminal.addLine(C.dim("  Documents in ") + C.white(result.directory));
          for (const doc of docs.slice(0, 10)) {
            if (doc.trim()) this.terminal.addLine(C.dim("    ") + C.white(doc.trim()));
          }
        }
        break;

      case "copy_document":
        if (result.copied) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Copied to ") + C.white(result.to));
        }
        break;

      case "get_document_info":
        if (result.info) {
          const clean = stripHtml(String(result.info));
          const lines = clean.split("\n").slice(0, 10);
          for (const line of lines) {
            if (line.trim()) this.terminal.addLine(C.dim("    ") + C.dim(line.trim()));
          }
        }
        break;

      case "get_document_outline":
        if (result.outline) {
          const clean = stripHtml(String(result.outline));
          const lines = clean.split("\n").slice(0, 15);
          for (const line of lines) {
            if (line.trim()) this.terminal.addLine(C.dim("    ") + C.dim(line.trim()));
          }
        }
        break;

      case "find_text_in_document":
        if (result.result) {
          const clean = stripHtml(String(result.result));
          this.terminal.addLine(C.dim("  Found: ") + C.dim(clean.slice(0, 200)));
        }
        break;
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
    const verdict = pct >= 50 ? Const.VERDICTS.high : pct >= 25 ? Const.VERDICTS.medium : Const.VERDICTS.low;
    const summary = summarizeFindings(this.findings);

    // Info panel
    const infoLines = [
      C.white.bold(path.basename(this.filePath)),
      C.dim("paragraphs ") + C.cyan(String(this.scanResult.totalBody)) +
        C.dim("  score ") + C.cyan(String(this.scanResult.totalScore)) +
        C.dim("  ai ") + pctColor(pct.toFixed(0) + "%") +
        C.dim("  ") + pctColor(verdict),
      "",
      C.red.bold(" HIGH ") + " " + String(summary.bySeverity.HIGH).padStart(3) + "   " +
        C.yellow.bold(" MED ") + " " + String(summary.bySeverity.MEDIUM).padStart(3) + "   " +
        C.green.bold(" LOW ") + " " + String(summary.bySeverity.LOW).padStart(3) +
        C.dim("    total ") + C.cyan(String(summary.total)) +
        C.dim("  fixable ") + C.cyan(String(summary.fixable)),
    ];

    const panel = renderPanel({
      title: C.pink.bold("SCAN RESULTS"),
      lines: infoLines,
      width: Math.min(this.terminal.width - 6, Const.SCAN_BOX_WIDTH),
      titleStyle: (s) => s,
      dimStyle: C.bar,
    });
    this.terminal.addLines(panel);
    this.terminal.addLine();

    // Findings table
    const important = this.findings.filter((f) => f.severity === "HIGH" || f.severity === "MEDIUM");
    if (important.length > 0) {
      this.terminal.addLine(C.pink.bold("  FINDINGS"));
      this.terminal.addLine();

      const headers = ["ID", "Severity", "Category", "Title"];
      const widths = [6, 10, 18, 32];
      const rows = important.map((f) => {
        const sevBg = f.severity === "HIGH" ? chalk.bgRed.white(" " + f.severity + " ") : chalk.bgYellow.black(" " + f.severity + " ");
        return [
          C.dim(f.id),
          sevBg,
          C.dim(f.category),
          C.dim(f.title.slice(0, 30)),
        ];
      });

      const table = renderTable({
        headers, widths, rows,
        headerStyle: C.white.bold,
        dimStyle: C.dim,
      });
      this.terminal.addLines(table);
      this.terminal.addLine();
    }

    this.terminal.addLine(C.bar("  ") + C.dim("Type ") + C.white("/findings") + C.dim(" to see all, or chat with me about the document."));
  }

  _renderFindingsList(showAll) {
    const display = showAll ? this.findings : this.findings.filter((f) => f.status === FindingStatus.NEW);
    if (display.length === 0) {
      this.terminal.addLine(C.dim("  No findings."));
      return;
    }

    this.terminal.addLine();

    const headers = ["", "ID", "Sev", "Category", "Title"];
    const widths = [2, 6, 5, 18, 36];
    const rows = display.map((f) => {
      const sevBg = f.severity === "HIGH" ? chalk.bgRed.white(" " + f.severity + " ") :
                    f.severity === "MEDIUM" ? chalk.bgYellow.black(" " + f.severity + " ") :
                    chalk.bgGreen.black(" " + f.severity + " ");
      const statusDot = f.status === FindingStatus.APPROVED ? C.green("\u25CF") :
                        f.status === FindingStatus.FIXED ? C.cyan("\u25CF") :
                        f.status === FindingStatus.SKIPPED ? C.dim("\u25CB") :
                        f.status === FindingStatus.FAILED ? C.red("\u25CF") : C.dim("\u25CB");
      return [
        statusDot,
        C.dim(f.id),
        sevBg,
        C.dim(f.category),
        C.dim(f.title.slice(0, 36)),
      ];
    });

    const table = renderTable({
      headers, widths, rows,
      headerStyle: C.white.bold,
      dimStyle: C.dim,
    });
    this.terminal.addLines(table);
    this.terminal.addLine();
  }

  _renderFindingDetail(finding) {
    const sevColor = finding.severity === "HIGH" ? C.red : finding.severity === "MEDIUM" ? C.yellow : C.green;
    const analysis = analyzeFinding(finding, {
      paragraph: this.scanResult?.paragraphs.find((p) => p.index === finding.paragraphIndex),
    });

    const panelLines = [
      C.white.bold(finding.id) + "  " + sevColor(finding.severity) + C.dim("  " + finding.category),
      C.white(finding.title),
      C.dim(finding.description),
      "",
      C.pink.bold("analysis") + "  " + C.dim(analysis.analysis),
      C.pink.bold("fix") + "  " + C.green(analysis.recommendation),
      C.dim("confidence: ") + C.cyan(analysis.confidence + "%"),
    ];

    // Add preview if rewrite is available
    const rewrite = suggestRewrite(finding.originalContent, [finding]);
    if (rewrite.changed) {
      panelLines.push("");
      panelLines.push(C.pink.bold("preview"));
      const diffLines = renderInlineDiff(rewrite.original, rewrite.rewritten, {
        width: Math.min(this.terminal.width - 10, 90),
      });
      panelLines.push(...diffLines);
    }

    const panel = renderPanel({
      title: C.pink.bold("FINDING " + finding.id),
      lines: panelLines,
      dimStyle: C.bar,
    });
    this.terminal.addLines(panel);
    this.terminal.addLine();
  }

  _renderSummary() {
    const s = summarizeFindings(this.findings);
    const panel = renderPanel({
      title: C.pink.bold("SUMMARY"),
      lines: [
        C.dim("total ") + C.cyan(String(s.total)) + C.dim("  fixable ") + C.cyan(String(s.fixable)),
        C.red("HIGH " + s.bySeverity.HIGH) + C.dim("  ") + C.yellow("MED " + s.bySeverity.MEDIUM) + C.dim("  ") + C.green("LOW " + s.bySeverity.LOW),
        C.dim("approved ") + C.green(String(s.approved)) + C.dim("  fixed ") + C.cyan(String(s.fixed)) + C.dim("  failed ") + C.red(String(s.failed)),
      ],
      dimStyle: C.bar,
    });
    this.terminal.addLines(panel);
    this.terminal.addLine();
  }

  _renderStatus() {
    const s = summarizeFindings(this.findings);
    const panel = renderPanel({
      title: C.pink.bold("STATUS"),
      lines: [
        C.dim("AI: ") + (this.llmConnected ? C.green(this.config.api.provider + ":" + this.config.api.model) : C.red("disconnected")),
        C.dim("MCP: ") + (this.mcpConnected ? C.green("connected") : C.red("disconnected")),
        ...(this.filePath ? [C.dim("Document: ") + C.white(this.filePath)] : []),
        ...(this.backupPath ? [C.dim("Backup: ") + C.dim(this.backupPath)] : []),
        C.dim("Findings: ") + C.cyan(String(s.total)) + C.dim("  Fixed: ") + C.cyan(String(s.fixed)),
      ],
      dimStyle: C.bar,
    });
    this.terminal.addLines(panel);
    this.terminal.addLine();
  }

  _printHelp() {
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

    const cmdLines = cmds.map(([cmd, desc]) => C.white(cmd) + C.dim("  " + desc));

    const panel = renderPanel({
      title: C.pink.bold("COMMANDS"),
      lines: [
        ...cmdLines,
        "",
        C.dim("Anything without / is sent to AI."),
        C.dim("'fix the AI phrases in paragraph 3'"),
        C.dim("'create a new document called report.docx'"),
      ],
      width: Math.min(this.terminal.width - 6, Const.HELP_BOX_WIDTH),
      dimStyle: C.bar,
    });
    this.terminal.addLines(panel);
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

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
const { Terminal, C, wrapText } = require("./terminal");
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
      this.terminal.addLine(C.bar("  │ ") + C.green("  \u2713 AI connected") + C.dim("  (" + this.config.api.provider + ": " + this.config.api.model + ")"));
    } else {
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  \u26A0 AI not available") + C.dim("  (heuristics only)"));
    }

    // Check MCP
    this.terminal.addLine(C.bar("  │ ") + C.dim("Connecting MCP..."));
    try {
      await this.mcp.connect();
      this.mcpConnected = true;
      this.terminal.addLine(C.bar("  │ ") + C.green("  \u2713 MCP connected") + C.dim("  (" + this.mcp.tools.length + " tools)"));
    } catch (e) {
      this.mcpConnected = false;
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  \u26A0 MCP unavailable") + C.dim("  " + e.message));
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
      this.terminal.addLine(C.bar("  │ ") + C.green("  \u2713 AI connected"));
    } else {
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  \u26A0 AI unavailable"));
    }

    this.terminal.addLine(C.bar("  │ ") + C.dim("Connecting MCP..."));
    try {
      await this.mcp.connect();
      this.mcpConnected = true;
      this.terminal.addLine(C.bar("  │ ") + C.green("  \u2713 MCP connected"));
    } catch (e) {
      this.mcpConnected = false;
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  \u26A0 MCP unavailable"));
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

          // Render tool call panel
          this._renderToolCallFromAI(fn.name, args);

          // Execute tool
          const toolResult = await this._executeTool(fn.name, args);

          // Render result
          this._renderToolResult(fn.name, args, toolResult);

          // Show diff for edit operations
          if (fn.name === "search_replace" && args.find_text && args.replace_text && !toolResult.error) {
            this._showFixDiff(args.find_text, args.replace_text);
          }
          if (fn.name === "fix_approved" && toolResult.fixed > 0) {
            this.terminal.addLine();
            this.terminal.addLine(C.green("  \u2713") + C.dim(" Applied ") + C.cyan(String(toolResult.fixed)) + C.dim(" fixes"));
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
    let inTable = false;
    let tableLines = [];
    let inCodeBlock = false;
    let codeLines = [];

    const flushTable = () => {
      if (tableLines.length === 0) return;
      this._renderMarkdownTable(tableLines);
      tableLines = [];
      inTable = false;
    };

    const flushCode = () => {
      if (codeLines.length === 0) return;
      for (const cl of codeLines) {
        this.terminal.addLine(C.dim("    ") + C.cyan(cl));
      }
      codeLines = [];
      inCodeBlock = false;
    };

    for (const line of lines) {
      const trimmed = line.trim();

      // --- Code block ---
      if (trimmed.startsWith("```")) {
        if (inCodeBlock) {
          flushCode();
        } else {
          inCodeBlock = true;
        }
        continue;
      }
      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      // --- Tool call block ---
      if (trimmed.startsWith("<tool_call>")) {
        inToolCall = true;
        toolCallLines = [];
        continue;
      }
      if (trimmed.startsWith("</tool_call>")) {
        inToolCall = false;
        this._renderToolCallBlock(toolCallLines);
        toolCallLines = [];
        continue;
      }
      if (inToolCall) {
        toolCallLines.push(trimmed);
        continue;
      }

      // --- Markdown table ---
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue; // separator
        inTable = true;
        tableLines.push(trimmed);
        continue;
      } else if (inTable) {
        flushTable();
      }

      // --- Status prefixes ---
      if (trimmed.startsWith("[SUCCESS]")) {
        this.terminal.addLine(C.green("  \u2713") + C.white(" " + trimmed.replace("[SUCCESS]", "").trim()));
        continue;
      }
      if (trimmed.startsWith("[ERROR]")) {
        this.terminal.addLine(C.red("  \u2717") + C.white(" " + trimmed.replace("[ERROR]", "").trim()));
        continue;
      }
      if (trimmed.startsWith("[WARN]")) {
        this.terminal.addLine(C.yellow("  \u26A0") + C.white(" " + trimmed.replace("[WARN]", "").trim()));
        continue;
      }
      if (trimmed.startsWith("[INFO]")) {
        this.terminal.addLine(C.cyan("  \u2139") + C.dim(" " + trimmed.replace("[INFO]", "").trim()));
        continue;
      }

      // --- Headers ---
      if (trimmed.startsWith("## ")) {
        flushTable();
        this.terminal.addLine();
        this.terminal.addLine(C.pink.bold("  " + trimmed.slice(3)));
        continue;
      }
      if (trimmed.startsWith("### ")) {
        flushTable();
        this.terminal.addLine(C.white.bold("  " + trimmed.slice(4)));
        continue;
      }

      // --- Horizontal rule ---
      if (/^[-*_]{3,}$/.test(trimmed)) {
        this.terminal.addLine(C.dim("  " + "\u2500".repeat(this.terminal.width - 4)));
        continue;
      }

      // --- Blockquote ---
      if (trimmed.startsWith("> ")) {
        this.terminal.addLine(C.dim("  \u2502 ") + C.dim(trimmed.slice(2)));
        continue;
      }

      // --- List items ---
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        const item = this._renderInline(trimmed.slice(2));
        this.terminal.addLine(C.dim("    \u2022 ") + item);
        continue;
      }
      if (/^\d+\.\s/.test(trimmed)) {
        const num = trimmed.match(/^(\d+)\./)[1];
        const item = this._renderInline(trimmed.replace(/^\d+\.\s+/, ""));
        this.terminal.addLine(C.cyan("    " + num + ". ") + item);
        continue;
      }

      // --- Checkbox lists ---
      if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) {
        this.terminal.addLine(C.green("    \u2611 ") + this._renderInline(trimmed.slice(6)));
        continue;
      }
      if (trimmed.startsWith("- [ ] ")) {
        this.terminal.addLine(C.dim("    \u2610 ") + this._renderInline(trimmed.slice(6)));
        continue;
      }

      // --- Empty line ---
      if (!trimmed) {
        flushTable();
        this.terminal.addLine();
        continue;
      }

      // --- Standard text ---
      this.terminal.addLine("  " + this._renderInline(trimmed));
    }

    flushTable();
    flushCode();
    this.terminal.addLine();
  }

  /** Render inline markdown: bold, italic, code, links */
  _renderInline(text) {
    if (!text) return "";
    return text
      // Code blocks (```...```)
      .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => C.cyan(code.trim()))
      // Inline code (`...`)
      .replace(/`([^`]+)`/g, (_, m) => C.cyan(m))
      // Bold (**...**)
      .replace(/\*\*(.+?)\*\*/g, (_, m) => C.white.bold(m))
      // Italic (*...*)
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, m) => C.dim.italic(m))
      // Strikethrough (~~...~~)
      .replace(/~~(.+?)~~/g, (_, m) => C.dim.strikethrough(m))
      // Links ([text](url))
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => C.cyan(text) + C.dim(" <" + url + ">"));
  }

  _renderMarkdownTable(tableLines) {
    if (tableLines.length === 0) return;

    const rows = tableLines.map(line =>
      line.split("|").filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim())
    );

    const numCols = Math.max(...rows.map(r => r.length));
    const colWidths = [];
    for (let col = 0; col < numCols; col++) {
      let maxW = 3;
      for (const row of rows) {
        if (row[col]) {
          const vis = row[col].replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").length;
          maxW = Math.max(maxW, vis);
        }
      }
      colWidths.push(Math.min(maxW + 2, 30));
    }

    const headers = rows[0] || [];
    const dataRows = rows.slice(1);

    const renderedRows = dataRows.map(row =>
      row.map((cell) => this._renderInline(cell))
    );

    const table = renderTable({
      headers: headers.map(h => h.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1")),
      widths: colWidths,
      rows: renderedRows,
      headerStyle: C.white.bold,
      dimStyle: C.dim,
    });

    this.terminal.addLine();
    this.terminal.addLines(table, true); // noWrap for tables
  }

  _renderToolCallBlock(lines) {
    let funcName = "";
    const params = {};

    for (const line of lines) {
      const funcMatch = line.match(/\[FUNCTION\]:\s*(\w+)/);
      if (funcMatch) { funcName = funcMatch[1]; continue; }
      const paramMatch = line.match(/<param name="(\w+)">(.+?)<\/param>/);
      if (paramMatch) { params[paramMatch[1]] = stripHtml(paramMatch[2]); continue; }
    }

    const icons = {
      scan_document: "\u2609", create_document: "\u270E", open_document: "\u27A4",
      get_document_text: "\u2630", get_paragraph: "\u2630", search_replace: "\u21C4",
      add_paragraph: "\u2795", add_heading: "\u2795", delete_paragraph: "\u2716",
      format_text: "\u2592", add_table: "\u25A6", convert_to_pdf: "\u27A4",
      copy_document: "\u2398", approve_finding: "\u2713", fix_approved: "\u2692",
      list_documents: "\u2630", get_document_info: "\u2139", get_document_outline: "\u2630",
      find_text_in_document: "\u2315",
    };
    const icon = icons[funcName] || "\u2692";

    const w = Math.min(this.terminal.width - 6, 50);
    const paramLines = [];

    for (const [key, val] of Object.entries(params)) {
      const cleanVal = stripHtml(String(val));
      const displayVal = cleanVal.length > 40 ? cleanVal.slice(0, 40) + "\u2026" : cleanVal;
      paramLines.push(C.cyan(key) + C.dim(": ") + C.dim(displayVal));
    }

    if (paramLines.length === 0) {
      paramLines.push(C.dim("no parameters"));
    }

    const panel = renderPanel({
      title: C.pink(icon + " " + funcName),
      lines: paramLines,
      width: this.terminal.width - 4,
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

    // Build param lines — strip HTML from all values
    const paramLines = [];
    for (const [key, val] of Object.entries(args)) {
      const cleanVal = stripHtml(String(val));
      const displayVal = cleanVal.length > 50 ? cleanVal.slice(0, 50) + "\u2026" : cleanVal;
      paramLines.push(C.cyan(key) + C.dim(": ") + this._renderInline(displayVal));
    }

    if (paramLines.length === 0) {
      paramLines.push(C.dim("no parameters"));
    }

    const panel = renderPanel({
      title: C.pink(icon + " " + name),
      lines: paramLines,
      width: this.terminal.width - 4,
      dimStyle: C.dim,
    });
    this.terminal.addLines(panel);
  }

  _showFixDiff(original, modified) {
    const cleanOrig = stripHtml(original);
    const cleanMod = stripHtml(modified);
    if (cleanOrig === cleanMod) return;

    this.terminal.addLine();
    const diffLines = renderSideBySideDiff(cleanOrig, cleanMod, {
      width: this.terminal.width - 2,
    });
    this.terminal.addLines(diffLines);
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
          const preview = clean.slice(0, 1000).split("\n").slice(0, 10);
          for (const line of preview) {
            this.terminal.addLine("    " + this._renderInline(line));
          }
          if (clean.length > 1000) {
            this.terminal.addLine(C.dim("    ..."));
          }
        }
        break;

      case "get_paragraph":
        if (result.text) {
          const clean = stripHtml(result.text);
          this.terminal.addLine(C.dim("  Paragraph ") + C.cyan(String(result.paragraph)));
          this.terminal.addLine("    " + this._renderInline(clean));
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
          this.terminal.addLine(C.dim("  Found: ") + this._renderInline(clean));
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

    // Build scan summary for header
    const pct = this.scanResult.aiPercentage;
    const pctColor = pct >= 50 ? C.red : pct >= 25 ? C.yellow : C.green;
    const verdict = pct >= 50 ? Const.VERDICTS.high : pct >= 25 ? Const.VERDICTS.medium : Const.VERDICTS.low;
    const summary = summarizeFindings(this.findings);

    this._setHeader(path.basename(filePath), {
      file: path.basename(filePath),
      paras: String(this.scanResult.totalBody),
      score: String(this.scanResult.totalScore),
      pct: pct.toFixed(0),
      pctColor,
      verdict,
      high: summary.bySeverity.HIGH,
      med: summary.bySeverity.MEDIUM,
      low: summary.bySeverity.LOW,
      total: summary.total,
      fixable: summary.fixable,
    });

    // Display findings in content area
    this.terminal.clearContent();
    this._renderFindingsTable();
    this.terminal.setStatus(path.basename(filePath));
  }

  _renderFindingsTable() {
    if (!this.findings || this.findings.length === 0) {
      this.terminal.addLine(C.dim("  No findings."));
      return;
    }

    const w = this.terminal.width - 6;
    const idW = 6;
    const sevW = 5;
    const catW = 16;
    const titleW = Math.max(20, w - idW - sevW - catW - 10);

    const headers = ["ID", "Sev", "Category", "Title"];
    const widths = [idW, sevW, catW, titleW];
    const rows = this.findings.map((f) => {
      const sevBg = f.severity === "HIGH" ? chalk.bgRed.white(" " + f.severity.charAt(0) + " ") :
                    f.severity === "MEDIUM" ? chalk.bgYellow.black(" " + f.severity.charAt(0) + " ") :
                    chalk.bgGreen.black(" " + f.severity.charAt(0) + " ");
      return [
        C.dim(f.id),
        sevBg,
        C.dim(f.category),
        C.dim(f.title),
      ];
    });

    const table = renderTable({
      headers, widths, rows,
      headerStyle: C.white.bold,
      dimStyle: C.dim,
    });
    this.terminal.addLines(table, true); // noWrap for tables
    this.terminal.addLine();
    this.terminal.addLine(C.dim("  Type /findings for details, or chat with me about the document."));
  }

  // -----------------------------------------------------------------------
  // UI rendering
  // -----------------------------------------------------------------------
  _setHeader(title, scanSummary) {
    const lines = [
      C.brand("  ██╗    ██╗ ██████╗ ██████╗ ██████╗  ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗"),
      C.brand("  ██║    ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝"),
      C.brand("  ██║ █╗ ██║██║   ██║██████╔╝██║  ██║██║     ███████║█████╗  ██║     █████╔╝ "),
      C.brand("  ██║███╗██║██║   ██║██╔══██╗██║  ██║██║     ██╔══██║██╔══╝  ██║     ██╔═██╗ "),
      C.brand("  ╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝╚██████╗██║  ██║███████╗╚██████╗██║  ██╗"),
      C.brand("   ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝"),
    ];

    if (scanSummary) {
      // Line 1: File name + AI verdict
      lines.push(
        C.bar("  │ ") + C.white.bold(scanSummary.file) +
        C.dim("  │  paras ") + C.cyan(scanSummary.paras) +
        C.dim("  score ") + C.cyan(scanSummary.score) +
        C.dim("  ai ") + scanSummary.pctColor(scanSummary.pct + "%") +
        C.dim("  ") + scanSummary.pctColor(scanSummary.verdict)
      );
      // Line 2: Findings breakdown
      lines.push(
        C.bar("  │ ") +
        C.red.bold("HIGH ") + String(scanSummary.high) + "  " +
        C.yellow.bold("MED ") + String(scanSummary.med) + "  " +
        C.green.bold("LOW ") + String(scanSummary.low) +
        C.dim("    total ") + C.cyan(String(scanSummary.total)) +
        C.dim("  fixable ") + C.cyan(String(scanSummary.fixable))
      );
    } else {
      lines.push(C.dim("  AI-Tell Scanner for Word Documents"));
      lines.push(C.bar("  │ ") + C.dim(title));
    }

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
      width: this.terminal.width - 4,
      titleStyle: (s) => s,
      dimStyle: C.bar,
    });
    this.terminal.addLines(panel);
    this.terminal.addLine();

    // Findings table — show all
    if (this.findings.length > 0) {
      const headers = ["ID", "Sev", "Category", "Title"];
      const widths = [6, 5, 16, 36];
      const rows = this.findings.map((f) => {
        const sevBg = f.severity === "HIGH" ? chalk.bgRed.white(" " + f.severity.charAt(0) + " ") :
                      f.severity === "MEDIUM" ? chalk.bgYellow.black(" " + f.severity.charAt(0) + " ") :
                      chalk.bgGreen.black(" " + f.severity.charAt(0) + " ");
        return [
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
      this.terminal.addLines(table, true); // noWrap for tables
      this.terminal.addLine();
    }

    this.terminal.addLine(C.dim("  Type /findings for details, or chat with me about the document."));
  }

  _renderFindingsList(showAll) {
    const display = showAll ? this.findings : this.findings.filter((f) => f.status === FindingStatus.NEW);
    if (display.length === 0) {
      this.terminal.addLine(C.dim("  No findings."));
      return;
    }

    this.terminal.addLine();

    const w = this.terminal.width - 6;
    const dotW = 2;
    const idW = 6;
    const sevW = 5;
    const catW = 18;
    const titleW = Math.max(20, w - dotW - idW - sevW - catW - 10);

    const headers = ["", "ID", "Sev", "Category", "Title"];
    const widths = [dotW, idW, sevW, catW, titleW];
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
        C.dim(f.title),
      ];
    });

    const table = renderTable({
      headers, widths, rows,
      headerStyle: C.white.bold,
      dimStyle: C.dim,
    });
    this.terminal.addLines(table, true); // noWrap for tables
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
      width: this.terminal.width - 4,
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
      this.terminal.addLine(C.dim("  Creating backup..."));
      try {
        this.backupPath = await this.mcp.createBackup(this.filePath);
        this.terminal.addLine(C.green("  \u2713 ") + C.dim(this.backupPath));
      } catch (e) {
        this.terminal.addLine(C.red("  \u2717 Backup failed: " + e.message));
        return;
      }
    }

    const approved = target === "all"
      ? this.findings.filter((f) => f.status === FindingStatus.APPROVED)
      : this.findings.filter((f) => f.id === `F-${String(parseInt(target, 10)).padStart(4, "0")}` && f.status === FindingStatus.APPROVED);

    if (approved.length === 0) {
      this.terminal.addLine(C.yellow("  \u26A0 No approved findings. Use /approve all first."));
      return;
    }

    let fixed = 0, failed = 0;
    for (const f of approved) {
      const rewrite = suggestRewrite(f.originalContent, [f]);
      if (!rewrite.changed) { transitionFinding(f, FindingStatus.FAILED); failed++; continue; }

      // Show side-by-side diff
      this._showFixDiff(rewrite.original, rewrite.rewritten);

      try {
        const orig = this._extractOriginal(f);
        await this.mcp.searchAndReplace(this.filePath, orig, rewrite.rewritten.slice(0, 200));
        transitionFinding(f, FindingStatus.FIXED);
        this.changeLog.push({ findingId: f.id, timestamp: Date.now() });
        fixed++;
      } catch (e) {
        transitionFinding(f, FindingStatus.FAILED, { note: e.message });
        this.terminal.addLine(C.red("  \u2717 " + f.id + ": " + e.message));
        failed++;
      }
    }

    this.terminal.addLine(C.green("  \u2713 Fixed " + fixed + ", failed " + failed + "."));
    this.terminal.addLine(C.dim("  Document: ") + C.white(this.filePath));
  }
}

module.exports = Agent;

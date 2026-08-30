"use strict";

const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { exec } = require("child_process");
const os = require("os");
const chalk = require("chalk");
const { scanDisk, suggestFixes, scoreParagraph } = require("./scanner");
const { buildFindings, summarizeFindings, FindingStatus, transitionFinding } = require("./findings");
const { analyzeFinding, suggestRewrite } = require("./ai");
const { renderSideBySideDiff, renderInlineDiff } = require("./diff");
const { renderSeverityBar } = require("./analytics");
const MCPClient = require("./mcp-client");
const { Terminal, C, wrapText, DEFAULT_COMMANDS } = require("./terminal");
const { renderWordmark } = require("./wordmark");
const { LLMClient, getAllTools, SYSTEM_PROMPT, loadConfig, saveConfig, MODEL_PRESETS, PROVIDER_DEFAULTS } = require("./ai-agent");
const { executeTool } = require("./tools");
const Const = require("./constants");
const { renderTable, renderPanel, BOX, visibleLen, padVisible, truncateVisible, stripHtml } = require("./table");

// ---------------------------------------------------------------------------
// Hardcoded provider presets
// ---------------------------------------------------------------------------
const BUILTIN_PROVIDERS = [
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    badge: "(Recommended)",
    desc: "Best quality - free tier",
    baseUrl: "https://opencode.ai/zen/v1",
    defaultModel: "mimo-v2.5-free",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    badge: "$10/mo",
    desc: "Low cost subscription",
    baseUrl: "https://opencode.ai/zen/go/v1",
    defaultModel: "mimo-v2.5",
  },
  {
    id: "openai",
    label: "OpenAI",
    badge: "(API key)",
    desc: "",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    badge: "",
    desc: "",
    baseUrl: "https://api.githubcopilot.com",
    defaultModel: "gpt-4o",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    badge: "(API key)",
    desc: "",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
  },
  {
    id: "google",
    label: "Google",
    badge: "",
    desc: "",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
  },
];

const EXTRA_PROVIDERS = [
  { id: "302ai",  label: "302.AI",  badge: "",           desc: "", baseUrl: "https://api.302.ai/v1",            defaultModel: "gpt-4o" },
  { id: "abacus", label: "Abacus",  badge: "",           desc: "", baseUrl: "https://api.abacus.ai/v1",          defaultModel: "gpt-4o" },
  { id: "ollama", label: "Ollama",  badge: "(local)",    desc: "", baseUrl: "http://localhost:11434",            defaultModel: "llama3.1" },
  { id: "custom", label: "Custom",  badge: "(enter URL)",desc: "", baseUrl: "",                                defaultModel: "" },
];

function allProviders() { return [...BUILTIN_PROVIDERS, ...EXTRA_PROVIDERS]; }
function findProvider(id) { return allProviders().find((p) => p.id === id); }

// ---------------------------------------------------------------------------
// Dynamic model fetching from OpenCode API
// ---------------------------------------------------------------------------
async function fetchModelsFromAPI(baseUrl, apiKey) {
  return new Promise((resolve) => {
    try {
      const url = new URL(baseUrl.replace(/\/+$/, "") + "/models");
      const mod = url.protocol === "https:" ? https : http;
      const headers = {};
      if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

      const req = mod.get(url.href, { headers, timeout: 8000 }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.data && Array.isArray(data.data)) {
              resolve(data.data.map((m) => ({ id: m.id, desc: m.owned_by || "" })));
            } else {
              resolve([]);
            }
          } catch { resolve([]); }
        });
      });
      req.on("error", () => resolve([]));
      req.on("timeout", () => { req.destroy(); resolve([]); });
    } catch { resolve([]); }
  });
}

// ---------------------------------------------------------------------------
// Agent
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
    this._cachedModels = {}; // providerId -> [{ id, desc }]
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

    this.terminal.addLine(C.bar("  │ ") + C.dim("Checking AI..."));
    this.llmConnected = await this.llm.healthCheck();
    if (this.llmConnected) {
      this.terminal.addLine(C.bar("  │ ") + C.green("  \u2713 AI connected") + C.dim("  (" + this.config.api.provider + ": " + this.config.api.model + ")"));
    } else {
      this.terminal.addLine(C.bar("  │ ") + C.yellow("  \u26A0 AI not available") + C.dim("  (heuristics only)"));
    }

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

    this.conversationHistory = [{ role: "system", content: SYSTEM_PROMPT }];
    await this.repl();
  }

  // -----------------------------------------------------------------------
  // Entry: direct file mode
  // -----------------------------------------------------------------------
  async run(filePath) {
    this.filePath = filePath;
    this.terminal.open();
    this._setHeader("WordCheck Agent");
    this.conversationHistory = [{ role: "system", content: SYSTEM_PROMPT }];

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

    await this._scanDocument(filePath);
    await this.repl();
  }

  // -----------------------------------------------------------------------
  // REPL
  // -----------------------------------------------------------------------
  async repl() {
    while (true) {
      const input = await this.terminal.prompt();
      if (input === null) break;

      const cmd = input.trim();
      if (!cmd) continue;

      this.terminal.addLine();
      this.terminal.addLine(C.bar("  │ ") + C.pink.bold("you") + C.dim(" \u203A ") + C.white(cmd));

      const localResult = await this._handleLocalCommand(cmd);
      if (localResult === "exit") break;
      if (localResult === "handled") continue;

      if (this.llmConnected) {
        await this._chatWithAI(cmd);
      } else {
        await this._handleWithoutAI(cmd);
      }
    }

    this.terminal.close();
    this.mcp.disconnect();
  }

  // -----------------------------------------------------------------------
  // Local commands
  // -----------------------------------------------------------------------
  async _handleLocalCommand(cmd) {
    const trimmed = cmd.trim();
    if (!trimmed.startsWith("/")) return null;

    const parts   = trimmed.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args    = parts.slice(1).join(" ");

    switch (command) {
      case "quit": case "exit": case "q":
        this.terminal.addLine(C.dim("  bye."));
        return "exit";

      case "help": case "h":
        this._printHelp();
        return "handled";

      case "clear": case "cls":
        this.terminal.clearContent();
        return "handled";

      case "status":
        this._renderStatus();
        return "handled";

      case "findings": case "f":
        this._renderFindingsList(true);
        return "handled";

      case "new":
        this._renderFindingsList(false);
        return "handled";

      case "summary":
        this._renderSummary();
        return "handled";

      case "rescan":
        if (this.filePath) { this._scanDocument(this.filePath); }
        else { this.terminal.addLine(C.red("  \u2717  No document loaded.")); }
        return "handled";

      case "approve":
        this._approveFindings(args || "all");
        return "handled";

      case "skip":
        this._skipFindings(args || "all");
        return "handled";

      case "fix":
        if (!args) { this.terminal.addLine(C.yellow("  Usage: /fix <number> or /fix all")); }
        else { this._applyFix(args); }
        return "handled";

      case "diff":
        if (!args) { this.terminal.addLine(C.yellow("  Usage: /diff <finding-number>")); }
        else { this._showDiff(args); }
        return "handled";

      case "para": case "p":
        if (!args) { this.terminal.addLine(C.yellow("  Usage: /para <paragraph-number>")); }
        else { this._showParagraph(parseInt(args, 10)); }
        return "handled";

      case "open":
        if (this.filePath) {
          exec(`start "" "${this.filePath}"`);
          this.terminal.addLine(C.green("  \u2713  Opening ") + C.white(this.filePath));
        } else {
          this.terminal.addLine(C.red("  \u2717  No document loaded."));
        }
        return "handled";

      case "settings": case "config": case "modal":
        this._openSettingsModal();
        return "handled";

      case "model":
        await this._openModelModal();
        return "handled";

      case "file":
        if (this.filePath) { this.terminal.addLine(C.bar("  │ ") + C.white(this.filePath)); }
        else { this.terminal.addLine(C.dim("  No document loaded.")); }
        return "handled";

      case "reload": case "refresh":
        await this._reloadAll();
        return "handled";

      default:
        this.terminal.addLine(C.dim("  Unknown command: /" + command + "  Type /help for commands."));
        return "handled";
    }
  }

  async _reloadAll() {
    this.terminal.addLine(C.dim("  Reloading..."));

    // 1. Reload config & AI agent
    try {
      const { loadConfig } = require("./ai-agent");
      this.config = loadConfig();
      this.llm = new LLMClient(this.config);
      this._cachedModels = {};
      this.llmConnected = await this.llm.healthCheck();
      this.terminal.addLine(
        (this.llmConnected ? C.green("  \u2713 AI reloaded") : C.yellow("  \u26A0 AI not available")) +
        C.dim(`  (${this.config.api.provider}: ${this.config.api.model})`)
      );
      // Hint about upstream limits if healthCheck passes but model may still be limited — actual error shows on chat
      if (this.llmConnected) {
        this.terminal.addLine(C.dim("  Tip: if chat still shows upstream errors, try /model to pick a different model or enable balance at opencode.ai"));
      }
    } catch (e) {
      this.terminal.addLine(C.red("  \u2717 AI reload failed: " + e.message));
    }

    // 2. Reload MCP tools
    try {
      if (this.mcpConnected && this.mcp) {
        try { this.mcp.disconnect(); } catch {}
        this.mcpConnected = false;
      }
      this.terminal.addLine(C.dim("  Reconnecting MCP..."));
      await this.mcp.connect();
      this.mcpConnected = true;
      this.terminal.addLine(C.green("  \u2713 MCP reloaded") + C.dim(`  (${this.mcp.tools.length} tools)`));
    } catch (e) {
      this.mcpConnected = false;
      this.terminal.addLine(C.yellow("  \u26A0 MCP unavailable: " + e.message) + C.dim("  (document edits disabled)"));
    }

    // 3. Reload static tools count
    try {
      const { getAllTools } = require("./tools");
      const tools = getAllTools();
      this.terminal.addLine(C.dim(`  Tools: ${tools.length} available`));
    } catch {}

    this.terminal.addLine(C.dim("  Reload complete — try your request again."));
    this._updateHeader();
    this.terminal.setStatus(this.filePath ? require("path").basename(this.filePath) : "ready");
  }

  // -----------------------------------------------------------------------
  // Model modal — real model selector with dynamic fetching
  // -----------------------------------------------------------------------
  async _openModelModal() {
    const current = this.config.api;
    const providerId = current.provider;
    const providerLabel = this._getProviderLabel(providerId);

    // Get models for current provider
    const models = await this._getModelsForProvider(providerId);

    this.terminal.openModelModal({
      models,
      activeModel: current.model,
      providerLabel: providerLabel,
      onSelect: (modelId) => {
        this.terminal.closeModelModal();
        this._applyModel(modelId);
      },
      onCancel: () => {
        this.terminal.closeModelModal();
      },
      onProvider: () => {
        this.terminal.closeModelModal();
        this._openProviderModalFromModel();
      },
    });
  }

  _getProviderLabel(providerId) {
    const p = findProvider(providerId);
    return p ? p.label : providerId;
  }

  async _getModelsForProvider(providerId) {
    // Check cache first
    if (this._cachedModels[providerId]) return this._cachedModels[providerId];

    const provider = findProvider(providerId);
    if (!provider) return MODEL_PRESETS[providerId] || [];

    // For OpenCode providers, fetch from API and tag with group
    if (providerId === "opencode-zen" || providerId === "opencode-go") {
      const models = await fetchModelsFromAPI(provider.baseUrl, this.config.api.apiKey);
      if (models.length > 0) {
        const tagged = models.map((m) => ({ ...m, group: this._modelGroup(m.id, providerId) }));
        this._cachedModels[providerId] = tagged;
        return tagged;
      }
    }

    // For Ollama, fetch from local
    if (providerId === "ollama") {
      const models = await fetchModelsFromAPI("http://localhost:11434", "");
      if (models.length > 0) {
        this._cachedModels[providerId] = models;
        return models;
      }
    }

    // Fall back to static presets
    const presets = MODEL_PRESETS[providerId] || [];
    this._cachedModels[providerId] = presets;
    return presets;
  }

  _modelGroup(modelId, providerId) {
    if (providerId === "opencode-go") return "Go";
    // Zen models — categorize based on live 2026-08-30 list
    const freeModels = [
      "mimo-v2.5-free", "muse-spark-1.2-contributor-free", "deepseek-v4-flash-free",
      "big-pickle", "ling-3.0-flash-fin-free", "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free", "laguna-s-2.1-free",
    ];
    if (freeModels.includes(modelId)) return "Free";
    if (modelId.startsWith("gpt-") || modelId.startsWith("claude-") ||
        modelId.startsWith("gemini-") || modelId.startsWith("grok-")) return "Premium";
    // muse-spark-1.2 (non-free) is Open, not Premium
    return "Open";
  }

  _applyModel(modelId) {
    if (!modelId) return;
    this.config.api.model = modelId;
    saveConfig(this.config);
    this.llm = new LLMClient(this.config);

    const providerLabel = this._getProviderLabel(this.config.api.provider);
    this.terminal.addLine(C.green("  \u2713 Model: ") + C.white.bold(modelId) + C.dim("  (" + providerLabel + ")"));
    this._updateHeader();
  }

  // -----------------------------------------------------------------------
  // Provider modal — triggered from /model via Ctrl+A
  // -----------------------------------------------------------------------
  _openProviderModalFromModel() {
    const current = this.config.api.provider;

    // Close model modal first to avoid dual-modal rendering conflict
    this.terminal.closeModelModal();

    const popularItems = BUILTIN_PROVIDERS.map((p) => ({
      id: p.id, label: p.label, badge: p.badge, desc: p.desc,
    }));

    const extraItems = EXTRA_PROVIDERS.map((p) => ({
      id: p.id, label: p.label, badge: p.badge, desc: p.desc,
    }));

    this.terminal.openProviderModal({
      title: "Select Provider",
      escHint: "esc",
      activeId: current,
      sections: [
        { label: "Popular", items: popularItems },
        { label: "Providers", items: extraItems },
      ],
      onSelect: (id) => {
        this.terminal.closeProviderModal();
        this._applyProvider(id);
        // After selecting provider, re-open model modal with new provider's models
        setTimeout(() => this._openModelModal(), 200);
      },
      onCancel: () => {
        this.terminal.closeProviderModal();
        // Re-open model modal on cancel
        setTimeout(() => this._openModelModal(), 200);
      },
    });
  }

  _applyProvider(providerId) {
    const p = findProvider(providerId);
    if (!p) {
      this.terminal.addLine(C.red("  \u2717 Unknown provider: " + providerId));
      return;
    }

    this.config.api.provider = providerId;
    this.config.api.baseUrl  = p.baseUrl;
    if (p.defaultModel) this.config.api.model = p.defaultModel;
    saveConfig(this.config);
    this.llm = new LLMClient(this.config);

    this.terminal.addLine(C.green("  \u2713 Provider: ") + C.white.bold(p.label) +
      (p.badge ? C.dim("  " + p.badge) : ""));
    this.terminal.addLine(C.dim("  Base URL: ") + C.white(p.baseUrl));
    if (p.defaultModel) {
      this.terminal.addLine(C.dim("  Default model: ") + C.white(p.defaultModel));
    }
    this._updateHeader();
  }

  // -----------------------------------------------------------------------
  // Settings modal — inline editable fields
  // -----------------------------------------------------------------------
  _openSettingsModal() {
    const api = this.config.api;

    const fields = [
      { key: "provider",    label: "Provider",    value: api.provider,              raw: api.provider,    masked: false },
      { key: "baseUrl",     label: "Base URL",    value: api.baseUrl,               raw: api.baseUrl,     masked: false },
      { key: "model",       label: "Model",       value: api.model,                 raw: api.model,       masked: false },
      { key: "apiKey",      label: "API Key",     value: api.apiKey || "(not set)", raw: api.apiKey || "", masked: true  },
      { key: "maxTokens",   label: "Max Tokens",  value: String(api.maxTokens),     raw: String(api.maxTokens), masked: false },
      { key: "temperature", label: "Temperature", value: String(api.temperature),   raw: String(api.temperature), masked: false },
    ];

    this.terminal.openSettingsModal({
      fields,
      onSave: (key, value) => {
        this._saveSettingField(key, value);
        const f = this.terminal.settingsModal.fields.find((x) => x.key === key);
        if (f) {
          f.raw   = value;
          f.value = key === "apiKey" ? "(set)" : value;
        }
        this.terminal.markSettingsDirty();
      },
      onCancel: () => {
        this.terminal.closeSettingsModal();
      },
      onOpenProvider: () => {
        this.terminal.closeSettingsModal();
        this._openProviderModalFromModel();
      },
    });
  }

  _saveSettingField(key, value) {
    const api = this.config.api;

    switch (key) {
      case "provider": {
        const p = findProvider(value);
        if (p) {
          api.provider = p.id;
          api.baseUrl  = p.baseUrl;
          if (p.defaultModel) api.model = p.defaultModel;
          this.terminal.addLine(C.green("  \u2713 Provider: ") + C.white(p.label));
        } else {
          api.provider = value;
          this.terminal.addLine(C.green("  \u2713 Provider: ") + C.white(value));
        }
        break;
      }
      case "baseUrl":
        if (!value) return;
        api.baseUrl = value;
        this.terminal.addLine(C.green("  \u2713 Base URL: ") + C.white(value));
        break;
      case "model":
        if (!value) return;
        api.model = value;
        this.terminal.addLine(C.green("  \u2713 Model: ") + C.white(value));
        break;
      case "apiKey":
        if (!value) return;
        api.apiKey = value;
        this.terminal.addLine(C.green("  \u2713 API key updated."));
        break;
      case "maxTokens": {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 1) { this.terminal.addLine(C.red("  \u2717 Invalid number.")); return; }
        api.maxTokens = n;
        this.terminal.addLine(C.green("  \u2713 Max tokens: ") + C.white(String(n)));
        break;
      }
      case "temperature": {
        const f = parseFloat(value);
        if (isNaN(f) || f < 0 || f > 2) { this.terminal.addLine(C.red("  \u2717 Must be 0.0-2.0.")); return; }
        api.temperature = f;
        this.terminal.addLine(C.green("  \u2713 Temperature: ") + C.white(String(f)));
        break;
      }
    }

    this.config.api = api;
    saveConfig(this.config);
    this.llm = new LLMClient(this.config);
    this._updateHeader();
  }

  // -----------------------------------------------------------------------
  // AI chat
  // -----------------------------------------------------------------------
  async _chatWithAI(userMessage) {
    this.conversationHistory.push({ role: "user", content: userMessage });
    this.terminal.setStatus("thinking...");
    const tools = getAllTools();

    try {
      const response = await this.llm.chat(this.conversationHistory, tools);

      if (response.toolCalls && response.toolCalls.length > 0) {
        this.conversationHistory.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls,
        });
        if (response.content) this._printAIResponse(response.content);

        for (const toolCall of response.toolCalls) {
          const fn = toolCall.function;
          let args;
          try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments; }
          catch (e) { args = {}; }

          this._renderToolCallFromAI(fn.name, args);
          const toolResult = await this._executeTool(fn.name, args);
          this._renderToolResult(fn.name, args, toolResult);

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

        this.terminal.setStatus("processing...");
        // Keep looping until AI stops requesting tools
        let maxRounds = 10;
        while (maxRounds-- > 0) {
          const nextResponse = await this.llm.chat(this.conversationHistory, getAllTools());
          if (nextResponse.content) this._printAIResponse(nextResponse.content);

          if (nextResponse.toolCalls && nextResponse.toolCalls.length > 0) {
            // AI wants more tools — push assistant message and execute them
            this.conversationHistory.push({
              role: "assistant",
              content: nextResponse.content || "",
              tool_calls: nextResponse.toolCalls,
            });
            for (const tc of nextResponse.toolCalls) {
              const fn = tc.function;
              let tcArgs;
              try { tcArgs = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments; }
              catch (e) { tcArgs = {}; }
              this._renderToolCallFromAI(fn.name, tcArgs);
              const tcResult = await this._executeTool(fn.name, tcArgs);
              this._renderToolResult(fn.name, tcArgs, tcResult);
              this.conversationHistory.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify(tcResult),
              });
            }
            this.terminal.setStatus("processing...");
            continue; // loop again
          }

          // No more tool calls — final text response, we're done
          this.conversationHistory.push({ role: "assistant", content: nextResponse.content || "" });
          break;
        }

      } else {
        if (response.content) this._printAIResponse(response.content);
        this.conversationHistory.push({ role: "assistant", content: response.content || "" });
      }
    } catch (e) {
      this.terminal.addLine(C.red("  \u2717 AI error: " + e.message));
      // Extra hint for upstream errors — point to /reload and /model
      if (String(e.message).includes("Upstream") || String(e.message).includes("LLM API")) {
        this.terminal.addLine(C.dim("  Try /reload to refresh MCP/AI, or /model to pick a different model (e.g., Ollama local)."));
        this.terminal.addLine(C.dim("  Zen Free is rate-limited globally; Go weekly limit resets weekly — see https://opencode.ai/billing"));
      }
    }

    this.terminal.setStatus(this.filePath ? path.basename(this.filePath) : "ready");
  }

  _printAIResponse(text) {
    this.terminal.addLine();
    const clean = stripHtml(text);
    const lines = clean.split("\n");
    let inToolCall = false, toolCallLines = [];
    let inTable = false, tableLines = [];
    let inCodeBlock = false, codeLines = [];

    const flushTable = () => { if (tableLines.length) { this._renderMarkdownTable(tableLines); tableLines = []; inTable = false; } };
    const flushCode  = () => { if (codeLines.length) { for (const cl of codeLines) this.terminal.addLine(C.dim("    ") + C.cyan(cl)); codeLines = []; inCodeBlock = false; } };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) { if (inCodeBlock) flushCode(); else inCodeBlock = true; continue; }
      if (inCodeBlock) { codeLines.push(line); continue; }
      if (trimmed.startsWith("<tool_call>"))  { inToolCall = true; toolCallLines = []; continue; }
      if (trimmed.startsWith("</tool_call>")) { inToolCall = false; this._renderToolCallBlock(toolCallLines); toolCallLines = []; continue; }
      if (inToolCall) { toolCallLines.push(trimmed); continue; }
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) { if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue; inTable = true; tableLines.push(trimmed); continue; }
      else if (inTable) flushTable();
      if (trimmed.startsWith("[SUCCESS]")) { this.terminal.addLine(C.green("  \u2713") + C.white(" " + trimmed.replace("[SUCCESS]", "").trim())); continue; }
      if (trimmed.startsWith("[ERROR]"))   { this.terminal.addLine(C.red("  \u2717")   + C.white(" " + trimmed.replace("[ERROR]", "").trim())); continue; }
      if (trimmed.startsWith("[WARN]"))    { this.terminal.addLine(C.yellow("  \u26A0") + C.white(" " + trimmed.replace("[WARN]", "").trim())); continue; }
      if (trimmed.startsWith("[INFO]"))    { this.terminal.addLine(C.cyan("  \u2139")  + C.dim(" "  + trimmed.replace("[INFO]", "").trim())); continue; }
      if (trimmed.startsWith("## "))  { flushTable(); this.terminal.addLine(); this.terminal.addLine(C.pink.bold("  " + trimmed.slice(3))); continue; }
      if (trimmed.startsWith("### ")) { flushTable(); this.terminal.addLine(C.white.bold("  " + trimmed.slice(4))); continue; }
      if (/^[-*_]{3,}$/.test(trimmed)) { this.terminal.addLine(C.dim("  " + "\u2500".repeat(this.terminal.width - 4))); continue; }
      if (trimmed.startsWith("> "))    { this.terminal.addLine(C.dim("  \u2502 ") + C.dim(trimmed.slice(2))); continue; }
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) { this.terminal.addLine(C.dim("    \u2022 ") + this._renderInline(trimmed.slice(2))); continue; }
      if (/^\d+\.\s/.test(trimmed)) { const num = trimmed.match(/^(\d+)\./)[1]; this.terminal.addLine(C.cyan("    " + num + ". ") + this._renderInline(trimmed.replace(/^\d+\.\s+/, ""))); continue; }
      if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) { this.terminal.addLine(C.green("    \u2611 ") + this._renderInline(trimmed.slice(6))); continue; }
      if (trimmed.startsWith("- [ ] ")) { this.terminal.addLine(C.dim("    \u2610 ") + this._renderInline(trimmed.slice(6))); continue; }
      if (!trimmed) { flushTable(); this.terminal.addLine(); continue; }
      this.terminal.addLine("  " + this._renderInline(trimmed));
    }
    flushTable(); flushCode();
    this.terminal.addLine();
  }

  _renderInline(text) {
    if (!text) return "";
    return text
      .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => C.cyan(code.trim()))
      .replace(/`([^`]+)`/g, (_, m) => C.cyan(m))
      .replace(/\*\*(.+?)\*\*/g, (_, m) => C.white.bold(m))
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, m) => C.dim.italic(m))
      .replace(/~~(.+?)~~/g, (_, m) => C.dim.strikethrough(m))
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => C.cyan(text) + C.dim(" <" + url + ">"));
  }

  _renderMarkdownTable(tableLines) {
    if (!tableLines.length) return;
    const rows = tableLines.map((line) =>
      line.split("|").filter((_, i, arr) => i > 0 && i < arr.length - 1).map((c) => c.trim())
    );
    const headers  = rows[0] || [];
    const dataRows = rows.slice(1).map((row) => row.map((cell) => this._renderInline(cell)));
    const table = renderTable({
      headers: headers.map((h) => h.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1")),
      rows: dataRows, maxWidth: this.terminal.width - 4, headerStyle: C.white.bold, dimStyle: C.dim,
    });
    this.terminal.addLine();
    this.terminal.addLines(table, true);
  }

  _renderToolCallBlock(lines) {
    let funcName = ""; const params = {};
    for (const line of lines) {
      const funcMatch  = line.match(/\[FUNCTION\]:\s*(\w+)/);
      if (funcMatch) { funcName = funcMatch[1]; continue; }
      const paramMatch = line.match(/<param name="(\w+)">(.+?)<\/param>/);
      if (paramMatch) { params[paramMatch[1]] = stripHtml(paramMatch[2]); continue; }
    }
    const icons = { scan_document:"\u2609",create_document:"\u270E",open_document:"\u27A4",get_document_text:"\u2630",get_paragraph:"\u2630",search_replace:"\u21C4",word_modify:"\u2692",add_paragraph:"\u2795",add_heading:"\u2795",delete_paragraph:"\u2716",format_text:"\u2592",add_table:"\u25A6",convert_to_pdf:"\u27A4",copy_document:"\u2398",approve_finding:"\u2713",fix_approved:"\u2692",list_documents:"\u2630",get_document_info:"\u2139",get_document_outline:"\u2630",find_text_in_document:"\u2315" };
    const icon = icons[funcName] || "\u2692";
    const paramLines = Object.entries(params).map(([k,v]) => { const d = stripHtml(String(v)); return C.cyan(k) + C.dim(": ") + C.dim(d.length > 40 ? d.slice(0,40)+"\u2026" : d); });
    if (!paramLines.length) paramLines.push(C.dim("no parameters"));
    const panel = renderPanel({ title: C.pink(icon + " " + funcName), lines: paramLines, width: this.terminal.width - 4, dimStyle: C.dim });
    this.terminal.addLines(panel, true);
  }

  _renderToolCallFromAI(name, args) {
    const icons = { scan_document:"\u2609",create_document:"\u270E",open_document:"\u27A4",get_document_text:"\u2630",get_paragraph:"\u2630",search_replace:"\u21C4",word_modify:"\u2692",add_paragraph:"\u2795",add_heading:"\u2795",delete_paragraph:"\u2716",format_text:"\u2592",add_table:"\u25A6",convert_to_pdf:"\u27A4",copy_document:"\u2398",approve_finding:"\u2713",fix_approved:"\u2692",list_documents:"\u2630",get_document_info:"\u2139",get_document_outline:"\u2630",find_text_in_document:"\u2315" };
    const icon = icons[name] || "\u2692";
    const paramLines = Object.entries(args).map(([k,v]) => { const d = stripHtml(String(v)); return C.cyan(k) + C.dim(": ") + this._renderInline(d.length > 50 ? d.slice(0,50)+"\u2026" : d); });
    if (!paramLines.length) paramLines.push(C.dim("no parameters"));
    const panel = renderPanel({ title: C.pink(icon + " " + name), lines: paramLines, width: this.terminal.width - 4, dimStyle: C.dim });
    this.terminal.addLines(panel, true);
  }

  _showFixDiff(original, modified) {
    const cleanOrig = stripHtml(original);
    const cleanMod  = stripHtml(modified);
    if (cleanOrig === cleanMod) return;
    this.terminal.addLine();
    const diffLines = renderSideBySideDiff(cleanOrig, cleanMod, { width: this.terminal.width - 2 });
    this.terminal.addLines(diffLines, true);
  }

  // -----------------------------------------------------------------------
  // Tool execution
  // -----------------------------------------------------------------------
  async _executeTool(name, args) {
    const context = {
      fs, path, exec, os,
      mcp: this.mcp, mcpConnected: this.mcpConnected,
      filePath: this.filePath, scanResult: this.scanResult,
      findings: this.findings, backupPath: this.backupPath,
      terminal: this.terminal,
      modules: { scanDisk, buildFindings, summarizeFindings, FindingStatus, transitionFinding, suggestRewrite, analyzeFinding, scoreParagraph },
    };
    const result = await executeTool(name, args, context);
    if (context.filePath   !== this.filePath)   this.filePath   = context.filePath;
    if (context.scanResult !== this.scanResult) this.scanResult = context.scanResult;
    if (context.findings   !== this.findings)   this.findings   = context.findings;
    if (context.backupPath !== this.backupPath) this.backupPath = context.backupPath;
    if (this.scanResult && this.filePath) this._updateHeader();
    return result;
  }

  _renderToolResult(name, args, result) {
    if (result.error) { this.terminal.addLine(C.red("  \u2717 ") + C.dim(result.error)); return; }
    switch (name) {
      case "scan_document":
        if (result.path) { this._updateHeader(); this.terminal.clearContent(); this._renderFindingsTable(); this.terminal.setStatus(path.basename(this.filePath)); }
        break;
      case "get_findings":
        if (Array.isArray(result.findings)) {
          const table = renderTable({ headers:["ID","Sev","Category","Title","Status"], rows: result.findings.map((f) => [f.id,f.severity,f.category,f.title,f.status]), maxWidth: this.terminal.width - 4, headerStyle: C.white.bold, dimStyle: C.dim });
          this.terminal.addLines(table, true);
        }
        break;
      case "create_document":  if (result.created) this.terminal.addLine(C.green("  \u2713 ") + C.dim("Created ") + C.white(result.created)); break;
      case "open_document":    if (result.opened)  this.terminal.addLine(C.green("  \u2713 ") + C.dim("Opening ") + C.white(result.opened)); break;
      case "search_replace":   if (result.success) this.terminal.addLine(C.green("  \u2713 ") + C.dim("Replaced ") + C.white(result.find) + C.dim(" \u2192 ") + C.green(result.replace)); break;
      case "add_paragraph": case "add_heading": if (result.success) this.terminal.addLine(C.green("  \u2713 ") + C.dim("Added to ") + C.white(result.filename)); break;
      case "delete_paragraph": if (result.success) this.terminal.addLine(C.green("  \u2713 ") + C.dim("Deleted paragraph ") + C.cyan(String(result.deleted))); break;
      case "fix_approved":
        if (result.fixed !== undefined) {
          this.terminal.addLine(C.green("  \u2713 ") + C.dim("Fixed ") + C.cyan(String(result.fixed)) + C.dim("  Failed ") + C.red(String(result.failed)));
          if (result.document) this.terminal.addLine(C.dim("    Document: ") + C.white(result.document));
        }
        break;
      case "approve_finding":  if (result.approved) this.terminal.addLine(C.green("  \u2713 ") + C.dim("Approved ") + C.cyan(String(result.approved))); break;
      case "get_document_text":
        if (result.text) {
          const clean = stripHtml(result.text);
          this.terminal.addLine(C.dim("  Document text (") + C.cyan(String(clean.length)) + C.dim(" chars)"));
          for (const line of clean.slice(0, 1000).split("\n").slice(0, 10)) this.terminal.addLine("    " + this._renderInline(line));
          if (clean.length > 1000) this.terminal.addLine(C.dim("    ..."));
        }
        break;
      case "get_paragraph": if (result.text) { this.terminal.addLine(C.dim("  Paragraph ") + C.cyan(String(result.paragraph))); this.terminal.addLine("    " + this._renderInline(stripHtml(result.text))); } break;
      case "convert_to_pdf":   if (result.success) this.terminal.addLine(C.green("  \u2713 ") + C.dim("Converted to PDF")); break;
      case "list_documents":
        if (result.documents) {
          const docs = typeof result.documents === "string" ? stripHtml(result.documents).split("\n") : [String(result.documents)];
          this.terminal.addLine(C.dim("  Documents in ") + C.white(result.directory));
          for (const doc of docs.slice(0, 10)) if (doc.trim()) this.terminal.addLine(C.dim("    ") + C.white(doc.trim()));
        }
        break;
      case "copy_document":    if (result.copied)  this.terminal.addLine(C.green("  \u2713 ") + C.dim("Copied to ") + C.white(result.to)); break;
      case "get_document_info":
        if (result.info) { for (const line of stripHtml(String(result.info)).split("\n").slice(0,10)) if (line.trim()) this.terminal.addLine(C.dim("    ") + C.dim(line.trim())); }
        break;
      case "get_document_outline":
        if (result.outline) { for (const line of stripHtml(String(result.outline)).split("\n").slice(0,15)) if (line.trim()) this.terminal.addLine(C.dim("    ") + C.dim(line.trim())); }
        break;
      case "find_text_in_document": if (result.result) this.terminal.addLine(C.dim("  Found: ") + this._renderInline(stripHtml(String(result.result)))); break;
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
    if (cmd.endsWith(".docx") && (fs.existsSync(cmd) || fs.existsSync(path.resolve(cmd)))) {
      await this._scanDocument(path.resolve(cmd)); return;
    }
    if (lower.includes("scan") || lower.includes("analyze") || lower.includes("check")) {
      if (this.filePath) await this._scanDocument(this.filePath);
      else this.terminal.addLine(C.bar("  │ ") + C.dim("No document loaded. Drop a .docx file to begin."));
      return;
    }
    if (lower.includes("fix") || lower.includes("repair") || lower.includes("improve")) {
      if (this.findings.length > 0) { this._approveFindings("all"); await this._applyFix("all"); }
      else this.terminal.addLine(C.bar("  │ ") + C.dim("No findings to fix. Scan a document first."));
      return;
    }
    if (lower.includes("help") || lower.includes("what can you do")) { this._printHelp(); return; }
    this.terminal.addLine(C.bar("  │ ") + C.dim("I can help you with Word documents. Try:"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("  \u2022 Drop a .docx file to scan it"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("  \u2022 'scan' to analyze the current document"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("  \u2022 'fix' to apply all fixes"));
    this.terminal.addLine(C.bar("  │ ") + C.dim("  \u2022 'help' for all commands"));
    if (!this.llmConnected) this.terminal.addLine(C.bar("  │ ") + C.dim("  \u2022 /settings to configure AI provider"));
  }

  // -----------------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------------
  _updateHeader() {
    if (this.scanResult && this.filePath) {
      const pct      = this.scanResult.aiPercentage;
      const pctColor = pct >= 50 ? C.red : pct >= 25 ? C.yellow : C.green;
      const verdict  = pct >= 50 ? Const.VERDICTS.high : pct >= 25 ? Const.VERDICTS.medium : Const.VERDICTS.low;
      const summary  = summarizeFindings(this.findings);
      this._setHeader(path.basename(this.filePath), {
        file: path.basename(this.filePath),
        paras: String(this.scanResult.totalBody), score: String(this.scanResult.totalScore),
        pct: pct.toFixed(0), pctColor, verdict,
        high: summary.bySeverity.HIGH, med: summary.bySeverity.MEDIUM, low: summary.bySeverity.LOW,
        total: summary.total, fixable: summary.fixable,
        newCount: summary.byStatus.NEW, approved: summary.byStatus.APPROVED,
        fixed: summary.byStatus.FIXED, failed: summary.byStatus.FAILED,
      });
    } else {
      this._setHeader("WordCheck Agent");
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
      this.terminal.addLine(C.red("  \u2717  Scan failed: " + e.message)); return;
    }
    this.findings = buildFindings(this.scanResult);
    this._updateHeader();
    this.terminal.clearContent();
    this._renderFindingsTable();
    this.terminal.setStatus(path.basename(filePath));
  }

  _renderFindingsTable() {
    if (!this.findings || !this.findings.length) { this.terminal.addLine(C.dim("  No findings.")); return; }
    const headers = ["ID", "Sev", "Category", "Title"];
    const rows    = this.findings.map((f) => {
      const sevBg = f.severity === "HIGH" ? chalk.bgRed.white(" " + f.severity.charAt(0) + " ") :
                    f.severity === "MEDIUM" ? chalk.bgYellow.black(" " + f.severity.charAt(0) + " ") :
                    chalk.bgGreen.black(" " + f.severity.charAt(0) + " ");
      return [C.dim(f.id), sevBg, C.dim(f.category), C.dim(f.title)];
    });
    const table = renderTable({ headers, rows, maxWidth: this.terminal.width - 4, headerStyle: C.white.bold, dimStyle: C.dim });
    this.terminal.addLines(table, true);
    this.terminal.addLine();
    this.terminal.addLine(C.dim("  Type /findings for details, or chat with me about the document."));
  }

  // -----------------------------------------------------------------------
  // UI rendering helpers
  // -----------------------------------------------------------------------
  _setHeader(title, scanSummary) {
    const headerWidth = Math.max(24, this.terminal.width - 2);
    const fit   = (line) => truncateVisible(line, headerWidth);
    const lines = renderWordmark();
    if (scanSummary) {
      lines.push(
        C.bar("  │ ") + C.white.bold(scanSummary.file) +
        C.dim("  │  paras ") + C.cyan(scanSummary.paras) +
        C.dim("  score ") + C.cyan(scanSummary.score) +
        C.dim("  ai ") + scanSummary.pctColor(scanSummary.pct + "%") +
        C.dim("  ") + scanSummary.pctColor(scanSummary.verdict)
      );
      lines.push(
        C.bar("  │ ") +
        renderSeverityBar({ bySeverity: { HIGH: scanSummary.high, MEDIUM: scanSummary.med, LOW: scanSummary.low } }, Math.floor(headerWidth * 0.4)) +
        C.dim("  findings ") + C.cyan(String(scanSummary.total)) +
        C.dim("  open ") + C.cyan(String(scanSummary.newCount ?? scanSummary.fixable)) +
        C.dim("  approved ") + C.cyan(String(scanSummary.approved || 0)) +
        C.dim("  fixed ") + C.cyan(String(scanSummary.fixed || 0)) +
        C.dim("  failed ") + C.cyan(String(scanSummary.failed || 0))
      );
    } else {
      lines.push(C.dim("  AI-Tell Scanner for Word Documents"));
      lines.push(C.bar("  │ ") + C.dim(title));
    }
    this.terminal.setHeader(lines.map(fit));
  }

  _renderFindingsList(showAll) {
    const display = showAll ? this.findings : this.findings.filter((f) => f.status === FindingStatus.NEW);
    if (!display.length) { this.terminal.addLine(C.dim("  No findings.")); return; }
    this.terminal.addLine();
    const headers = ["", "ID", "Sev", "Category", "Title"];
    const rows = display.map((f) => {
      const sevBg    = f.severity === "HIGH" ? chalk.bgRed.white(" " + f.severity + " ") : f.severity === "MEDIUM" ? chalk.bgYellow.black(" " + f.severity + " ") : chalk.bgGreen.black(" " + f.severity + " ");
      const statusDot = f.status === FindingStatus.APPROVED ? C.green("\u25CF") : f.status === FindingStatus.FIXED ? C.cyan("\u25CF") : f.status === FindingStatus.SKIPPED ? C.dim("\u25CB") : f.status === FindingStatus.FAILED ? C.red("\u25CF") : C.dim("\u25CB");
      return [statusDot, C.dim(f.id), sevBg, C.dim(f.category), C.dim(f.title)];
    });
    const table = renderTable({ headers, rows, maxWidth: this.terminal.width - 4, headerStyle: C.white.bold, dimStyle: C.dim });
    this.terminal.addLines(table, true);
    this.terminal.addLine();
  }

  _renderSummary() {
    const s = summarizeFindings(this.findings);
    const panel = renderPanel({ title: C.pink.bold("SUMMARY"), lines: [
      C.dim("total ") + C.cyan(String(s.total)) + C.dim("  fixable ") + C.cyan(String(s.fixable)),
      C.red("HIGH " + s.bySeverity.HIGH) + C.dim("  ") + C.yellow("MED " + s.bySeverity.MEDIUM) + C.dim("  ") + C.green("LOW " + s.bySeverity.LOW),
      C.dim("approved ") + C.green(String(s.approved)) + C.dim("  fixed ") + C.cyan(String(s.fixed)) + C.dim("  failed ") + C.red(String(s.failed)),
    ], dimStyle: C.bar });
    this.terminal.addLines(panel, true);
    this.terminal.addLine();
  }

  _renderStatus() {
    const s = summarizeFindings(this.findings);
    const panel = renderPanel({ title: C.pink.bold("STATUS"), lines: [
      C.dim("AI: ") + (this.llmConnected ? C.green(this.config.api.provider + ":" + this.config.api.model) : C.red("disconnected")),
      C.dim("MCP: ") + (this.mcpConnected ? C.green("connected") : C.red("disconnected")),
      ...(this.filePath   ? [C.dim("Document: ") + C.white(this.filePath)] : []),
      ...(this.backupPath ? [C.dim("Backup: ")  + C.dim(this.backupPath)]  : []),
      C.dim("Findings: ") + C.cyan(String(s.total)) + C.dim("  Fixed: ") + C.cyan(String(s.fixed)),
    ], dimStyle: C.bar });
    this.terminal.addLines(panel, true);
    this.terminal.addLine();
  }

  _printHelp() {
    const cmds = [
      ["/findings","show all findings"],["/new","show new/unreviewed findings"],
      ["/approve all","approve all fixable findings"],["/approve <n>","approve finding #n"],
      ["/skip <n>","skip finding #n"],["/fix all","apply all approved fixes"],
      ["/fix <n>","apply fix for finding #n"],["/diff <n>","side-by-side diff preview"],
      ["/para <n>","inspect paragraph #n"],["/rescan","re-analyze document"],
      ["/settings","configure AI settings (or /modal)"],["/model","change AI model"],
      ["/reload","reload MCP, AI agent, and tools"],["/open","open document in Word"],
      ["/file","show current file path"],
      ["/summary","findings summary"],["/status","connection status"],
      ["/clear","clear screen"],["/help","this help"],["/quit","exit"],
    ];
    const panel = renderPanel({ title: C.pink.bold("COMMANDS"), lines: [
      ...cmds.map(([c,d]) => C.white(c) + C.dim("  " + d)), "",
      C.dim("Tip: type /model then Tab to open the model picker."),
      C.dim("Tip: type /settings or /modal then Tab to open settings."),
      C.dim("Anything without / is sent to AI."),
    ], width: this.terminal.width - 4, dimStyle: C.bar });
    this.terminal.addLines(panel, true);
    this.terminal.addLine();
  }

  _showParagraph(num) {
    const para = this.scanResult?.paragraphs.find((p) => p.index === num);
    if (!para) { this.terminal.addLine(C.red("  \u2717  Paragraph not found.")); return; }
    const riskColor = para.level === "HIGH" ? C.red : para.level === "MEDIUM" ? C.yellow : C.green;
    this.terminal.addLine();
    this.terminal.addLine(C.bar("  │ ") + C.white.bold("Paragraph " + para.index) + "  " + C.cyan("score " + para.score) + "  " + riskColor(para.level));
    this.terminal.addLine(C.bar("  │"));
    const words = para.text.replace(/\s+/g, " ").trim().split(" ");
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > 64 && line) { this.terminal.addLine(C.bar("  │ ") + C.dim(line.trim())); line = w; }
      else { line = line ? line + " " + w : w; }
    }
    if (line) this.terminal.addLine(C.bar("  │ ") + C.dim(line.trim()));
    this.terminal.addLine();
  }

  _showDiff(target) {
    const num     = parseInt(target, 10);
    const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
    if (!finding) { this.terminal.addLine(C.red("  \u2717  Finding not found.")); return; }
    const rewrite = suggestRewrite(finding.originalContent, [finding]);
    if (!rewrite.changed) { this.terminal.addLine(C.dim("  No changes.")); return; }
    const diffLines = renderSideBySideDiff(rewrite.original, rewrite.rewritten, { width: Math.min(this.terminal.width, 120) });
    this.terminal.addLines(diffLines, true);
  }

  _approveFindings(target) {
    if (target === "all") {
      let count = 0;
      for (const f of this.findings) {
        if ((f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) && f.fixable) { transitionFinding(f, FindingStatus.APPROVED); count++; }
      }
      this.terminal.addLine(C.green(`  \u2713  Approved ${count} findings.`));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) { this.terminal.addLine(C.red("  \u2717  Not found.")); return; }
      transitionFinding(finding, FindingStatus.APPROVED);
      this.terminal.addLine(C.green(`  \u2713  ${finding.id} approved.`));
    }
    this._updateHeader();
  }

  _skipFindings(target) {
    if (target === "all") {
      let count = 0;
      for (const f of this.findings) {
        if (f.status === FindingStatus.NEW || f.status === FindingStatus.REVIEWED) { transitionFinding(f, FindingStatus.SKIPPED); count++; }
      }
      this.terminal.addLine(C.dim(`  Skipped ${count}.`));
    } else {
      const num = parseInt(target, 10);
      const finding = this.findings.find((f) => f.id === `F-${String(num).padStart(4, "0")}`);
      if (!finding) { this.terminal.addLine(C.red("  \u2717  Not found.")); return; }
      transitionFinding(finding, FindingStatus.SKIPPED);
      this.terminal.addLine(C.dim(`  Skipped ${finding.id}.`));
    }
    this._updateHeader();
  }

  async _applyFix(target) {
    if (!this.mcpConnected) { this.terminal.addLine(C.red("  \u2717  MCP not connected.")); return; }
    if (!this.filePath)     { this.terminal.addLine(C.red("  \u2717  No document loaded.")); return; }

    if (!this.backupPath) {
      this.terminal.addLine(C.dim("  Creating backup..."));
      try {
        this.backupPath = await this.mcp.createBackup(this.filePath);
        this.terminal.addLine(C.green("  \u2713 ") + C.dim(this.backupPath));
      } catch (e) {
        this.terminal.addLine(C.red("  \u2717 Backup failed: " + e.message)); return;
      }
    }

    const approved = target === "all"
      ? this.findings.filter((f) => f.status === FindingStatus.APPROVED)
      : this.findings.filter((f) => f.id === `F-${String(parseInt(target, 10)).padStart(4, "0")}` && f.status === FindingStatus.APPROVED);

    if (!approved.length) { this.terminal.addLine(C.yellow("  \u26A0 No approved findings. Use /approve all first.")); return; }

    // Group by paragraphIndex to avoid duplicate diffs and duplicate replacements
    const groups = new Map();
    for (const f of approved) {
      const key = f.paragraphIndex;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }

    let fixed = 0, failed = 0;
    for (const [paraIdx, group] of groups) {
      // Resolve original paragraph text from scanResult (most accurate) or first finding
      const para = this.scanResult?.paragraphs.find((p) => p.index === paraIdx);
      const original = para ? para.text : group[0].originalContent;
      if (!original || !original.trim()) {
        for (const f of group) { try { transitionFinding(f, FindingStatus.FAILED, { note: "empty paragraph" }); } catch(e){} }
        failed += group.length;
        continue;
      }

      const rewrite = suggestRewrite(original, group);
      if (!rewrite.changed) {
        for (const f of group) { try { transitionFinding(f, FindingStatus.FAILED, { note: "no change" }); } catch(e){} }
        this.terminal.addLine(C.dim(`  Paragraph ${paraIdx}: no auto-fixable change — skipped.`));
        failed += group.length;
        continue;
      }

      // Show diff once per paragraph (not per finding) with correct values
      this._showFixDiff(rewrite.original, rewrite.rewritten);

      try {
        // Primary: paragraph-level replacement (precise, single occurrence, no global bleed)
        const resultText = await this.mcp.searchAndReplace(this.filePath, original, rewrite.rewritten);
        const success = typeof resultText === "string" && resultText.includes("Replaced");

        if (success) {
          for (const f of group) {
            try { transitionFinding(f, FindingStatus.FIXED); } catch(e){}
            this.changeLog.push({ findingId: f.id, timestamp: Date.now(), paragraphIndex: paraIdx });
          }
          // Keep in-memory scan result in sync so subsequent diffs show correct updated values
          if (para) {
            const rescored = scoreParagraph(rewrite.rewritten, para.index);
            Object.assign(para, rescored);
            // preserve original index
            para.index = paraIdx;
          }
          for (const f of group) f.originalContent = rewrite.rewritten;
          fixed += group.length;
        } else {
          // Fallback: try phrase-level replacements if full paragraph not found (whitespace mismatch)
          // This fallback still respects group filtering via suggestRewrite's map — we extract phrase map
          let fallbackFixed = false;
          const phraseMap = {};
          // Build map of phrase -> replacement from group (only ai_phrase)
          const fullMap = {
            "the present study": "this research", "present study": "this research",
            "moreover": "also", "furthermore": "in addition", "consequently": "so",
            "facilitates": "helps", "enhances": "improves", "underpins": "supports",
            "integral": "essential", "pivotal": "key", "according to": "as noted by",
            "in terms of": "regarding", "significantly": "greatly", "importantly": "notably",
            "essentially": "basically", "fundamentally": "at its core",
            "comprehensive": "thorough", "crucial": "important", "it is important": "it matters",
          };
          for (const f of group) {
            if (f.category === "ai_phrase") {
              const m = f.title.match(/^"([^"]+)"/);
              if (m && fullMap[m[1].toLowerCase()]) phraseMap[m[1]] = fullMap[m[1].toLowerCase()];
            }
            if (f.category === "em_dash") {
              // em-dash handled separately
              await this.mcp.searchAndReplace(this.filePath, "\u2014", ", ");
              fallbackFixed = true;
            }
          }
          let phraseSuccess = 0;
          for (const [find, repl] of Object.entries(phraseMap)) {
            try {
              const r = await this.mcp.searchAndReplace(this.filePath, find, repl);
              if (typeof r === "string" && r.includes("Replaced")) phraseSuccess++;
            } catch (e) {}
          }
          if (phraseSuccess > 0 || fallbackFixed) {
            for (const f of group) { try { transitionFinding(f, FindingStatus.FIXED); } catch(e){} }
            fixed += group.length;
            if (para) {
              const rescored = scoreParagraph(rewrite.rewritten, para.index);
              Object.assign(para, rescored);
              para.index = paraIdx;
            }
            for (const f of group) f.originalContent = rewrite.rewritten;
          } else {
            for (const f of group) { try { transitionFinding(f, FindingStatus.FAILED, { note: String(resultText).slice(0, 100) }); } catch(e){} }
            this.terminal.addLine(C.red(`  \u2717 Paragraph ${paraIdx}: ${String(resultText).slice(0, 120)}`));
            failed += group.length;
          }
        }
      } catch (e) {
        for (const f of group) { try { transitionFinding(f, FindingStatus.FAILED, { note: e.message }); } catch(err){} }
        this.terminal.addLine(C.red(`  \u2717 Paragraph ${paraIdx}: ${e.message}`));
        failed += group.length;
      }
    }

    // Recompute document scores dynamically so header shows correct values (not repeated stale values)
    if (this.scanResult && this.scanResult.paragraphs) {
      const totalScore = this.scanResult.paragraphs.reduce((s, p) => s + (p.score || 0), 0);
      const avgScore = this.scanResult.paragraphs.length > 0 ? totalScore / this.scanResult.paragraphs.length : 0;
      this.scanResult.totalScore = totalScore;
      this.scanResult.aiPercentage = Math.min(Math.round((avgScore / 30) * 100), 100);
      this.scanResult.highCount = this.scanResult.paragraphs.filter((p) => p.level === "HIGH").length;
      this.scanResult.mediumCount = this.scanResult.paragraphs.filter((p) => p.level === "MEDIUM").length;
      this.scanResult.lowCount = this.scanResult.paragraphs.filter((p) => p.level === "LOW").length;
    }

    this.terminal.addLine(C.green(`  \u2713 Fixed ${fixed}, failed ${failed}.`));
    this.terminal.addLine(C.dim("  Document: ") + C.white(this.filePath));
    this._updateHeader();
  }
}

module.exports = Agent;

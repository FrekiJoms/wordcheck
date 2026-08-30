"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const C = require("./constants");
const { SYSTEM_PROMPT } = require("./prompts");
const { getAllTools } = require("./tools");

// ---------------------------------------------------------------------------
// Config — reads from ~/.wordcheck.json or env vars
// ---------------------------------------------------------------------------
const CONFIG_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".wordcheck.json"
);

function loadConfig() {
  // Load .env file if it exists
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }

  const defaults = {
    api: {
      provider: C.LLM_PROVIDER,
      baseUrl: C.LLM_BASE_URL,
      model: C.LLM_MODEL,
      apiKey: process.env.OPENCODE_GO_API_KEY || "",
      maxTokens: C.LLM_MAX_TOKENS,
      temperature: C.LLM_TEMPERATURE,
    },
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      return { ...defaults, ...user, api: { ...defaults.api, ...user.api } };
    }
  } catch (e) { /* ignore */ }

  if (process.env.OPENAI_API_KEY && !defaults.api.apiKey) {
    return {
      api: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        apiKey: process.env.OPENAI_API_KEY,
        maxTokens: C.LLM_MAX_TOKENS,
        temperature: C.LLM_TEMPERATURE,
      },
    };
  }

  return defaults;
}

// ---------------------------------------------------------------------------
// Save config — persist to ~/.wordcheck.json
// ---------------------------------------------------------------------------
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Model presets — live-accurate fallback when /models fetch fails
// Updated 2026-08-30 from https://opencode.ai/zen/v1/models and /zen/go/v1/models
// ---------------------------------------------------------------------------
const MODEL_PRESETS = {
  "opencode-zen": [
    // Free tier — no credits needed but share a global rate-limit pool
    { id: "mimo-v2.5-free", desc: "MiMo V2.5 Free", group: "Free" },
    { id: "muse-spark-1.2-contributor-free", desc: "Muse Spark 1.2 Free", group: "Free" },
    { id: "deepseek-v4-flash-free", desc: "DeepSeek V4 Flash Free", group: "Free" },
    { id: "big-pickle", desc: "Big Pickle", group: "Free" },
    { id: "ling-3.0-flash-fin-free", desc: "Ling 3.0 Flash Fin Free", group: "Free" },
    { id: "nemotron-3-ultra-free", desc: "Nemotron 3 Ultra Free", group: "Free" },
    { id: "nemotron-3.5-lightning-free", desc: "Nemotron 3.5 Lightning Free", group: "Free" },
    { id: "laguna-s-2.1-free", desc: "Laguna S 2.1 Free", group: "Free" },
    // Open models — Zen pay-as-you-go with API key
    { id: "muse-spark-1.2", desc: "Muse Spark 1.2", group: "Open" },
    { id: "deepseek-v4-pro", desc: "DeepSeek V4 Pro", group: "Open" },
    { id: "deepseek-v4-flash", desc: "DeepSeek V4 Flash", group: "Open" },
    { id: "glm-5.2", desc: "GLM 5.2", group: "Open" },
    { id: "glm-5.1", desc: "GLM 5.1", group: "Open" },
    { id: "glm-5", desc: "GLM 5", group: "Open" },
    { id: "minimax-m3", desc: "MiniMax M3", group: "Open" },
    { id: "minimax-m2.7", desc: "MiniMax M2.7", group: "Open" },
    { id: "minimax-m2.5", desc: "MiniMax M2.5", group: "Open" },
    { id: "kimi-k3", desc: "Kimi K3", group: "Open" },
    { id: "kimi-k2.7-code", desc: "Kimi K2.7 Code", group: "Open" },
    { id: "kimi-k2.6", desc: "Kimi K2.6", group: "Open" },
    { id: "kimi-k2.5", desc: "Kimi K2.5", group: "Open" },
    { id: "qwen3.6-plus", desc: "Qwen 3.6 Plus", group: "Open" },
    { id: "qwen3.5-plus", desc: "Qwen 3.5 Plus", group: "Open" },
    // Premium — requires paid credits / billing on opencode.ai
    { id: "claude-sonnet-5", desc: "Claude Sonnet 5", group: "Premium" },
    { id: "claude-sonnet-4-6", desc: "Claude Sonnet 4.6", group: "Premium" },
    { id: "claude-opus-5", desc: "Claude Opus 5", group: "Premium" },
    { id: "claude-opus-4-6", desc: "Claude Opus 4.6", group: "Premium" },
    { id: "claude-haiku-4-5", desc: "Claude Haiku 4.5", group: "Premium" },
    { id: "gemini-3.7-flash", desc: "Gemini 3.7 Flash", group: "Premium" },
    { id: "gemini-3.6-flash", desc: "Gemini 3.6 Flash", group: "Premium" },
    { id: "gemini-3.1-pro", desc: "Gemini 3.1 Pro", group: "Premium" },
    { id: "gpt-5.6-luna", desc: "GPT 5.6 Luna", group: "Premium" },
    { id: "gpt-5.6-terra", desc: "GPT 5.6 Terra", group: "Premium" },
    { id: "gpt-5.6-sol", desc: "GPT 5.6 Sol", group: "Premium" },
    { id: "gpt-5.5-pro", desc: "GPT 5.5 Pro", group: "Premium" },
    { id: "grok-4.6", desc: "Grok 4.6", group: "Premium" },
    { id: "grok-4.5", desc: "Grok 4.5", group: "Premium" },
  ],
  "opencode-go": [
    // Go subscription — weekly allowance, resets weekly (33 live models)
    { id: "mimo-v2.5", desc: "MiMo V2.5", group: "Go" },
    { id: "mimo-v2.5-pro", desc: "MiMo V2.5 Pro", group: "Go" },
    { id: "mimo-v2-pro", desc: "MiMo V2 Pro", group: "Go" },
    { id: "mimo-v2-omni", desc: "MiMo V2 Omni", group: "Go" },
    { id: "deepseek-v4-pro", desc: "DeepSeek V4 Pro", group: "Go" },
    { id: "deepseek-v4-flash", desc: "DeepSeek V4 Flash", group: "Go" },
    { id: "deepseek-v4-flash-vision-exp", desc: "DeepSeek V4 Flash Vision", group: "Go" },
    { id: "glm-5.3-flash", desc: "GLM 5.3 Flash", group: "Go" },
    { id: "glm-5.3", desc: "GLM 5.3", group: "Go" },
    { id: "glm-5.2", desc: "GLM 5.2", group: "Go" },
    { id: "glm-5.1", desc: "GLM 5.1", group: "Go" },
    { id: "glm-5", desc: "GLM 5", group: "Go" },
    { id: "kimi-k3", desc: "Kimi K3", group: "Go" },
    { id: "kimi-k2.7-code", desc: "Kimi K2.7 Code", group: "Go" },
    { id: "kimi-k2.6", desc: "Kimi K2.6", group: "Go" },
    { id: "kimi-k2.5", desc: "Kimi K2.5", group: "Go" },
    { id: "qwen3.8-flash", desc: "Qwen 3.8 Flash", group: "Go" },
    { id: "qwen3.7-plus", desc: "Qwen 3.7 Plus", group: "Go" },
    { id: "qwen3.8-max", desc: "Qwen 3.8 Max", group: "Go" },
    { id: "qwen3.7-max", desc: "Qwen 3.7 Max", group: "Go" },
    { id: "qwen3.6-plus", desc: "Qwen 3.6 Plus", group: "Go" },
    { id: "qwen3.5-plus", desc: "Qwen 3.5 Plus", group: "Go" },
    { id: "grok-4.6", desc: "Grok 4.6", group: "Go" },
    { id: "grok-4.5", desc: "Grok 4.5", group: "Go" },
    { id: "gpt-5.6-luna", desc: "GPT 5.6 Luna", group: "Go" },
    { id: "longcat-2.0", desc: "LongCat 2.0", group: "Go" },
    { id: "hy3", desc: "Hy3", group: "Go" },
    { id: "hy3-preview", desc: "Hy3 Preview", group: "Go" },
    { id: "hy4-preview", desc: "Hy4 Preview", group: "Go" },
    { id: "minimax-m3", desc: "MiniMax M3", group: "Go" },
    { id: "minimax-m2.7", desc: "MiniMax M2.7", group: "Go" },
    { id: "minimax-m2.5", desc: "MiniMax M2.5", group: "Go" },
    { id: "muse-spark-1.2-contributor", desc: "Muse Spark 1.2 Contributor", group: "Go" },
  ],
  openai: [
    { id: "gpt-4o", desc: "GPT-4o" },
    { id: "gpt-4o-mini", desc: "GPT-4o Mini (default)" },
    { id: "gpt-4-turbo", desc: "GPT-4 Turbo" },
    { id: "gpt-4", desc: "GPT-4" },
    { id: "gpt-3.5-turbo", desc: "GPT-3.5 Turbo" },
    { id: "o1", desc: "o1" },
    { id: "o1-mini", desc: "o1 Mini" },
    { id: "o1-pro", desc: "o1 Pro" },
  ],
  ollama: [
    { id: "llama3.1", desc: "LLaMA 3.1 (default)" },
    { id: "llama3.2", desc: "LLaMA 3.2" },
    { id: "llama3.3", desc: "LLaMA 3.3" },
    { id: "codellama", desc: "Code LLaMA" },
    { id: "mistral", desc: "Mistral" },
    { id: "mixtral", desc: "Mixtral 8x7B" },
    { id: "phi3", desc: "Phi-3" },
    { id: "qwen2.5", desc: "Qwen 2.5" },
    { id: "gemma2", desc: "Gemma 2" },
    { id: "deepseek-r1", desc: "DeepSeek R1" },
    { id: "deepseek-coder-v2", desc: "DeepSeek Coder V2" },
    { id: "command-r-plus", desc: "Command R+" },
    { id: "dbrx", desc: "DBRX" },
    { id: "qwen2.5-coder", desc: "Qwen 2.5 Coder" },
  ],
  custom: [
    { id: "custom-model", desc: "Enter custom model ID below" },
  ],
};

const PROVIDER_DEFAULTS = {
  "opencode-zen": { baseUrl: "https://opencode.ai/zen/v1" },
  "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1" },
  openai: { baseUrl: "https://api.openai.com/v1" },
  ollama: { baseUrl: "http://localhost:11434" },
  custom: { baseUrl: "" },
};

// ---------------------------------------------------------------------------
// LLM Client — connects to Ollama, OpenAI, or any compatible API
// ---------------------------------------------------------------------------
class LLMClient {
  constructor(config) {
    this.config = config.api;
    this.provider = this.config.provider;
  }

  async chat(messages, tools = []) {
    // OpenCode Zen/Go and OpenAI use OpenAI-compatible /chat/completions
    if (this.provider === "opencode-zen" || this.provider === "opencode-go" || this.provider === "openai" || this.provider === "custom") {
      return this._chatOpenAI(messages, tools);
    }
    if (this.provider === "ollama") {
      return this._chatOllama(messages, tools);
    }
    return this._chatOpenAI(messages, tools);
  }

  async _chatOllama(messages, tools) {
    const body = {
      model: this.config.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
      options: {
        temperature: this.config.temperature,
        num_predict: this.config.maxTokens,
      },
    };

    // Ollama tool support
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const data = await this._httpRequest(
      `${this.config.baseUrl}/api/chat`,
      "POST",
      body
    );

    const response = JSON.parse(data);
    const msg = response.message || {};

    return {
      content: msg.content || "",
      toolCalls: msg.tool_calls || [],
      role: msg.role || "assistant",
    };
  }

  async _chatOpenAI(messages, tools) {
    const body = {
      model: this.config.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const headers = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const data = await this._httpRequest(
      `${this.config.baseUrl}/chat/completions`,
      "POST",
      body,
      headers
    );

    const response = JSON.parse(data);
    const choice = response.choices?.[0];
    const msg = choice?.message || {};

    return {
      content: msg.content || "",
      toolCalls: msg.tool_calls || [],
      role: msg.role || "assistant",
    };
  }

  _httpRequest(url, method, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;

      const isGet = method === "GET";
      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
        },
      };

      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            const pretty = this._formatUpstreamError(res.statusCode, data);
            reject(new Error(pretty));
          }
        });
      });

      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  _formatUpstreamError(status, rawBody) {
    let hint = "";
    let detail = rawBody.slice(0, 800);
    try {
      const parsed = JSON.parse(rawBody);
      const err = parsed.error || parsed;
      const type = err.type || "";
      const msg = err.message || rawBody.slice(0, 400);
      detail = `${type ? type + ": " : ""}${msg}`;
      if (type === "FreeUsageLimitError") {
        hint = " — Free-tier quota exhausted (global rate limit). Try a Go model (/model → Go), wait a bit, or switch to Ollama/local. No API key change will fix free-tier exhaustion; pick a different Free model or wait.";
      } else if (type === "GoUsageLimitError") {
        const meta = parsed.metadata || {};
        const when = msg.match(/Resets in ([^.]+)\./);
        hint = ` — Go weekly allowance hit${when ? ` (resets in ${when[1]})` : ""}. Enable balance usage at https://opencode.ai/workspace/${meta.workspace || "…"}/go or switch to a Zen Open/Premium model, or use Ollama.`;
      } else if (type === "CreditsError") {
        hint = " — Zen Premium requires paid credits. Add credits at https://opencode.ai/workspace/…/billing or pick a Free/Open model (/model).";
      } else if (type === "AuthError") {
        hint = " — Missing/invalid API key. Check ~/.wordcheck.json → api.apiKey or run /settings.";
      } else if (status === 404) {
        hint = " — Model not found on this endpoint. Run /reload or /model and pick a model listed for the current provider (Zen vs Go have different lists).";
      } else if (status === 429) {
        hint = " — Rate limited. Try another model or wait.";
      }
    } catch {}
    return `Upstream LLM API ${status}: ${detail}${hint}`;
  }

  /** Check if the LLM is reachable */
  async healthCheck() {
    try {
      if (this.provider === "ollama") {
        await this._httpRequest(`${this.config.baseUrl}/api/tags`, "GET");
        return true;
      }
      // OpenCode Go / OpenAI — check if we have an API key
      if (this.config.apiKey) {
        // Try listing models
        try {
          await this._httpRequest(`${this.config.baseUrl}/models`, "GET", null, {
            "Authorization": `Bearer ${this.config.apiKey}`,
          });
        } catch {
          // Models endpoint may not exist, but key is set — assume OK
        }
        return true;
      }
      return false;
    } catch {
      return !!this.config.apiKey;
    }
  }
}

module.exports = { LLMClient, getAllTools, SYSTEM_PROMPT, loadConfig, saveConfig, MODEL_PRESETS, PROVIDER_DEFAULTS, CONFIG_FILE };

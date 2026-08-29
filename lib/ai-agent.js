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
// LLM Client — connects to Ollama, OpenAI, or any compatible API
// ---------------------------------------------------------------------------
class LLMClient {
  constructor(config) {
    this.config = config.api;
    this.provider = this.config.provider;
  }

  async chat(messages, tools = []) {
    // OpenCode Go uses OpenAI-compatible /chat/completions
    if (this.provider === "opencode-go" || this.provider === "openai" || this.provider === "custom") {
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
            reject(new Error(`LLM API error ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on("error", reject);
      req.write(JSON.stringify(body));
      req.end();
    });
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

module.exports = { LLMClient, getAllTools, SYSTEM_PROMPT, loadConfig };

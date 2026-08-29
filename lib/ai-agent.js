"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// ---------------------------------------------------------------------------
// Config — reads from ~/.wordcheck.json or env vars
// ---------------------------------------------------------------------------
const CONFIG_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".wordcheck.json"
);

function loadConfig() {
  const defaults = {
    api: {
      provider: "ollama",       // "ollama", "openai", or "custom"
      baseUrl: "http://localhost:11434",  // Ollama default
      model: "llama3.2",        // model name
      apiKey: "",               // for OpenAI/custom
      maxTokens: 2048,
      temperature: 0.3,
    },
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      return { ...defaults, ...user, api: { ...defaults.api, ...user.api } };
    }
  } catch (e) { /* ignore */ }

  // Check env vars
  if (process.env.OPENAI_API_KEY) {
    return {
      api: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        apiKey: process.env.OPENAI_API_KEY,
        maxTokens: 2048,
        temperature: 0.3,
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
      // For OpenAI, just check if we can reach the endpoint
      return !!this.config.apiKey;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Agent Tools — what the AI can do
// ---------------------------------------------------------------------------
function getAgentTools() {
  return [
    {
      name: "scan_document",
      description: "Scan a Word document for AI-generated content patterns. Returns findings with severity, category, and suggestions.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the .docx file" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "get_finding_detail",
      description: "Get detailed analysis of a specific finding including AI analysis and suggested fixes.",
      parameters: {
        type: "object",
        properties: {
          finding_id: { type: "string", description: "Finding ID like F-0001" },
        },
        required: ["finding_id"],
      },
    },
    {
      name: "approve_finding",
      description: "Approve a finding for fixing. The fix will be applied to the document when fix_approved is called.",
      parameters: {
        type: "object",
        properties: {
          finding_id: { type: "string", description: "Finding ID or 'all' to approve all fixable findings" },
        },
        required: ["finding_id"],
      },
    },
    {
      name: "fix_approved",
      description: "Apply all approved fixes to the document via MCP. Creates a backup first.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "edit_paragraph",
      description: "Edit a specific paragraph in the document. Use this to make targeted changes.",
      parameters: {
        type: "object",
        properties: {
          paragraph_index: { type: "number", description: "Paragraph number (1-based)" },
          new_text: { type: "string", description: "The replacement text for the paragraph" },
        },
        required: ["paragraph_index", "new_text"],
      },
    },
    {
      name: "search_replace",
      description: "Find and replace text in the document.",
      parameters: {
        type: "object",
        properties: {
          find_text: { type: "string", description: "Text to find" },
          replace_text: { type: "string", description: "Replacement text" },
        },
        required: ["find_text", "replace_text"],
      },
    },
    {
      name: "get_document_text",
      description: "Read the full text content of the document.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_paragraph",
      description: "Read a specific paragraph from the document.",
      parameters: {
        type: "object",
        properties: {
          paragraph_index: { type: "number", description: "Paragraph number (1-based)" },
        },
        required: ["paragraph_index"],
      },
    },
    {
      name: "list_documents",
      description: "List all .docx files in a directory.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory path (defaults to current directory)" },
        },
      },
    },
    {
      name: "create_document",
      description: "Create a new Word document.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path for the new document" },
          title: { type: "string", description: "Document title" },
        },
        required: ["filename"],
      },
    },
    {
      name: "copy_document",
      description: "Copy a document to a new location.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source file path" },
          destination: { type: "string", description: "Destination file path" },
        },
        required: ["source", "destination"],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are WordCheck, an AI agent specialized in analyzing, editing, and improving Word documents (.docx files).

Your capabilities:
- Scan documents for AI-generated content patterns (repetitive phrases, uniform sentence structure, lack of contractions, etc.)
- Edit paragraphs directly in the document
- Search and replace text
- Create new documents
- Copy documents
- Apply fixes to improve writing quality

When the user gives you a document:
1. Scan it first to identify issues
2. Explain what you found in plain language
3. Suggest specific fixes
4. Apply fixes when the user approves

When the user asks you to edit something:
1. Read the current content
2. Make the requested changes
3. Confirm what was changed

Always be direct, helpful, and specific. Use the tools available to you.

If the user says "hi" or greets you, respond naturally and ask what document they'd like to work on.`;

module.exports = { LLMClient, getAgentTools, SYSTEM_PROMPT, loadConfig };

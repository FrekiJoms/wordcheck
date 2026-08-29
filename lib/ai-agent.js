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
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "mimo-v2.5-pro",
      apiKey: process.env.OPENCODE_GO_API_KEY || "",
      maxTokens: 4096,
      temperature: 0.3,
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
        maxTokens: 4096,
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

// ---------------------------------------------------------------------------
// Agent Tools — what the AI can do
// Matches actual MCP server tools + local extensions
// ---------------------------------------------------------------------------
function getAgentTools() {
  return [
    // --- WordCheck analysis tools ---
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
      description: "Approve a finding for fixing.",
      parameters: {
        type: "object",
        properties: {
          finding_id: { type: "string", description: "Finding ID or 'all'" },
        },
        required: ["finding_id"],
      },
    },
    {
      name: "fix_approved",
      description: "Apply all approved fixes to the document.",
      parameters: { type: "object", properties: {} },
    },
    // --- MCP document tools ---
    {
      name: "create_document",
      description: "Create a new Word document. Defaults to user's Documents folder if no path given.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename or full path. If just a name (e.g. 'report.docx'), saves to Documents folder." },
          title: { type: "string", description: "Document title" },
          author: { type: "string", description: "Document author" },
        },
        required: ["filename"],
      },
    },
    {
      name: "open_document",
      description: "Open a document in the user's default Word application.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the .docx file" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "get_document_text",
      description: "Read the full text content of a document.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
        },
        required: ["filename"],
      },
    },
    {
      name: "get_paragraph",
      description: "Read a specific paragraph from a document.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
          paragraph_index: { type: "number", description: "Paragraph number (1-based)" },
        },
        required: ["filename", "paragraph_index"],
      },
    },
    {
      name: "search_replace",
      description: "Find and replace text in a document.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
          find_text: { type: "string", description: "Text to find" },
          replace_text: { type: "string", description: "Replacement text" },
        },
        required: ["filename", "find_text", "replace_text"],
      },
    },
    {
      name: "add_paragraph",
      description: "Add a paragraph to a document with optional formatting.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
          text: { type: "string", description: "Paragraph text content" },
          style: { type: "string", description: "Paragraph style name" },
          font_name: { type: "string", description: "Font family (e.g. 'Times New Roman')" },
          font_size: { type: "number", description: "Font size in points" },
          bold: { type: "boolean" },
          italic: { type: "boolean" },
          color: { type: "string", description: "Hex RGB color (e.g. '000000')" },
        },
        required: ["filename", "text"],
      },
    },
    {
      name: "add_heading",
      description: "Add a heading to a document.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
          text: { type: "string", description: "Heading text" },
          level: { type: "number", description: "Heading level 1-9" },
          font_name: { type: "string" },
          font_size: { type: "number" },
          bold: { type: "boolean" },
          italic: { type: "boolean" },
        },
        required: ["filename", "text"],
      },
    },
    {
      name: "delete_paragraph",
      description: "Delete a paragraph from a document by index.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
          paragraph_index: { type: "number", description: "Paragraph number (1-based)" },
        },
        required: ["filename", "paragraph_index"],
      },
    },
    {
      name: "add_table",
      description: "Add a table to a document.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string" },
          rows: { type: "number" },
          cols: { type: "number" },
          data: { type: "array", description: "2D array of cell data" },
        },
        required: ["filename", "rows", "cols"],
      },
    },
    {
      name: "convert_to_pdf",
      description: "Convert a Word document to PDF.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
          output_filename: { type: "string", description: "Output PDF path (optional)" },
        },
        required: ["filename"],
      },
    },
    {
      name: "list_documents",
      description: "List all .docx files in a directory.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory path (defaults to Documents folder)" },
        },
      },
    },
    {
      name: "copy_document",
      description: "Copy a document to a new location.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string" },
          destination: { type: "string" },
        },
        required: ["source", "destination"],
      },
    },
    {
      name: "get_document_info",
      description: "Get metadata about a document (page count, paragraphs, etc).",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string" },
        },
        required: ["filename"],
      },
    },
    {
      name: "get_document_outline",
      description: "Get the heading structure of a document.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string" },
        },
        required: ["filename"],
      },
    },
    {
      name: "find_text_in_document",
      description: "Search for specific text in a document and return its location.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string" },
          text_to_find: { type: "string" },
        },
        required: ["filename", "text_to_find"],
      },
    },
    {
      name: "format_text",
      description: "Format text in a paragraph (bold, italic, color, font, etc).",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string" },
          paragraph_index: { type: "number" },
          start_pos: { type: "number" },
          end_pos: { type: "number" },
          bold: { type: "boolean" },
          italic: { type: "boolean" },
          underline: { type: "boolean" },
          color: { type: "string" },
          font_size: { type: "number" },
          font_name: { type: "string" },
        },
        required: ["filename", "paragraph_index", "start_pos", "end_pos"],
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
- Create new documents (saved to user's Documents folder by default)
- Open documents in Microsoft Word
- Format text (bold, italic, fonts, colors)
- Add headings, paragraphs, tables, page breaks
- Delete paragraphs
- Convert to PDF
- Copy documents
- Apply fixes to improve writing quality

When creating a new document:
- If the user just gives a filename (e.g. "report.docx"), save it to their Documents folder: C:\\Users\\<username>\\Documents\\<filename>
- After creating, tell the user the full file path so they can Ctrl+click to open it
- Use the open_document tool to open it in Word if they want

When the user gives you a document:
1. Scan it first to identify issues
2. Explain what you found in plain language
3. Suggest specific fixes
4. Apply fixes when the user approves

When the user asks you to edit something:
1. Read the current content first
2. Make the requested changes
3. Confirm what was changed and show the file path

Always be direct, helpful, and specific. Use the tools available to you.

If the user says "hi" or greets you, respond naturally and ask what document they'd like to work on.`;

module.exports = { LLMClient, getAgentTools, SYSTEM_PROMPT, loadConfig };

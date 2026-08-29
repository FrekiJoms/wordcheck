"use strict";

const { spawn } = require("child_process");
const path = require("path");

// ---------------------------------------------------------------------------
// MCP Client — spawns the Word MCP server and communicates via stdio
// JSON-RPC 2.0 over stdio (newline-delimited JSON)
// ---------------------------------------------------------------------------

class MCPClient {
  constructor() {
    this.proc = null;
    this.requestId = 0;
    this.pending = new Map(); // id → { resolve, reject, timeout }
    this.buffer = "";
    this.connected = false;
    this.tools = [];
    this.serverPath = null;
    this.capabilities = {};
  }

  /**
   * Connect to the Word MCP server.
   * @param {string} [serverPath] — path to word_mcp_server.py. Defaults to the
   *   path configured in opencode.jsonc.
   */
  async connect(serverPath) {
    this.serverPath = serverPath || path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      "Documents", "Tools", "office-word-mcp-server", "word_mcp_server.py"
    );

    return new Promise((resolve, reject) => {
      const serverDir = path.dirname(this.serverPath);

      // Use uv to run the server (same as opencode.jsonc config)
      this.proc = spawn("uv", ["--directory", serverDir, "run", "python", path.basename(this.serverPath)], {
        cwd: serverDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.stdout.on("data", (data) => this._onData(data));
      this.proc.stderr.on("data", (data) => {
        // MCP servers log to stderr; ignore unless it's a crash
        const msg = data.toString();
        if (msg.includes("Error") || msg.includes("Traceback")) {
          console.error("[mcp] " + msg.trim());
        }
      });

      this.proc.on("error", (err) => {
        this.connected = false;
        reject(new Error(`MCP server spawn failed: ${err.message}`));
      });

      this.proc.on("exit", (code) => {
        this.connected = false;
        if (code !== 0 && code !== null) {
          console.error(`[mcp] server exited with code ${code}`);
        }
      });

      // Send initialize request
      this._sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "wordcheck", version: "1.1.1" },
      }, 10000).then((result) => {
        this.capabilities = result.capabilities || {};
        this.connected = true;

        // Send initialized notification
        this._sendNotification("notifications/initialized", {});

        // Fetch tools list
        return this._sendRequest("tools/list", {});
      }).then((result) => {
        this.tools = result.tools || [];
        resolve(this.tools);
      }).catch((err) => {
        this.connected = false;
        reject(err);
      });
    });
  }

  /** List available tools */
  listTools() {
    return this.tools;
  }

  /** Find a tool by name */
  getTool(name) {
    return this.tools.find((t) => t.name === name);
  }

  /** Call an MCP tool */
  async callTool(name, args = {}) {
    if (!this.connected) {
      throw new Error("MCP client not connected");
    }

    const tool = this.getTool(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}. Available: ${this.tools.map((t) => t.name).join(", ")}`);
    }

    const result = await this._sendRequest("tools/call", { name, arguments: args }, 30000);

    // Extract text content from MCP result
    if (result.content && Array.isArray(result.content)) {
      return result.content.map((c) => c.text || "").join("\n");
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Document-specific helpers
  // -----------------------------------------------------------------------

  /** Copy source file to a backup before modification */
  async createBackup(sourcePath) {
    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, ".docx");
    const backupPath = path.join(dir, `${base}.wordcheck-backup.docx`);
    await this.callTool("copy_document", {
      source_filename: sourcePath,
      destination_filename: backupPath,
    });
    return backupPath;
  }

  /** Search and replace text in a document */
  async searchAndReplace(filePath, findText, replaceText) {
    return this.callTool("search_and_replace", {
      filename: filePath,
      find_text: findText,
      replace_text: replaceText,
    });
  }

  /** Get full document text */
  async getDocumentText(filePath) {
    return this.callTool("get_document_text", { filename: filePath });
  }

  /** Get paragraph text by index */
  async getParagraphText(filePath, paragraphIndex) {
    return this.callTool("get_paragraph_text_from_document", {
      filename: filePath,
      paragraph_index: paragraphIndex,
    });
  }

  /** Find text in document and return location */
  async findText(filePath, textToFind) {
    return this.callTool("find_text_in_document", {
      filename: filePath,
      text_to_find: textToFind,
    });
  }

  /** Get document info */
  async getDocumentInfo(filePath) {
    return this.callTool("get_document_info", { filename: filePath });
  }

  /** List available documents in a directory */
  async listDocuments(directory) {
    return this.callTool("list_available_documents", { directory });
  }

  // -----------------------------------------------------------------------
  // Transport
  // -----------------------------------------------------------------------

  _onData(data) {
    this.buffer += data.toString();
    // MCP stdio transport: messages separated by newlines
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (e) {
        // non-JSON output (log line from server), ignore
      }
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined) {
      // Response
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timeout);
        if (msg.error) {
          pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
    // Notifications (no id) are ignored for now
  }

  _sendRequest(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout: timer });

      this.proc.stdin.write(msg, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`MCP write failed: ${err.message}`));
        }
      });
    });
  }

  _sendNotification(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(msg);
  }

  /** Disconnect from the server */
  disconnect() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
    this.connected = false;
  }
}

module.exports = MCPClient;

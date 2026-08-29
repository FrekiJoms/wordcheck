"use strict";

function getEditTools() {
  return [
    {
      name: "word_modify",
      description: "Universal document modifier. Chains multiple Word operations (search_replace, add_paragraph, add_heading, delete_paragraph, add_table, format_text, add_page_break, add_picture, add_footnote, add_endnote, merge_table_cells, set_table_cell_shading, set_table_column_width, word_search_and_replace) into a single call. Each operation runs sequentially via MCP. Use this instead of calling individual tools.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
          operations: {
            type: "array",
            description: "List of operations to execute sequentially",
            items: {
              type: "object",
              properties: {
                tool: {
                  type: "string",
                  description: "MCP tool name (e.g. search_and_replace, add_paragraph, add_heading, delete_paragraph, add_table, format_text, add_page_break, add_picture, add_footnote, add_endnote, merge_table_cells, set_table_cell_shading, set_table_column_width)",
                },
                params: {
                  type: "object",
                  description: "Parameters for the tool (filename is auto-injected if omitted)",
                },
              },
              required: ["tool"],
            },
          },
        },
        required: ["filename", "operations"],
      },
    },
    {
      name: "search_replace",
      description: "Find and replace text in a document.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string" },
          find_text: { type: "string" },
          replace_text: { type: "string" },
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
          filename: { type: "string" },
          text: { type: "string" },
          style: { type: "string" },
          font_name: { type: "string" },
          font_size: { type: "number" },
          bold: { type: "boolean" },
          italic: { type: "boolean" },
          color: { type: "string" },
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
          filename: { type: "string" },
          text: { type: "string" },
          level: { type: "number" },
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
          filename: { type: "string" },
          paragraph_index: { type: "number" },
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
          data: { type: "array" },
        },
        required: ["filename", "rows", "cols"],
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

async function executeEditTool(name, args, context) {
  const toolNames = new Set(["word_modify", "search_replace", "add_paragraph", "add_heading", "delete_paragraph", "add_table", "format_text"]);
  if (!toolNames.has(name)) return null;

  const C = require("../constants");
  const getFilename = () => args.filename || context.filePath;

  switch (name) {
    case "word_modify": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      const ops = args.operations || [];
      if (ops.length === 0) return { error: "No operations provided" };

      const results = [];
      let succeeded = 0;
      let failed = 0;

      // Notify terminal of tool progress start
      if (context.terminal && context.terminal.showToolProgress) {
        context.terminal.showToolProgress(ops.map((op) => op.tool));
      }

      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const toolName = op.tool;
        const params = { ...op.params, filename };

        // Update progress — highlight current tool
        if (context.terminal && context.terminal.updateToolProgress) {
          context.terminal.updateToolProgress(i);
        }

        try {
          const result = await context.mcp.callTool(toolName, params);
          results.push({ tool: toolName, success: true, result });
          succeeded++;
        } catch (e) {
          results.push({ tool: toolName, success: false, error: e.message });
          failed++;
        }
      }

      // Mark progress complete
      if (context.terminal && context.terminal.hideToolProgress) {
        context.terminal.hideToolProgress();
      }

      return {
        success: failed === 0,
        filename,
        total: ops.length,
        succeeded,
        failed,
        results,
      };
    }
    case "search_replace": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        await context.mcp.searchAndReplace(filename, args.find_text, args.replace_text);
        return { success: true, filename, find: args.find_text, replace: args.replace_text };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "add_paragraph": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("add_paragraph", {
          filename, text: args.text, style: args.style,
          font_name: args.font_name, font_size: args.font_size,
          bold: args.bold, italic: args.italic, color: args.color,
        });
        return { success: true, filename, result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "add_heading": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("add_heading", {
          filename, text: args.text, level: args.level || 1,
          font_name: args.font_name, font_size: args.font_size,
          bold: args.bold, italic: args.italic,
        });
        return { success: true, filename, result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "delete_paragraph": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("delete_paragraph", {
          filename, paragraph_index: args.paragraph_index,
        });
        return { success: true, filename, deleted: args.paragraph_index, result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "add_table": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("add_table", {
          filename, rows: args.rows, cols: args.cols, data: args.data,
        });
        return { success: true, filename, result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "format_text": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("format_text", {
          filename, paragraph_index: args.paragraph_index,
          start_pos: args.start_pos, end_pos: args.end_pos,
          bold: args.bold, italic: args.italic, underline: args.underline,
          color: args.color, font_size: args.font_size, font_name: args.font_name,
        });
        return { success: true, filename, result };
      } catch (e) {
        return { error: e.message };
      }
    }

    default:
      return null;
  }
}

module.exports = { getEditTools, executeEditTool };

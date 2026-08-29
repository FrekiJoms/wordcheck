"use strict";

function getEditTools() {
  return [
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
  const toolNames = new Set(["search_replace", "add_paragraph", "add_heading", "delete_paragraph", "add_table", "format_text"]);
  if (!toolNames.has(name)) return null;

  const C = require("../constants");
  const getFilename = () => args.filename || context.filePath;

  switch (name) {
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

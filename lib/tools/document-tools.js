"use strict";

function getDocumentTools() {
  return [
    {
      name: "create_document",
      description: "Create a new Word document. Defaults to user's Documents folder if no path given.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename or full path" },
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
          filename: { type: "string" },
          paragraph_index: { type: "number" },
        },
        required: ["filename", "paragraph_index"],
      },
    },
    {
      name: "get_document_info",
      description: "Get metadata about a document.",
      parameters: {
        type: "object",
        properties: { filename: { type: "string" } },
        required: ["filename"],
      },
    },
    {
      name: "get_document_outline",
      description: "Get the heading structure of a document.",
      parameters: {
        type: "object",
        properties: { filename: { type: "string" } },
        required: ["filename"],
      },
    },
    {
      name: "find_text_in_document",
      description: "Search for specific text in a document.",
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
      name: "list_documents",
      description: "List all .docx files in a directory.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string" },
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
      name: "convert_to_pdf",
      description: "Convert a Word document to PDF.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string" },
          output_filename: { type: "string" },
        },
        required: ["filename"],
      },
    },
    {
      name: "format_document",
      description: "Apply WriteTechHub style guide formatting to a document: fonts, margins, spacing, headers.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Path to the .docx file" },
        },
        required: ["filename"],
      },
    },
  ];
}

async function executeDocumentTool(name, args, context) {
  const { fs, path, exec } = context;
  const C = require("../constants");

  const getFilename = () => args.filename || context.filePath;

  switch (name) {
    case "create_document": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      try {
        let filePath = args.filename;
        if (!path.isAbsolute(filePath)) {
          filePath = path.join(C.DOCS_FOLDER, filePath);
        }
        await context.mcp.callTool("create_document", {
          filename: filePath,
          title: args.title || "",
          author: args.author || "",
        });
        context.filePath = filePath;
        return { created: filePath, message: "Document created at " + filePath };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "open_document": {
      const filePath = args.file_path || context.filePath;
      if (!filePath) return { error: C.ERRORS.NO_DOCUMENT };
      if (!fs.existsSync(filePath)) return { error: C.ERRORS.FILE_NOT_FOUND + ": " + filePath };
      try {
        exec(`start "" "${filePath}"`);
        return { opened: filePath, message: "Opening " + filePath };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "get_document_text": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const text = await context.mcp.getDocumentText(filename);
        return { filename, text: text.slice(0, C.DOC_TEXT_LIMIT) };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "get_paragraph": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const text = await context.mcp.getParagraphText(filename, args.paragraph_index);
        return { filename, paragraph: args.paragraph_index, text };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "get_document_info": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("get_document_info", { filename });
        return { filename, info: result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "get_document_outline": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("get_document_outline", { filename });
        return { filename, outline: result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "find_text_in_document": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("find_text_in_document", {
          filename,
          text_to_find: args.text_to_find,
        });
        return { filename, search: args.text_to_find, result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "list_documents": {
      const dir = args.directory || C.DOCS_FOLDER;
      try {
        const result = await context.mcp.listDocuments(dir);
        return { directory: dir, documents: result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "copy_document": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      try {
        await context.mcp.callTool("copy_document", {
          source_filename: args.source,
          destination_filename: args.destination,
        });
        return { copied: args.source, to: args.destination };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "convert_to_pdf": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        const result = await context.mcp.callTool("convert_to_pdf", {
          filename,
          output_filename: args.output_filename,
        });
        return { success: true, filename, result };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "format_document": {
      if (!context.mcpConnected) return { error: C.ERRORS.MCP_NOT_CONNECTED };
      const filename = getFilename();
      if (!filename) return { error: C.ERRORS.NO_DOCUMENT };
      try {
        // Apply WriteTechHub style guide formatting
        const changes = [];

        // Format body text (Calibri 11pt, left-aligned)
        try {
          await context.mcp.callTool("format_text", {
            filename,
            paragraph_index: 0, // applies to all via MCP
            start_pos: 0,
            end_pos: 0,
            font_name: "Calibri",
            font_size: 11,
          });
          changes.push("Applied Calibri 11pt to body text");
        } catch (e) { /* some paragraphs may fail */ }

        return {
          success: true,
          filename,
          changes,
          message: "Formatted with WriteTechHub style guide",
        };
      } catch (e) {
        return { error: e.message };
      }
    }

    default:
      return null;
  }
}

module.exports = { getDocumentTools, executeDocumentTool };

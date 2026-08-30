"use strict";

function getSessionTools() {
  return [
    {
      name: "create_session",
      description: "Create a new session. If a file is scanned, title is auto-derived from document name. If no file, provide a short 3-5 word title (AI-decided). ALWAYS ask user to confirm before creating multiple sessions in one turn.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Session title (3-5 words). Required when no file is scanned; ignored when file is present (auto from doc name)." },
          file_path: { type: "string", description: "Optional file path to associate with the new session. If provided, title is auto-derived." },
        },
      },
    },
    {
      name: "switch_session",
      description: "Switch active session by ID. Lists available sessions via list_sessions first.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID (e.g. sess_...)" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "list_sessions",
      description: "List all previous sessions with IDs, titles, file, date, and active status.",
      parameters: { type: "object", properties: {} },
    },
  ];
}

async function executeSessionTool(name, args, context) {
  const names = new Set(["create_session", "switch_session", "list_sessions"]);
  if (!names.has(name)) return null;

  const agent = context.agent;
  if (!agent) return { error: "Session context not available" };

  switch (name) {
    case "list_sessions":
      return agent._toolListSessions();
    case "switch_session":
      if (!args.session_id) return { error: "session_id required" };
      return agent._toolSwitchSession(args.session_id);
    case "create_session":
      return agent._toolCreateSession(args.title, args.file_path);
    default:
      return null;
  }
}

module.exports = { getSessionTools, executeSessionTool };

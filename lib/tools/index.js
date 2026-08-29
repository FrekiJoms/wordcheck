"use strict";

const { getScanTools, executeScanTool } = require("./scan-tools");
const { getDocumentTools, executeDocumentTool } = require("./document-tools");
const { getEditTools, executeEditTool } = require("./edit-tools");

function getAllTools() {
  return [
    ...getScanTools(),
    ...getDocumentTools(),
    ...getEditTools(),
  ];
}

async function executeTool(name, args, context) {
  // Try scan tools first
  let result = await executeScanTool(name, args, context);
  if (result !== null) return result;

  // Try document tools
  result = await executeDocumentTool(name, args, context);
  if (result !== null) return result;

  // Try edit tools
  result = await executeEditTool(name, args, context);
  if (result !== null) return result;

  return { error: "Unknown tool: " + name };
}

module.exports = { getAllTools, executeTool };

"use strict";
const path = require("path");
const os = require("os");

module.exports = {
  // App
  APP_NAME: "wordcheck",
  APP_DESC: "AI-Tell Scanner for Word Documents",
  VERSION: require("../package.json").version,

  // Paths
  CONFIG_FILE: path.join(os.homedir(), ".wordcheck.json"),
  DOCS_FOLDER: path.join(os.homedir(), "Documents"),
  MCP_SERVER_SUBPATH: path.join("Documents", "Tools", "office-word-mcp-server", "word_mcp_server.py"),

  // MCP
  MCP_PROTOCOL_VERSION: "2024-11-05",
  MCP_INIT_TIMEOUT: 10000,
  MCP_TOOL_TIMEOUT: 30000,
  MCP_DEFAULT_TIMEOUT: 15000,
  MCP_CLIENT_NAME: "wordcheck",

  // LLM defaults
  LLM_PROVIDER: "opencode-go",
  LLM_BASE_URL: "https://opencode.ai/zen/go/v1",
  LLM_MODEL: "mimo-v2.5-pro",
  LLM_MAX_TOKENS: 4096,
  LLM_TEMPERATURE: 0.3,
  LLM_ERROR_SLICE: 200,

  // Scanner thresholds
  MIN_PARAGRAPH_LENGTH: 50,
  MIN_SENTENCE_LENGTH: 5,
  BOLD_PARA_THRESHOLD: 200,
  MAX_SCORE_PER_PARA: 20,
  AI_PCT_MULTIPLIER: 3,
  AI_PCT_CAP: 100,

  // Severity thresholds
  HIGH_THRESHOLD: 20,
  MEDIUM_THRESHOLD: 12,
  HIGH_WEIGHT: 10,
  MEDIUM_WEIGHT: 5,

  // Paragraph length
  VERY_LONG_CHARS: 1200,
  LONG_CHARS: 800,
  CONTRACTION_MIN_LENGTH: 300,
  CONTRACTION_WORD_THRESHOLD: 30,

  // Citation
  CITATION_MIN_COUNT: 6,
  CITATION_MAX_SENTENCES: 5,

  // Uniformity
  UNIFORM_STD_THRESHOLD: 3,
  SOMEWHAT_UNIFORM_STD: 5,
  UNIFORM_SCORE: 5,
  SOMEWHAT_UNIFORM_SCORE: 2,

  // Confidence
  DEFAULT_CONFIDENCE: 50,
  MAX_CONFIDENCE: 95,
  CONFIDENCE_BASE: 40,
  CONFIDENCE_WEIGHT_MULT: 5,

  // Display
  DEFAULT_TERM_WIDTH: 80,
  MAX_TERM_WIDTH: 100,
  MAX_DIFF_WIDTH: 120,
  HEADER_ROW_COUNT: 8,
  FOOTER_ROW_COUNT: 2,
  DEFAULT_TERM_HEIGHT: 24,

  // Verdict thresholds
  VERDICT_HIGH: 50,
  VERDICT_MEDIUM: 25,

  // Display limits
  PREVIEW_LENGTH: 52,
  EVIDENCE_SLICE: 200,
  DOC_TEXT_LIMIT: 3000,
  REWRITE_SLICE: 200,
  TOOL_PARAM_DISPLAY: 50,

  // Table column widths
  ID_COL: 6,
  SEV_COL: 6,
  CAT_COL: 16,
  TITLE_COL: 30,
  TITLE_COL_FULL: 36,
  HELP_CMD_COL: 16,
  HELP_BOX_WIDTH: 60,
  SCAN_BOX_WIDTH: 76,
  WRAP_WIDTH: 64,

  // Mouse
  MOUSE_WHEEL_UP: 64,
  MOUSE_WHEEL_DOWN: 65,
  MOUSE_CLICK: 32,
  SCROLL_AMOUNT: 3,

  // Verdict strings
  VERDICTS: {
    high: "likely AI-assisted",
    medium: "mixed signals",
    low: "reads human",
  },

  // Error messages
  ERRORS: {
    MCP_NOT_CONNECTED: "MCP not connected",
    NO_DOCUMENT: "No document loaded",
    FILE_NOT_FOUND: "File not found",
    INVALID_DOCX: "Only .docx files are supported",
    NO_FINDINGS: "No findings to fix",
    NO_APPROVED: "No approved findings",
    UNKNOWN_TOOL: "Unknown tool",
  },
};

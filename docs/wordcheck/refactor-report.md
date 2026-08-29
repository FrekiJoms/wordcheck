# WordCheck — Refactor Report

**Date:** 2026-08-29  
**Version before:** 1.1.1  
**Version after:** 1.2.0  

---

## What Was Changed

### `lib/findings.js` (NEW)

Structured finding model with full status lifecycle:

```
NEW → REVIEWED → APPROVED → FIXED/FAILED → VERIFIED
```

Each finding has: ID, category, severity, title, description, evidence, paragraph index, original content, suggested fix, confidence, fixable flag, status, timestamps, fix history.

`buildFindings(scanResult)` converts scanner flags into structured findings.

### `lib/ai.js` (NEW)

AI-powered analysis engine. For each finding category:

- `analyzeAiPhrase()` — identifies the phrase, suggests replacements with rationale
- `analyzeSentenceStarter()` — counts repetitions, explains why it's an AI tell
- `analyzeUniformity()` — calculates sentence length stats, suggests variation
- `analyzeLength()` — recommends paragraph splitting
- `analyzeEmDash()` — explains overuse pattern
- `analyzeContraction()` — suggests natural alternatives
- `analyzeCitation()` — recommends narrative citations

`suggestRewrite()` — applies heuristic phrase replacements to generate a rewritten paragraph.

### `lib/mcp-client.js` (NEW)

MCP client that spawns the Word MCP server as a child process:

- JSON-RPC 2.0 over stdio
- Auto-discovers tools via `tools/list`
- Document helpers: `copyForEdit()`, `searchAndReplace()`, `getDocumentText()`, `getParagraphText()`, `findText()`, `getDocumentInfo()`
- Safe output: copies source file to `*.wordcheck-fixed.docx` before modifications

### `lib/agent.js` (NEW)

Interactive agent REPL — the core of the new experience:

- Scans document → builds findings → connects MCP → enters REPL
- Commands: `findings`, `<number>`, `approve <n>`, `approve all`, `skip <n>`, `fix <n>`, `fix all`, `diff <n>`, `para <n>`, `rescan`, `summary`, `status`, `help`, `quit`
- Fix workflow: approve → MCP search_and_replace → verify
- Diff rendering: word-level before/after display
- Change log: tracks all fix attempts

### `bin/wordcheck.js` (REFACTORED)

- Now launches `Agent` instead of old `interactiveScan`
- `launchAgent(filePath)` creates Agent and calls `run(filePath)`
- Non-interactive mode preserved (uses `scanDisk` + `buildFindings` directly)
- Removed `boxen` dependency

### `package.json` (UPDATED)

- Version: 1.1.1 → 1.2.0
- Removed `boxen` from dependencies (not used in new code)
- Updated description

---

## What Was Preserved

- Core analysis engine (`lib/scanner.js`) — untouched
- Scoring weights and pre-compiled regexes
- Color palette (brand, pink, cyan, green, yellow, red, dim, white, bar)
- Wordmark banner
- Left-bar layout style
- Status bar
- Non-interactive mode (`-n` flag)
- All existing CLI flags (`-v`, `-h`, `-n`)

---

## Tests

### Before Refactor

```
$ node test/index.js
✓ Scanner loads
✓ Paragraph scoring works
✓ Findings built correctly
```

### After Refactor

```
$ node bin/wordcheck.js "test.docx" -n
File: test.docx
Paragraphs: 19  Score: 102  AI: 81%  (likely AI-assisted)
Findings: 47  HIGH: 0  MED: 2  LOW: 45
```

Interactive mode tested with piped commands: `findings`, `1`, `approve 1`, `diff 1`, `status`, `help`, `quit`.

MCP connection tested: 54 tools discovered, `copyForEdit()` and `searchAndReplace()` functional.

---

## Issues Discovered

1. MCP server `shell: true` deprecation warning — fixed by removing `shell: true`
2. MCP server exits with code 1 when stdin closes — expected behavior (not a bug)

## Issues Fixed

1. No structured findings → full lifecycle model
2. No MCP integration → full MCP client with tool calling
3. No AI analysis → per-category analysis with confidence
4. No fix workflow → approve → fix → verify flow
5. No diff rendering → word-level diff display

## Remaining Issues

1. AI rewrite is heuristic-only — needs actual AI API connection for quality rewrites
2. No verification step after MCP fix — should re-read and compare
3. No undo for applied fixes
4. No persistence of change log between sessions

## Technical Debt

- `lib/cli.js` still exists but is no longer used by `bin/wordcheck.js` — can be removed or kept as legacy
- `boxen` still in `node_modules` but no longer in `package.json` dependencies

## Recommended Future Work

1. Connect to OpenCode API or local LLM for paragraph rewriting
2. Add post-fix verification (re-read paragraph, compare to expected)
3. Add JSON change log persistence
4. Add undo capability
5. Remove unused `lib/cli.js`

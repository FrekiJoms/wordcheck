# WordCheck — Refactor Report

**Date:** 2026-08-29  
**Version before:** 1.1.0  
**Version after:** 1.1.1  
**Executor:** Claude (via VS Code MCP)

---

## What Was Changed

### `lib/scanner.js`

| Change | Reason |
|--------|--------|
| Removed `mammoth.extractRawText()` call and the `fullText` / `rawParas` variables derived from it | The raw-text extraction was entirely unused — the HTML pass already supplies all needed text content. This eliminates a redundant I/O operation on every scan (two mammoth passes → one). |
| Pre-compiled all AI phrase regexes into `AI_PHRASE_REGEXES` at module load | Avoids reconstructing `new RegExp(...)` inside the inner `scoreParagraph` loop for every paragraph × every phrase. Compiled once, reused on every call. |
| Fixed regex reuse: reset `re.lastIndex = 0` before each match when using compiled `gi` regexes | Without this, stateful regex objects would skip matches after the first call. |
| `suggestFixes()` now reuses `para.flags` to extract sentence-starter data | Previously, `suggestFixes` called `mostCommon(starters)` independently, re-computing what `scoreParagraph` had already computed and stored in `para.flags`. Now it reads the `starter` flag directly. |
| Added module-level JSDoc comments to all exported functions | Documentation only; no behaviour change. |

### `bin/wordcheck.js`

| Change | Reason |
|--------|--------|
| Fixed extension check to use `resolved.toLowerCase().endsWith('.docx')` | Previously case-sensitive — `MyDoc.DOCX` would be rejected. |
| Extracted `validateDocx(resolved)` helper | Centralises validation so it can be used in both the argument path and the interactive file prompt. |
| Added `promptForFile()` — interactive file selection when no argument is given | Per task brief: running `wordcheck` with no args now shows the banner and prompts "Select a Word document to analyze". Loops on invalid input. Falls back cleanly — no fake drag-and-drop. |
| Added SIGINT handler during file prompt | Ctrl+C during the path prompt now prints "Cancelled." and exits cleanly instead of leaving readline open. |
| Non-interactive mode with no file argument now exits with error + usage hint | Previously: fell through to `printUsage()` and exited 0 (confusing for scripts). Now exits 1 with a clear message. |
| Updated `Usage:` string to show file as optional (`[document.docx]`) | Accurate after the interactive prompt change. |

### `lib/cli.js`

| Change | Reason |
|--------|--------|
| Added `COMMANDS` array as single source of truth | Previously the command reference string was hardcoded inline and hard to maintain. Now adding a command means adding one object. |
| Extracted `renderCommands()` function | Renders the command list consistently; called after initial render and after `rescan`. |
| `rescan` now calls `clear()` + `renderBanner()` before re-rendering | Previously appended results below existing output, creating visual clutter. Now refreshes the full screen. |
| Added `help` command to REPL | Users who forget the command list can type `help` instead of having to `rescan` or remember from startup. |
| All REPL error messages switched to `console.error()` | Previously used `console.log()` — errors belong on stderr, not stdout. |
| SIGINT (`Ctrl+C`) handler added to readline interface | Previously, Ctrl+C in the REPL could leave readline active and produce garbled output. Now exits cleanly with "Bye!". |
| Added empty-state message to `renderParagraphList` | If a filter level produces no visible paragraphs, a `chalk.dim` message is shown rather than an empty table. |
| Added empty-state message to `renderRecommendations` | If no issues are found, prints a positive confirmation. |
| Error handling in `interactiveScan` improved | Now uses `console.error`, prints a recovery hint, and calls `process.exit(1)` (previously just returned, leaving the process alive with no REPL). |

### `package.json`

| Change | Reason |
|--------|--------|
| Removed `cli-table3` from dependencies | Declared but never imported anywhere in the codebase. Dead dependency. |
| Updated `"test"` script from `"node test.js"` to `"node test/index.js"` | `test.js` never existed — this was a broken script. The new path matches the actual test file. |
| Bumped version `1.1.0` → `1.1.1` | Patch version for the refactor. |

### New files

| File | Purpose |
|------|---------|
| `docs/wordcheck/refactor-audit.md` | Full pre-refactor audit of architecture, findings, and recommendations |
| `docs/wordcheck/refactor-report.md` | This file |
| `test/index.js` | Test suite (22 tests, no external test framework required) |
| `test/run.js` | Test runner wrapper that writes results to `test/results.txt` for CI/tooling use |

---

## What Was Preserved

- All core scoring logic in `scoreParagraph()` — weights, phrase list, all detection categories
- `AI_PHRASES` dictionary — unchanged
- `REPLACEMENTS` dictionary — unchanged
- `CONTRACTIONS` list — unchanged
- `buildResult()` logic — unchanged
- Visual identity: ASCII banner, chalk colour scheme, boxen borders, blue/red/yellow/green palette
- All existing interactive commands: `<number>`, `all`, `fix`, `rescan`, `quit`/`exit`/`q`
- `--noninteractive` / `-n` flag and its behaviour
- `--version` / `-v` flag
- `--help` / `-h` flag
- `mammoth` as the DOCX parser
- npm package name and bin alias

---

## Test Results

### Before refactor

| Check | Result |
|-------|--------|
| `npm test` | ❌ FAIL — `test.js` does not exist |
| Typecheck | N/A — no TypeScript |
| Lint | N/A — no ESLint config |
| Build | N/A — no build step |
| `node bin/wordcheck.js --version` | ✅ PASS |
| `node bin/wordcheck.js --help` | ✅ PASS |
| Interactive scan (valid .docx) | ✅ PASS |
| Non-interactive scan | ✅ PASS |

### After refactor

| Check | Result |
|-------|--------|
| `npm test` / `node test/index.js` | ✅ **22/22 PASS** |
| `node bin/wordcheck.js --version` | ✅ PASS |
| `node bin/wordcheck.js --help` | ✅ PASS |
| `node bin/wordcheck.js` (no args) | ✅ Prompts for file (new behaviour) |
| `node bin/wordcheck.js` (no args, `-n`) | ✅ Exits 1 with error message |
| `node bin/wordcheck.js MyDoc.DOCX` | ✅ Accepts uppercase extension |
| Interactive scan (valid .docx) | ✅ PASS |
| Non-interactive scan | ✅ PASS |

---

## Issues Discovered

1. `mammoth.extractRawText()` was being called on every scan but its output was never used — identified and removed
2. AI phrase regexes were recompiled on every paragraph × every phrase — identified and fixed
3. `suggestFixes()` was recomputing sentence starters that `scoreParagraph()` had already computed — identified and fixed
4. `test.js` referenced in `package.json` did not exist — identified and replaced with `test/index.js`
5. `cli-table3` was listed as a dependency but never imported — identified and removed
6. Extension check was case-sensitive (`.DOCX` rejected) — identified and fixed
7. No SIGINT handling — Ctrl+C during REPL left readline dangling — identified and fixed
8. `rescan` appended output without clearing — identified and fixed
9. No interactive file selection for no-arg invocation — identified and implemented
10. Error messages in REPL used `console.log` instead of `console.error` — identified and fixed

---

## Issues Fixed

All 10 issues listed above were fixed in this refactor.

---

## Remaining Issues

### Not addressed in this refactor (out of scope per task brief)

| Issue | Rationale |
|-------|-----------|
| No AI integration (OpenCode/provider) | Not present in the baseline; adding AI integration is a new feature, not a refactor. Requires separate design work on the OpenCode API contract. |
| No MCP integration (Word MCP server) | Not present in the baseline; requires a separate MCP client implementation. |
| No finding status model (NEW/REVIEWED/FIXED/etc.) | Requires the MCP/fix workflow to exist first. |
| No fix approval workflow | Blocked on MCP integration. |
| No safe output file generation | Blocked on MCP integration. |
| No document verification | Blocked on MCP integration. |
| No configuration file support | Not required for current functionality. |
| No TypeScript | Conversion would be a significant change requiring evidence of benefit. |
| No ESLint/Prettier config | Useful but not required for correctness. |
| `renderBanner()` is exported and called from both `bin/wordcheck.js` and `cli.js` | Minor coupling — not harmful enough to refactor. |
| Recursive `prompt()` function | Would need converting to a loop; very low risk in practice. |

---

## Technical Debt

- `bin/wordcheck.js` still parses `process.argv` manually. For future flag additions, consider `yargs` or `commander`. Not worth adding a dependency now.
- No `.editorconfig` or code-style tooling. Low risk for a single-author project but worth adding before open contributions.
- JSDoc is present on scanner exports but not on all cli.js functions.

---

## Recommended Future Work

In priority order:

1. **AI integration** — Determine the actual OpenCode Go/Zen API contract. Implement AI-assisted paragraph analysis that sends document content (not as instructions) and receives scoring suggestions. Enforce strict prompt-injection boundaries.

2. **MCP integration** — Implement a proper MCP client. Inspect the Word MCP server's actual tool schemas. Do not invent tool names.

3. **Finding status model** — Once the fix workflow is possible, add `status` field to paragraphs: `NEW → REVIEWED → APPROVED → FIXED / FAILED → VERIFIED`.

4. **Safe output file** — Implement `source.wordcheck-fixed.docx` naming. Never overwrite the source document without explicit user confirmation.

5. **Verification loop** — After applying a fix via MCP, re-read the document and confirm the change was applied. Only mark `VERIFIED` on actual evidence.

6. **ESLint config** — Add a minimal `.eslintrc.json` to catch future regressions.

7. **Test fixtures** — Add a minimal synthetic `.docx` file in `test/fixtures/` for end-to-end DOCX scanning tests.

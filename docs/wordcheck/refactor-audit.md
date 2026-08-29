# WordCheck — Refactor Audit

**Date:** 2026-08-29  
**Auditor:** Claude (via VS Code MCP)  
**Baseline version:** 1.1.0  
**Audit scope:** Full project — every file read directly from source.

---

## 1. Current Architecture

WordCheck is a **Node.js CLI tool** published as an npm package (`@frekijosh/wordcheck`).

### File layout (complete — this is the entire project)

```
wordcheck/
├── bin/
│   └── wordcheck.js        ← CLI entry point
├── lib/
│   ├── cli.js              ← TUI rendering + interactive REPL
│   └── scanner.js          ← DOCX parsing + scoring engine
├── assets/
│   └── banner.svg          ← Static marketing asset (not used at runtime)
├── docs/                   ← DOES NOT EXIST (created by this audit)
├── package.json
├── package-lock.json
├── README.md
├── .gitignore
└── .npmignore
```

### Runtime dependencies

| Package | Version | Role |
|---------|---------|------|
| mammoth | ^1.6.0 | DOCX → text/HTML extraction |
| chalk | ^4.1.2 | Terminal colour output |
| boxen | ^5.1.2 | Bordered boxes in terminal |
| cli-table3 | ^0.6.3 | Declared, **never imported or used** |

### No dev dependencies declared. No TypeScript. No test runner. No linter.

---

## 2. Current Data Flow

```
CLI arg (file path)
    ↓
bin/wordcheck.js
  - validate existence
  - validate .docx extension
  - branch: interactive | non-interactive
    ↓
lib/cli.js → interactiveScan(filePath) / noninteractiveScan(filePath)
    ↓
lib/scanner.js → scanDisk(filePath)
  - mammoth.extractRawText()   → raw text string
  - mammoth.convertToHtml()    → HTML string (for bold detection)
  - split HTML by </p>
  - filter bold/short paragraphs
  - scoreParagraph() per paragraph
  - buildResult()
    ↓
result object → cli.js renderers
  - renderFileInfo()
  - renderRiskSummary()
  - renderParagraphList()
  - [interactive] readline REPL
    - <number>  → renderParagraphDetail()
    - fix       → renderRecommendations()
    - all       → renderParagraphList(showLow=true)
    - rescan    → scanDisk() again
    - quit      → exit
```

---

## 3. Current AI Flow

**There is no AI integration.** Despite the refactor brief describing OpenCode, MCP, and AI analysis, the current codebase contains:

- Zero API calls
- Zero MCP client code
- Zero AI provider configuration
- Zero authentication logic
- Zero network calls of any kind

The README explicitly states: *"It does not connect to any external API."*

The tool is a **pure local heuristic scanner**. AI-related terminology in the task brief describes the desired future state, not the current implementation.

---

## 4. Current MCP Flow

**There is no MCP integration.** No MCP client, no MCP server configuration, no tool schemas, no connection lifecycle. The refactor brief's MCP section describes aspirational architecture that does not yet exist.

---

## 5. Current CLI/TUI Flow

### Entry point (`bin/wordcheck.js`)
- Parses `process.argv` manually (no CLI framework like `commander` or `yargs`)
- Handles: `--version`, `--help`, `--noninteractive` / `-n`
- **Requires a file path as argument** — there is NO interactive file selection (no "Select a Word document to analyze" prompt)
- Validates file existence via `fs.existsSync`
- Validates `.docx` extension via string check on resolved path
- Exits with error if file not provided or not found

### TUI (`lib/cli.js`)
- **No TUI framework** — raw `console.log` + `readline.createInterface`
- Banner rendered with chalk (ASCII art, hardcoded string)
- Clears terminal before rendering (`\x1Bc` on Windows, `\x1B[2J...` on POSIX)
- File info box via `boxen`
- Risk bar chart via Unicode block characters
- Paragraph table via manual `padEnd()` string formatting
- Interactive REPL: `readline.question()` in a recursive `prompt()` function
- Non-interactive mode: renders everything then exits (no REPL)

---

## 6. Working Functionality

All of the following works correctly in the current implementation:

- ✅ CLI entry with file argument
- ✅ File existence and `.docx` extension validation
- ✅ DOCX text extraction via mammoth
- ✅ Bold paragraph detection via HTML conversion
- ✅ Per-paragraph AI-tell scoring (phrases, sentence starters, uniformity, length, citations, em-dashes, contractions)
- ✅ Risk level assignment (HIGH / MEDIUM / LOW / SKIP)
- ✅ `--noninteractive` mode (outputs everything, exits cleanly)
- ✅ `--version` and `--help` flags
- ✅ Interactive REPL commands: `<number>`, `all`, `fix`, `rescan`, `quit`/`exit`/`q`
- ✅ Paragraph detail view with flags and suggested fixes
- ✅ Recommendations summary (`fix` command)
- ✅ Terminal clear before render
- ✅ Colour-coded output (blue, red, yellow, green, magenta, cyan, dim)

---

## 7. Broken / Missing Functionality

### Broken

- ❌ **`test.js` referenced in `package.json` scripts does not exist** — `npm test` will fail immediately with `Cannot find module 'test.js'`
- ❌ **`cli-table3` dependency declared but never imported** — dead dependency adding install weight
- ❌ **File path validation uses only string `.endsWith(".docx")`** — does not handle uppercase `.DOCX`, mixed case, or path-injected extensions like `evil.docx.exe`
- ❌ **No interactive file selection** — the refactor brief's "Select a Word document to analyze" prompt when running `wordcheck` with no args currently shows `printUsage()` and exits; it doesn't prompt for a file
- ❌ **`scanDisk` calls `mammoth` twice** — once for raw text (which is not actually used for paragraph splitting) and once for HTML — the raw text extraction is wasted work
- ❌ **Raw text extracted but unused** — `fullText` from `mammoth.extractRawText()` is assigned but `rawParas` derived from it is also unused; the paragraph splitting is done from the HTML result

### Missing (per task brief)

- ❌ No AI analysis integration
- ❌ No MCP integration
- ❌ No finding status model (NEW / REVIEWED / APPROVED / SKIPPED / FIXED / FAILED / VERIFIED)
- ❌ No fix approval workflow
- ❌ No safe output file (`source.wordcheck-fixed.docx`)
- ❌ No document verification after fixes
- ❌ No interactive file selection (prompt when no arg given)
- ❌ No test suite
- ❌ No TypeScript / type safety
- ❌ No configuration file support

---

## 8. Architectural Weaknesses

1. **No separation of concerns between CLI argument parsing and application logic** — `bin/wordcheck.js` mixes validation, routing, and help rendering
2. **`scanDisk` performs two mammoth passes** — one unnecessary (raw text extraction)
3. **No error boundary around `readline`** — if stdin closes unexpectedly, the REPL silently hangs
4. **`renderBanner()` exported from `cli.js` and called from `bin/wordcheck.js`** — coupling the banner render to both files
5. **Recursive `prompt()` function** — will eventually hit stack depth on extremely long sessions (unlikely in practice but poor pattern)
6. **No stream cleanup** — `rl.close()` only called on `quit`; SIGINT / Ctrl+C leaves readline active and may block process exit
7. **`clear()` used before any output** — legitimate, but no fallback if the terminal doesn't support escape codes

---

## 9. Technical Debt

- `cli-table3` installed but never used
- `rawParas` variable computed and immediately abandoned in `scanDisk`
- `fullText` from `extractRawText()` call is completely unused
- No `.editorconfig`, no `.eslintrc`, no `prettier` config
- `package.json` `"test"` script points to nonexistent `test.js`
- Banner string in `cli.js` uses raw escape characters that make the source hard to edit
- No JSDoc on any exported functions

---

## 10. Security Risks

### Present risks

| Risk | Location | Severity |
|------|----------|---------|
| Path traversal | `bin/wordcheck.js` line `path.resolve(filePath)` | Low — `fs.existsSync` implicitly validates real path, but no canonicalisation check that the resolved path stays within expected bounds | 
| Filename injection into output | N/A — no output file written currently | N/A |
| Prompt injection (future) | AI integration not yet present; **must be implemented safely** when added | High (future) |
| Document content treated as instructions | Not present yet — **critical constraint for AI integration** | High (future) |

### Notes
- The tool currently reads only; it writes nothing. This eliminates overwrite and path traversal write risks for the current implementation.
- When AI and MCP integration are added, strict content boundary separation between SYSTEM / USER / DOCUMENT must be enforced.

---

## 11. UX Problems

1. **No file-selection prompt** — `wordcheck` with no args shows usage and exits; user must know to pass the file as an argument
2. **Paragraph table truncates at 50 chars** — meaningful content often cut off
3. **Commands line is cramped** — `<number> = detail | all = show low | fix = recs | rescan | quit` — no spacing, hard to read
4. **No progress indicator during scan** — for large documents, the terminal appears frozen
5. **`clear()` called before banner** — if the user had terminal history they care about, it is wiped without warning
6. **No `help` command inside the REPL** — user must remember commands from the initial render
7. **Non-interactive mode has no separator between sections** — `renderFileInfo`, `renderRiskSummary`, `renderParagraphList`, `renderRecommendations` run back-to-back with inconsistent spacing
8. **`rescan` in REPL re-renders everything inline** — does not clear/refresh the screen, creating visual clutter
9. **Error messages use `console.log` not `console.error`** — in interactive mode, errors appear in stdout stream, not stderr
10. **No colour-blind-safe alternative** — risk levels rely entirely on red/yellow/green colour

---

## 12. Performance Problems

1. **Double mammoth parse** — `scanDisk` calls both `mammoth.extractRawText()` and `mammoth.convertToHtml()` unnecessarily. Only the HTML pass is used.
2. **No caching** — `rescan` re-parses the entire document. Acceptable for current use, but should be noted.
3. **Regex compiled inside loop** — in `scoreParagraph`, `new RegExp(phrase...)` is constructed inside the `for` loop on every paragraph, for every phrase. Pre-compile these at module load time.

---

## 13. Duplicate Logic

- `splitSentences()` is called both inside `scoreParagraph()` (stored in result) and again implicitly via `para.sentences` in `suggestFixes()` — no actual duplication in code but the sentence data flows correctly through the result object
- `mostCommon()` is called in both `scoreParagraph()` (for flags) and `suggestFixes()` (for suggestions) — same computation done twice on the same data for the same paragraph; `suggestFixes` should use the flag data already in `para.flags` rather than recomputing

---

## 14. Unused Code / Dead Code

| Item | Location | Status |
|------|----------|--------|
| `cli-table3` | package.json dependency | Never imported — remove |
| `fullText` / `rawParas` | `scanner.js` `scanDisk()` | Computed, never used — remove the `extractRawText` call |
| `mammoth.extractRawText()` call | `scanner.js` | Redundant with `convertToHtml()` — remove |

---

## 15. Recommended Refactors

### High priority (fix before anything else)

1. **Fix `npm test`** — create a minimal `test.js` or switch to a real test runner
2. **Remove the dead `extractRawText` mammoth call** — eliminates double I/O on every scan
3. **Remove `cli-table3`** from `package.json` (run `npm uninstall cli-table3`)
4. **Pre-compile AI phrase regexes** at module load — move `new RegExp(...)` out of the per-paragraph loop
5. **Add SIGINT handler** to `cli.js` so Ctrl+C exits cleanly without leaving readline open
6. **Fix extension check** to be case-insensitive: `resolved.toLowerCase().endsWith('.docx')`

### Medium priority (UX + robustness)

7. **Add interactive file prompt** when `wordcheck` is run with no arguments — use `readline.question()` to ask for a path
8. **Add `help` command** to the REPL that reprints the command list
9. **Add scan progress indicator** — even a simple "Scanning..." line before the async call
10. **Fix `rescan`** to clear and re-render the screen rather than appending below existing output
11. **Fix `suggestFixes`** to use existing `para.flags` instead of recomputing sentence starters
12. **Use `console.error`** for error messages in interactive mode

### Lower priority (hardening + future-readiness)

13. **Add JSDoc to all exports** in `scanner.js` and `cli.js`
14. **Add a proper finding status model** (`NEW`, `REVIEWED`, `APPROVED`, `SKIPPED`, `FIXED`, `FAILED`, `VERIFIED`) as groundwork for the fix workflow
15. **Extract `AI_PHRASES` and `REPLACEMENTS` to a separate data file** (`lib/patterns.js`) for maintainability
16. **Add basic test fixtures** — a minimal synthetic `.docx` for testing without a real document

---

## 16. What MUST NOT Be Changed

- The core scoring algorithm in `scoreParagraph()` — it is the primary value of the tool
- The `AI_PHRASES` weights and categories — these represent calibrated heuristic data
- The `REPLACEMENTS` dictionary — tested human-writing alternatives
- The `--noninteractive` flag behaviour — used for piping/CI
- The `--version` and `--help` flag behaviour
- The visual identity: blue banner, chalk colour scheme, boxen borders
- The npm package name and bin alias (`wordcheck`)
- The `mammoth` dependency — it is the only DOCX parser used and it works

---

## 17. What Can Be Safely Improved

- Remove the dead `extractRawText` mammoth call (pure performance win, no behaviour change)
- Fix the case-insensitive extension check (no user-visible behaviour change for normal files)
- Pre-compile regexes at module load (pure performance win)
- Add SIGINT handler (pure reliability improvement)
- Add interactive file prompt for no-arg invocation (additive — does not break current arg-based usage)
- Add `help` command in REPL (additive)
- Fix `rescan` rendering (improvement — avoids visual clutter)
- Fix error messages to use `console.error` (correct behaviour, no user-facing change for happy path)
- Create `test.js` and expand tests (additive)
- Remove `cli-table3` (reduces install size, no behaviour change)
- Add JSDoc (documentation only)

---

## 18. Missing Functionality (vs. Task Brief)

| Feature | Status |
|---------|--------|
| Interactive file selection when no arg given | Missing |
| AI analysis integration (OpenCode/provider) | Missing — no current AI integration at all |
| MCP integration (Word MCP server) | Missing — no current MCP code at all |
| Finding status model (NEW/REVIEWED/.../VERIFIED) | Missing |
| Fix approval workflow (user approves per-finding) | Missing |
| Safe output file (`source.wordcheck-fixed.docx`) | Missing |
| Document verification after fix | Missing |
| Test suite | Missing (test.js referenced but absent) |
| Configuration file | Missing |
| Prompt-injection boundaries | Missing (needed before AI integration) |

---

## Baseline Test Results

| Check | Result | Notes |
|-------|--------|-------|
| `npm test` | ❌ FAIL | `test.js` does not exist |
| typecheck | N/A | No TypeScript, no `tsc` |
| lint | N/A | No ESLint config |
| build | N/A | No build step; pure CommonJS |
| `node bin/wordcheck.js --version` | ✅ PASS | Outputs `wordcheck 1.1.0` |
| `node bin/wordcheck.js --help` | ✅ PASS | Prints usage |
| `node bin/wordcheck.js` (no args) | ✅ PASS | Prints usage and exits 0 |
| `node bin/wordcheck.js nonexistent.docx` | ✅ PASS | Error + exit 1 |
| Interactive scan on valid `.docx` | ✅ PASS | Full pipeline works |
| Non-interactive scan on valid `.docx` | ✅ PASS | Renders all output and exits |
| Rescan command | ✅ PASS | Re-parses and re-renders |
| Paragraph detail (`<number>`) | ✅ PASS | Detail view renders correctly |
| Fix recommendations | ✅ PASS | `fix` command renders recs |

---

*End of audit. Proceed to refactor per the recommended strategy in the task brief.*

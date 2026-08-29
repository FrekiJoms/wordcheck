# WordCheck — Refactor Audit

**Date:** 2026-08-29  
**Version:** 1.1.1 → 1.2.0  

---

## 1. Current Architecture (Before)

```
bin/wordcheck.js  →  lib/cli.js  →  lib/scanner.js
                       (TUI)          (analysis)
```

- Static REPL with hardcoded commands
- No structured findings model
- No MCP integration
- No AI integration (static replacement dictionary only)
- No fix workflow
- No diff rendering

## 2. Current Data Flow (Before)

```
DOCX → mammoth → HTML → paragraph extraction → scoreParagraph() → display
```

One-way scan. No persistence. No fix capability.

## 3. What Was Broken

- No way to apply fixes to documents
- No structured finding lifecycle
- No MCP connection to Word
- No AI-powered analysis
- Static `suggestFixes()` only gave text suggestions, no action

## 4. What Was Preserved

- `lib/scanner.js` — core analysis engine (pre-compiled regexes, scoring weights)
- Color palette (C.brand, C.pink, C.cyan, etc.)
- Wordmark banner
- Left-bar layout style (`C.bar("  │ ")`)
- Status bar with version
- Non-interactive mode (`-n` flag)

## 5. What Was Added

### New Files

| File | Purpose |
|------|---------|
| `lib/findings.js` | Structured finding model with status lifecycle (NEW → REVIEWED → APPROVED → FIXED/FAILED → VERIFIED) |
| `lib/ai.js` | AI-powered analysis engine — per-category analysis with confidence scores |
| `lib/mcp-client.js` | MCP client — spawns Word MCP server via stdio, JSON-RPC 2.0, tool calling |
| `lib/agent.js` | Agent REPL — interactive controller with fix workflow, diff rendering, MCP integration |

### Refactored Files

| File | Changes |
|------|---------|
| `bin/wordcheck.js` | Now launches Agent instead of old `interactiveScan`. Added `launchAgent()`. |
| `package.json` | Version bump 1.1.1 → 1.2.0. Removed `boxen` dep (unused). Updated description. |

## 6. Architectural Weaknesses Found

1. **No structured findings** — old code used raw flag objects with no lifecycle
2. **No MCP client** — Word MCP server was configured but never used by WordCheck
3. **Static suggestions** — `suggestFixes()` was a pure function with no action capability
4. **No verification** — no way to confirm a fix was actually applied

## 7. Security Risks

- MCP server spawned with `shell: true` (fixed)
- No path validation on MCP file arguments (existing; not worse)
- Document content treated as trusted (existing)

## 8. Performance

- Pre-compiled regexes preserved (no regression)
- Single mammoth HTML pass preserved
- MCP connection adds ~2s startup (acceptable for interactive use)

## 9. What MUST NOT Be Changed

- Scoring weights in `AI_PHRASES` (calibrated heuristics)
- Pre-compiled regex pattern
- Color palette
- Non-interactive mode output format

## 10. Recommended Future Work

- Connect to an actual AI API for paragraph rewriting (currently uses heuristics)
- Add verification step after MCP fixes (re-read document, compare)
- Add change history persistence (JSON log)
- Add undo capability for fixes

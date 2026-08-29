<p align="center">
  <img src="./assets/banner.svg" alt="WordCheck - AI Agent for Word Documents" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@frekijosh/wordcheck"><img src="https://img.shields.io/npm/v/@frekijosh/wordcheck.svg?style=flat-square&color=CB3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@frekijosh/wordcheck"><img src="https://img.shields.io/npm/dm/@frekijosh/wordcheck.svg?style=flat-square&color=5FA04E" alt="monthly downloads"></a>
  <a href="https://github.com/frekijosh/wordcheck/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@frekijosh/wordcheck.svg?style=flat-square&color=FF6B35" alt="license"></a>
  <a href="https://github.com/frekijosh/wordcheck"><img src="https://img.shields.io/github/stars/frekijosh/wordcheck.svg?style=flat-square&color=F0DB4F" alt="GitHub stars"></a>
  <a href="https://github.com/frekijosh/wordcheck/issues"><img src="https://img.shields.io/github/issues/frekijosh/wordcheck.svg?style=flat-square&color=4C8BF5" alt="GitHub issues"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D14-5FA04E.svg?style=flat-square" alt="Node.js 14+">
</p>

<p align="center">
  <img src="https://cdn.simpleicons.org/node.js/5FA04E" width="28" height="28" alt="Node.js">
  <img src="https://cdn.simpleicons.org/npm/CB3837" width="28" height="28" alt="npm">
</p>

# wordcheck

Agentic AI for Word documents — scan, analyze, edit, and improve `.docx` files with conversational AI and live Word MCP integration.

WordCheck is a full terminal-based AI agent that scans documents for AI-generated writing patterns, then lets you fix them through natural conversation. It connects to your preferred LLM (OpenCode, OpenAI, Anthropic, Google, Ollama, and more) and uses MCP (Model Context Protocol) to read and edit Word documents directly.

> [!NOTE]
> The scanner is a **pattern-based heuristic** — it identifies writing patterns commonly associated with LLM-generated text (phrase repetition, sentence uniformity, missing contractions). It is not an AI classifier. The AI chat features require an external LLM provider.

## Install

```bash
npm install -g @frekijosh/wordcheck
```

**Requires:** Node.js 14+ and npm. No Python needed.

## Quick start

```bash
# Open the TUI and scan a document
wordcheck my_paper.docx

# Non-interactive scan (no TUI, prints results)
wordcheck my_paper.docx -n
```

## What it does

### Scan and score

Analyzes every paragraph in a `.docx` file and assigns a risk score based on 25+ weighted heuristics:

| Category | What it detects | Weight |
|----------|-----------------|--------|
| **AI phrases** | "moreover", "furthermore", "present study", "comprehensive", etc. | 1–3 per phrase |
| **Sentence starters** | Repeated opening words across sentences | 2 per repeat |
| **Uniformity** | Low standard deviation in sentence length | 2–5 |
| **Length** | Unusually long paragraphs (>650 chars) | 1–3 |
| **Citations** | High citation density in short paragraphs | 4 |
| **Em-dashes** | Use of `—` character | 2 per dash |
| **Contractions** | Long paragraphs with no contractions | 3 |

Risk levels: **HIGH** ≥ 15, **MEDIUM** ≥ 8, **LOW** < 8

### Fix with AI chat

Type anything not starting with `/` and it goes to your connected LLM. The AI can call 24 document tools autonomously:

- **Search and replace** text in the document
- **Add paragraphs, headings, tables** with formatting
- **Delete paragraphs**, format text (bold, italic, color)
- **Chain operations** with `word_modify` (multiple edits in one call with progress tracking)
- **Create new documents**, copy, convert to PDF
- **Apply style guide** formatting (WriteTechHub standards)

The agent loops tool calls automatically — it keeps executing until the AI produces a final response, so complex multi-step edits complete without disconnecting.

### Rich terminal UI

Full alternate-screen TUI built from scratch:

- **Scrollable content** with keyboard (`j`/`k`, `g`/`G`, Page Up/Down) and mouse wheel
- **Command palette** — type `/` to see all commands, Tab to select
- **Interactive modals** — Provider picker, Model picker, Settings (all searchable, clickable, keyboard-navigable)
- **Tool progress overlay** — shows which MCP tool is running with status icons
- **Side-by-side diff** — preview changes before applying fixes
- **Markdown rendering** — AI responses render with headers, tables, code blocks, and styled prefixes

## Commands

| Command | Description |
|---------|-------------|
| `/findings` | Show all findings in a table |
| `/new` | Show only unreviewed findings |
| `/approve all` | Approve all fixable findings |
| `/approve <n>` | Approve finding #n |
| `/skip <n>` | Skip finding #n |
| `/fix all` | Apply all approved fixes |
| `/fix <n>` | Apply fix for finding #n |
| `/diff <n>` | Side-by-side diff preview |
| `/para <n>` | Inspect paragraph #n |
| `/rescan` | Re-analyze the document |
| `/settings` | Open provider/model/API configuration |
| `/model` | Open model picker |
| `/open` | Open document in Microsoft Word |
| `/status` | Show connection status |
| `/clear` | Clear screen |
| `/help` | Show all commands |
| `/quit` | Exit |
| *(any text)* | Send to AI chat |

## AI providers

WordCheck supports 10 providers out of the box:

| Provider | Default Model | Notes |
|----------|---------------|-------|
| **OpenCode Zen** | `mimo-v2.5-free` | Free tier, recommended |
| **OpenCode Go** | `mimo-v2.5` | $10/mo, more models |
| **OpenAI** | `gpt-4o-mini` | Requires API key |
| **GitHub Copilot** | `gpt-4o` | Uses Copilot auth |
| **Anthropic** | `claude-sonnet-4-6` | Requires API key |
| **Google** | `gemini-2.0-flash` | Requires API key |
| **302.AI** | `gpt-4o` | Requires API key |
| **Abacus** | `gpt-4o` | Requires API key |
| **Ollama** | `llama3.1` | Local, no API key needed |
| **Custom** | — | Enter your own base URL |

Switch providers or models anytime with `/settings` or `/model`. API keys are stored in `~/.wordcheck.json`.

## Configuration

On first launch, WordCheck creates `~/.wordcheck.json`:

```json
{
  "api": {
    "provider": "opencode-go",
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "model": "mimo-v2.5-pro",
    "apiKey": "",
    "maxTokens": 4096,
    "temperature": 0.3
  }
}
```

Change settings interactively with `/settings`, or edit the file directly.

## Usage

```
wordcheck <file.docx> [options]

Options:
  -n, --noninteractive   Non-interactive mode (print results, no TUI)
  -v, --version          Show version
  -h, --help             Show help
```

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](https://github.com/frekijosh/wordcheck/blob/main/LICENSE)

<p align="center">
  <img src="./assets/banner.svg" alt="WordCheck - AI-Tell Scanner for Word Documents" width="100%">
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

AI-Tell Scanner for Word Documents. Detect AI-generated content patterns in `.docx` files and get actionable fix suggestions.

Use it when you need to check whether a Word document reads like human-written text or contains patterns typical of AI-generated content:

* Per-paragraph risk scoring (HIGH / MEDIUM / LOW)
* AI phrase detection with weighted scoring
* Sentence structure and uniformity analysis
* Contraction and em-dash pattern checks
* Interactive detail view with fix suggestions

> [!NOTE]
> This is a **pattern-based heuristic scanner**, not an AI detector. It identifies writing patterns commonly associated with LLM-generated text. It does **not** connect to any external API.

## Install

```bash
npm install -g @frekijosh/wordcheck
```

**Requires:** Node.js 14+ and npm. No Python needed.

## Quick start

```bash
# Interactive mode
wordcheck my_paper.docx

# Non-interactive (for piping/CI)
wordcheck my_paper.docx -n
```

## Usage

```
wordcheck <file.docx> [options]

Options:
  -n, --noninteractive   Non-interactive mode (shows all paragraphs + recommendations)
  -v, --version          Show version
  -h, --help             Show help
```

### Interactive commands

| Command | Description |
|---------|-------------|
| `<number>` | View detailed analysis for a specific paragraph |
| `all` | Show all paragraphs including LOW risk |
| `fix` | Show recommendations for the whole document |
| `rescan` | Re-analyze the file (use after making edits) |
| `quit` | Exit |

### Example session

```
$ wordcheck my_paper.docx

    __        __   _    _____                  _             _
   \ \      / /__| |__|_   _|__ _ __ _ __ ___| |_ ___  __ _| |
    \ \ /\ / / _ \ '_ \| | |/ _ \ '__| '_ ` _ \ __/ _ \/ _` | |
     \ V  V /  __/ |_) | | |  __/ |  | | | | | ||  __/ (_| | |
      \_/\_/ \___|_.__/|_|_|\___|_|  |_| |_| |_|\\___|\\__,_|_|

  AI-Tell Scanner for Word Documents

 ╭ File Overview ───────────────────────────────────────────╮
 │   File:            my_paper.docx                         │
 │   Body Paragraphs: 24                                    │
 │   Total Score:     87                                    │
 │   AI Likelihood:   45%                                   │
 ╰──────────────────────────────────────────────────────────╯

  Risk Breakdown
  ----------------------------------------
  HIGH      2  ██
  MEDIUM    6  ███████
  LOW      16  ████████████████████████

  Paragraph Analysis
  ----------------------------------------------------------------------
  #     Risk       Score   Preview
  ----------------------------------------------------------------------
  1     MEDIUM     12      In recent years, the rapid growth of e-commerce...
  3     HIGH       18      Moreover, the present study aims to examine...

  Commands: <number> = detail | all = show low | fix = recs | rescan | quit

wordcheck> 3

  Paragraph 3 - HIGH (score: 18)
  ------------------------------------------------------------
  ┌──────────────────────────────────────────────────────────┐
  │ Moreover, the present study aims to examine the...       │
  └──────────────────────────────────────────────────────────┘

  Words:        145
  Sentences:    6
  Citations:    2
  Contractions: No
  Em-dashes:    0

  AI Tells Found:
    > "moreover" x1 (+3)
    > "the present study" x1 (+3)
    > "aims to" x1 (+2)
    > no contractions (+3)
    > uniform sentences (std=3.2) (+5)

  Suggested Fixes:
    1. Replace "the present study" with: this research, the current work
    2. Replace "moreover" with: also, besides, on top of that
    3. Add contractions (don't, it's, can't, etc.)
```

## What it checks

| Category | What it looks for | Weight |
|----------|-------------------|--------|
| **AI phrases** | "moreover", "furthermore", "present study", "comprehensive", etc. | 1–3 per phrase |
| **Sentence starters** | Repeated opening words across sentences | 2 per repeat |
| **Uniformity** | Low standard deviation in sentence length | 2–5 |
| **Length** | Unusually long paragraphs (>650 chars) | 1–3 |
| **Citations** | High citation density in short paragraphs | 4 |
| **Em-dashes** | Use of `—` character | 2 per dash |
| **Contractions** | Long paragraphs with no contractions | 3 |

Risk levels: **HIGH** ≥ 15, **MEDIUM** ≥ 8, **LOW** < 8

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](https://github.com/frekijosh/wordcheck/blob/main/LICENSE)

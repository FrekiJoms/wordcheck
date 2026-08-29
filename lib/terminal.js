"use strict";

const readline = require("readline");
const chalk = require("chalk");

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------
const ESC = "\x1B";
const CSI = `${ESC}[`;

const ansi = {
  // Screen
  altScreenOn:    `${ESC}[?1049h`,
  altScreenOff:   `${ESC}[?1049l`,
  clearScreen:    `${CSI}2J${CSI}H`,

  // Cursor
  cursorHide:     `${CSI}?25l`,
  cursorShow:     `${CSI}?25h`,
  cursorTo:       (row, col) => `${CSI}${row};${col}H`,
  cursorSave:     `${ESC}7`,
  cursorRestore:  `${ESC}8`,

  // Scroll
  scrollUp:       (n = 1) => `${CSI}${n}S`,
  scrollDown:     (n = 1) => `${CSI}${n}T`,

  // Lines
  eraseLine:      `${CSI}2K`,
  eraseBelow:     `${CSI}0J`,
  eraseAbove:     `${CSI}1J`,

  // Scroll region
  scrollRegion:   (top, bottom) => `${CSI}${top};${bottom}r`,
  resetRegion:    `${CSI}r`,
};

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------
const C = {
  brand:  chalk.hex("#5B8DEF"),
  pink:   chalk.hex("#FF79C6"),
  cyan:   chalk.hex("#8BE9FD"),
  green:  chalk.hex("#50FA7B"),
  yellow: chalk.hex("#F1FA8C"),
  red:    chalk.hex("#FF5555"),
  dim:    chalk.hex("#6272A4"),
  white:  chalk.hex("#F8F8F2"),
  bar:    chalk.hex("#FF79C6"),
};

// ---------------------------------------------------------------------------
// Wordmark
// ---------------------------------------------------------------------------
const WORDMARK = [
  "  ██╗    ██╗ ██████╗ ██████╗ ██████╗  ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗",
  "  ██║    ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝",
  "  ██║ █╗ ██║██║   ██║██████╔╝██║  ██║██║     ███████║█████╗  ██║     █████╔╝ ",
  "  ██║███╗██║██║   ██║██╔══██╗██║  ██║██║     ██╔══██║██╔══╝  ██║     ██╔═██╗ ",
  "  ╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝╚██████╗██║  ██║███████╗╚██████╗██║  ██╗",
  "   ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝",
];

const VERSION = require("../package.json").version;

// ---------------------------------------------------------------------------
// Terminal TUI — alternate screen, scrollable content, fixed input
// ---------------------------------------------------------------------------
class Terminal {
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    // Layout regions
    this.headerLines = 8;    // banner + file info + status
    this.footerLines = 2;    // separator + input line
    this.contentStartRow = this.headerLines + 1;
    this.contentEndRow = this.height - this.footerLines;
    this.contentHeight = this.contentEndRow - this.contentStartRow + 1;
    this.inputRow = this.height;

    // Content state
    this.contentLines = [];   // all rendered lines (raw strings)
    this.scrollOffset = 0;    // how far scrolled from top
    this.maxScroll = 0;

    // Input state
    this.inputBuffer = "";
    this.inputCursorPos = 0;
    this.inputPrefix = "  │ wordcheck › ";
    this.inputActive = false;

    // Mode
    this.scrollMode = false;  // true when user is scrolling content

    // Resize handler
    this._onResize = () => this._handleResize();
    process.stdout.on("resize", this._onResize);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Enter alternate screen and set up the layout */
  open() {
    process.stdout.write(ansi.altScreenOn);
    process.stdout.write(ansi.cursorHide);
    process.stdout.write(ansi.clearScreen);
    this._drawStatic();
    this._drawContent();
    this._drawInput();
    this._enableRawMode();
  }

  /** Leave alternate screen and restore terminal */
  close() {
    this._disableRawMode();
    process.stdout.write(ansi.resetRegion);
    process.stdout.write(ansi.cursorShow);
    process.stdout.write(ansi.altScreenOff);
    process.stdout.removeListener("resize", this._onResize);
  }

  // -----------------------------------------------------------------------
  // Content management
  // -----------------------------------------------------------------------

  /** Add a line to the content area */
  addLine(line = "") {
    this.contentLines.push(line);
    // Auto-scroll to bottom if user was at bottom
    const maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (this.scrollOffset >= maxScroll - 1 || !this.scrollMode) {
      this.scrollOffset = maxScroll;
    }
    this.maxScroll = maxScroll;
    if (!this.scrollMode) {
      this._drawContent();
    }
  }

  /** Add multiple lines */
  addLines(lines) {
    for (const line of lines) this.addLine(line);
  }

  /** Clear all content */
  clearContent() {
    this.contentLines = [];
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this._drawContent();
  }

  /** Set header info (drawn above content) */
  setHeader(lines) {
    this._headerLines = lines;
    this._drawStatic();
  }

  /** Set status bar text */
  setStatus(text) {
    this._statusText = text;
    this._drawStatic();
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  /** Show input prompt and wait for user input */
  async prompt() {
    return new Promise((resolve) => {
      this.inputActive = true;
      this.inputBuffer = "";
      this.inputCursorPos = 0;
      this.scrollMode = false;
      this._drawInput();

      this._promptResolve = resolve;
    });
  }

  /** Cancel current prompt */
  cancelPrompt() {
    if (this._promptResolve) {
      this._promptResolve(null);
      this._promptResolve = null;
    }
    this.inputActive = false;
  }

  // -----------------------------------------------------------------------
  // Scroll mode
  // -----------------------------------------------------------------------

  enterScrollMode() {
    this.scrollMode = true;
    this._drawContent();
    this._drawScrollIndicator();
  }

  exitScrollMode() {
    this.scrollMode = false;
    this._drawContent();
    this._drawInput();
  }

  scrollUp(lines = 5) {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    this._drawContent();
    this._drawScrollIndicator();
  }

  scrollDown(lines = 5) {
    this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + lines);
    this._drawContent();
    this._drawScrollIndicator();
  }

  scrollToTop() {
    this.scrollOffset = 0;
    this._drawContent();
    this._drawScrollIndicator();
  }

  scrollToBottom() {
    this.scrollOffset = this.maxScroll;
    this._drawContent();
    this._drawScrollIndicator();
  }

  pageUp() {
    this.scrollUp(this.contentHeight - 2);
  }

  pageDown() {
    this.scrollDown(this.contentHeight - 2);
  }

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------

  _drawStatic() {
    // Header area (rows 1..headerLines)
    const lines = this._headerLines || [];
    for (let i = 0; i < this.headerLines; i++) {
      process.stdout.write(ansi.cursorTo(i + 1, 1) + ansi.eraseLine);
      if (lines[i]) {
        process.stdout.write(lines[i]);
      }
    }

    // Status bar (row height - footerLines + 1)
    const statusRow = this.height - this.footerLines + 1;
    process.stdout.write(ansi.cursorTo(statusRow, 1) + ansi.eraseLine);
    const status = this._statusText || "ready";
    const statusLeft = `  ● ${C.pink("wordcheck")}  ${C.dim("v" + VERSION)}`;
    const statusRight = C.dim(status + "  ");
    const leftV = statusLeft.replace(/\x1B\[[0-9;]*m/g, "");
    const rightV = statusRight.replace(/\x1B\[[0-9;]*m/g, "");
    const gap = Math.max(1, this.width - leftV.length - rightV.length);
    process.stdout.write(statusLeft + " ".repeat(gap) + statusRight);
  }

  _drawContent() {
    const visible = this.contentLines.slice(this.scrollOffset, this.scrollOffset + this.contentHeight);
    for (let i = 0; i < this.contentHeight; i++) {
      const row = this.contentStartRow + i;
      process.stdout.write(ansi.cursorTo(row, 1) + ansi.eraseLine);
      if (i < visible.length) {
        process.stdout.write(visible[i]);
      }
    }
  }

  _drawInput() {
    process.stdout.write(ansi.cursorTo(this.inputRow, 1) + ansi.eraseLine);
    if (this.inputActive) {
      const prefix = this.inputPrefix;
      const buffer = this.inputBuffer;
      process.stdout.write(prefix + buffer);
    } else {
      process.stdout.write(C.dim("  │ ") + C.dim("press any key to continue..."));
    }
  }

  _drawScrollIndicator() {
    if (!this.scrollMode) return;
    const total = this.contentLines.length;
    const top = this.scrollOffset + 1;
    const bottom = Math.min(this.scrollOffset + this.contentHeight, total);
    const pct = total > this.contentHeight ? Math.round((this.scrollOffset / (total - this.contentHeight)) * 100) : 100;

    process.stdout.write(ansi.cursorTo(this.inputRow, 1) + ansi.eraseLine);
    process.stdout.write(
      C.dim("  │ ") +
      C.dim(`lines ${top}-${bottom}/${total}`) +
      C.dim(`  (${pct}%)`) +
      C.dim("  ↑↓ scroll  q/Esc back  g/G top/bottom")
    );
  }

  // -----------------------------------------------------------------------
  // Raw mode key handling
  // -----------------------------------------------------------------------

  _enableRawMode() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", this._onKeypress = (data) => this._handleKeypress(data));
    }
  }

  _disableRawMode() {
    if (process.stdin.isTTY && this._onKeypress) {
      process.stdin.removeListener("data", this._onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }

  _handleKeypress(data) {
    // Ctrl+C
    if (data === "\u0003") {
      this.close();
      process.exit(0);
    }

    // Scroll mode
    if (this.scrollMode) {
      this._handleScrollKey(data);
      return;
    }

    // Input mode
    if (this.inputActive) {
      this._handleInputKey(data);
    }
  }

  _handleScrollKey(data) {
    switch (data) {
      case "q":
      case "\u001B": // Escape
        this.exitScrollMode();
        break;
      case "\u001B[A": // Up arrow
        this.scrollUp(1);
        break;
      case "\u001B[B": // Down arrow
        this.scrollDown(1);
        break;
      case "\u001B[5~": // Page Up
        this.pageUp();
        break;
      case "\u001B[6~": // Page Down
        this.pageDown();
        break;
      case "g":
        this.scrollToTop();
        break;
      case "G":
        this.scrollToBottom();
        break;
      case "j":
        this.scrollDown(1);
        break;
      case "k":
        this.scrollUp(1);
        break;
    }
  }

  _handleInputKey(data) {
    switch (data) {
      case "\r": // Enter
        this._submitInput();
        break;
      case "\u007F": // Backspace
        if (this.inputCursorPos > 0) {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.inputCursorPos - 1) +
            this.inputBuffer.slice(this.inputCursorPos);
          this.inputCursorPos--;
          this._drawInput();
        }
        break;
      case "\u001B[A": // Up arrow — enter scroll mode
        if (this.contentLines.length > this.contentHeight) {
          this.enterScrollMode();
        }
        break;
      case "\u001B[B": // Down arrow
        break;
      case "\u001B[C": // Right arrow
        if (this.inputCursorPos < this.inputBuffer.length) {
          this.inputCursorPos++;
          this._drawInput();
        }
        break;
      case "\u001B[D": // Left arrow
        if (this.inputCursorPos > 0) {
          this.inputCursorPos--;
          this._drawInput();
        }
        break;
      case "\u001B[H": // Home
        this.inputCursorPos = 0;
        this._drawInput();
        break;
      case "\u001B[F": // End
        this.inputCursorPos = this.inputBuffer.length;
        this._drawInput();
        break;
      case "\u001B[3~": // Delete
        if (this.inputCursorPos < this.inputBuffer.length) {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.inputCursorPos) +
            this.inputBuffer.slice(this.inputCursorPos + 1);
          this._drawInput();
        }
        break;
      case "\u001B[1;5A": // Ctrl+Up
        if (this.contentLines.length > this.contentHeight) {
          this.enterScrollMode();
        }
        break;
      default:
        // Printable character
        if (data >= " " && data.length === 1) {
          this.inputBuffer =
            this.inputBuffer.slice(0, this.inputCursorPos) +
            data +
            this.inputBuffer.slice(this.inputCursorPos);
          this.inputCursorPos++;
          this._drawInput();
        }
        break;
    }
  }

  _submitInput() {
    const input = this.inputBuffer;
    this.inputActive = false;
    this._drawInput();
    if (this._promptResolve) {
      const resolve = this._promptResolve;
      this._promptResolve = null;
      resolve(input);
    }
  }

  _handleResize() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.contentEndRow = this.height - this.footerLines;
    this.contentHeight = this.contentEndRow - this.contentStartRow + 1;
    this.inputRow = this.height;
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (this.scrollOffset > this.maxScroll) this.scrollOffset = this.maxScroll;

    process.stdout.write(ansi.clearScreen);
    this._drawStatic();
    this._drawContent();
    this._drawInput();
  }
}

module.exports = { Terminal, C, WORDMARK, VERSION, ansi };

"use strict";

const readline = require("readline");
const chalk = require("chalk");
const C = require("./colors");

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------
const ESC = "\x1B";
const CSI = `${ESC}[`;

const ansi = {
  altScreenOn:    `${ESC}[?1049h`,
  altScreenOff:   `${ESC}[?1049l`,
  clearScreen:    `${CSI}2J${CSI}H`,
  cursorHide:     `${CSI}?25l`,
  cursorShow:     `${CSI}?25h`,
  cursorTo:       (row, col) => `${CSI}${row};${col}H`,
  eraseLine:      `${CSI}2K`,
  eraseBelow:     `${CSI}0J`,
  scrollRegion:   (top, bottom) => `${CSI}${top};${bottom}r`,
  resetRegion:    `${CSI}r`,
  mouseEnable:    `${CSI}?1000h${CSI}?1002h${CSI}?1006h`,
  mouseDisable:   `${CSI}?1000l${CSI}?1002l${CSI}?1006l`,
};

const VERSION = require("../package.json").version;

// ---------------------------------------------------------------------------
// Default commands for the palette
// ---------------------------------------------------------------------------
const DEFAULT_COMMANDS = [
  { cmd: "/findings",    desc: "show all findings" },
  { cmd: "/new",         desc: "show new findings" },
  { cmd: "/approve all", desc: "approve all fixable" },
  { cmd: "/approve",     desc: "approve finding #n" },
  { cmd: "/skip",        desc: "skip finding #n" },
  { cmd: "/fix all",     desc: "apply all fixes" },
  { cmd: "/fix",         desc: "apply fix #n" },
  { cmd: "/diff",        desc: "side-by-side diff" },
  { cmd: "/para",        desc: "inspect paragraph" },
  { cmd: "/rescan",      desc: "re-analyze document" },
  { cmd: "/open",        desc: "open in Word" },
  { cmd: "/file",        desc: "show file path" },
  { cmd: "/summary",     desc: "findings summary" },
  { cmd: "/status",      desc: "connection status" },
  { cmd: "/clear",       desc: "clear screen" },
  { cmd: "/help",        desc: "show help" },
  { cmd: "/quit",        desc: "exit" },
];

// ---------------------------------------------------------------------------
// Terminal TUI — alternate screen, scrollable, fixed input, command palette
// ---------------------------------------------------------------------------
class Terminal {
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    // Layout
    this.headerRowStart = 1;
    this.headerRowCount = 8;
    this.contentRowStart = this.headerRowCount + 1;
    this.footerRowCount = 2;
    this.inputRow = this.height;
    this.statusRow = this.height - 1;
    this.contentHeight = this.height - this.headerRowCount - this.footerRowCount;

    // Content state
    this.contentLines = [];
    this.scrollOffset = 0;
    this.maxScroll = 0;

    // Input state
    this.inputBuffer = "";
    this.inputCursorPos = 0;
    this.inputPrefix = "  \u2502 wordcheck \u203a ";
    this.inputActive = false;

    // Scroll mode
    this.scrollMode = false;

    // Command palette state
    this.paletteVisible = false;
    this.paletteSelected = 0;
    this.paletteFiltered = [];
    this.paletteCommands = DEFAULT_COMMANDS;

    // Header lines
    this._headerLines = [];

    // Dirty tracking
    this._dirty = { header: true, content: true, input: true, status: true };

    // Keypress handler ref
    this._onKeypress = null;
    this._onResize = null;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  open() {
    process.stdout.write(ansi.altScreenOn);
    process.stdout.write(ansi.cursorHide);
    process.stdout.write(ansi.clearScreen);
    process.stdout.write(ansi.mouseEnable);
    this._drawAll();
    this._enableRawMode();
  }

  close() {
    this._disableRawMode();
    process.stdout.write(ansi.resetRegion);
    process.stdout.write(ansi.cursorShow);
    process.stdout.write(ansi.mouseDisable);
    process.stdout.write(ansi.altScreenOff);
  }

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------

  _drawAll() {
    this._drawHeader();
    this._drawContent();
    this._drawStatusBar();
    this._drawInputArea();
  }

  _drawHeader() {
    const lines = this._headerLines || [];
    for (let i = 0; i < this.headerRowCount; i++) {
      process.stdout.write(ansi.cursorTo(this.headerRowStart + i, 1) + ansi.eraseLine);
      if (lines[i]) process.stdout.write(lines[i]);
    }
    this._dirty.header = false;
  }

  _drawContent() {
    const visible = this.contentLines.slice(
      this.scrollOffset,
      this.scrollOffset + this.contentHeight
    );
    for (let i = 0; i < this.contentHeight; i++) {
      const row = this.contentRowStart + i;
      process.stdout.write(ansi.cursorTo(row, 1) + ansi.eraseLine);
      if (i < visible.length) process.stdout.write(visible[i]);
    }
    this._dirty.content = false;
  }

  _drawStatusBar() {
    process.stdout.write(ansi.cursorTo(this.statusRow, 1) + ansi.eraseLine);
    const w = this.width;
    const left = `  \u25CF ${C.pink("wordcheck")}  ${C.dim("v" + VERSION)}`;
    const status = this._statusText || "ready";
    const right = C.dim(status + "  ");
    const leftV = left.replace(/\x1B\[[0-9;]*m/g, "");
    const rightV = right.replace(/\x1B\[[0-9;]*m/g, "");
    const gap = Math.max(1, w - leftV.length - rightV.length);
    process.stdout.write(left + " ".repeat(gap) + right);
    this._dirty.status = false;
  }

  _drawInputArea() {
    // Calculate how many rows the palette takes
    const paletteRows = this.paletteVisible ? Math.min(this.paletteFiltered.length, 8) + 1 : 0;
    const inputRow = this.inputRow - paletteRows;

    // Draw palette if visible
    if (this.paletteVisible) {
      this._drawCommandPalette();
    }

    // Draw input line
    process.stdout.write(ansi.cursorTo(inputRow, 1) + ansi.eraseLine);
    if (this.inputActive) {
      const before = this.inputBuffer.slice(0, this.inputCursorPos);
      const after = this.inputBuffer.slice(this.inputCursorPos);
      process.stdout.write(
        this.inputPrefix +
        before +
        chalk.inverse(after[0] || " ") +
        (after.length > 1 ? after.slice(1) : "")
      );
    } else if (this.scrollMode) {
      const total = this.contentLines.length;
      const top = this.scrollOffset + 1;
      const bottom = Math.min(this.scrollOffset + this.contentHeight, total);
      process.stdout.write(
        C.dim("  \u2502 ") +
        C.dim(`${top}-${bottom}/${total}`) +
        C.dim("  \u2191\u2193jk scroll") +
        C.dim("  q/Esc back") +
        C.dim("  g/G top/bottom")
      );
    } else {
      process.stdout.write(C.dim("  \u2502 ") + C.dim("type a command or chat with AI"));
    }
    this._dirty.input = false;
  }

  _drawCommandPalette() {
    const maxVisible = 8;
    const paletteRows = Math.min(this.paletteFiltered.length, maxVisible);
    const startRow = this.inputRow - paletteRows - 1;

    // Draw palette border top
    process.stdout.write(ansi.cursorTo(startRow, 1) + ansi.eraseLine);
    process.stdout.write(C.dim("  \u256D") + C.dim("\u2500".repeat(Math.min(this.width - 6, 50))) + C.dim("\u256E"));

    // Draw visible commands
    for (let i = 0; i < paletteRows; i++) {
      const row = startRow + 1 + i;
      process.stdout.write(ansi.cursorTo(row, 1) + ansi.eraseLine);

      const cmd = this.paletteFiltered[i];
      if (!cmd) continue;

      const isSelected = i === this.paletteSelected;
      const prefix = isSelected ? C.pink("  \u2502 \u25B6 ") : C.dim("  \u2502   ");
      const cmdText = isSelected ? C.white.bold(cmd.cmd) : C.dim(cmd.cmd);
      const descText = isSelected ? C.dim("  " + cmd.desc) : C.dim("  " + cmd.desc);

      process.stdout.write(prefix + cmdText + descText);
    }

    // Draw palette border bottom
    process.stdout.write(ansi.cursorTo(startRow + paletteRows + 1, 1) + ansi.eraseLine);
    process.stdout.write(C.dim("  \u2570") + C.dim("\u2500".repeat(Math.min(this.width - 6, 50))) + C.dim("\u256F"));
  }

  // -----------------------------------------------------------------------
  // Content management
  // -----------------------------------------------------------------------

  addLine(line = "") {
    this.contentLines.push(line);
    const maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (this.scrollOffset >= maxScroll - 1 || !this.scrollMode) {
      this.scrollOffset = maxScroll;
    }
    this.maxScroll = maxScroll;
    if (!this.scrollMode) this._drawContent();
  }

  addLines(lines) {
    for (const line of lines) this.contentLines.push(line);
    const maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (!this.scrollMode) this.scrollOffset = maxScroll;
    this.maxScroll = maxScroll;
    if (!this.scrollMode) this._drawContent();
  }

  clearContent() {
    this.contentLines = [];
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this._drawContent();
  }

  setHeader(lines) {
    this._headerLines = lines;
    this._drawHeader();
  }

  setStatus(text) {
    this._statusText = text;
    this._drawStatusBar();
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  async prompt() {
    return new Promise((resolve) => {
      this.inputActive = true;
      this.inputBuffer = "";
      this.inputCursorPos = 0;
      this.scrollMode = false;
      this.paletteVisible = false;
      this._drawInputArea();
      this._promptResolve = resolve;
    });
  }

  cancelPrompt() {
    if (this._promptResolve) {
      this._promptResolve(null);
      this._promptResolve = null;
    }
    this.inputActive = false;
    this.paletteVisible = false;
  }

  _submitInput() {
    const input = this.inputBuffer;
    this.inputActive = false;
    this.paletteVisible = false;
    this._drawInputArea();
    if (this._promptResolve) {
      const resolve = this._promptResolve;
      this._promptResolve = null;
      resolve(input);
    }
  }

  // -----------------------------------------------------------------------
  // Command palette
  // -----------------------------------------------------------------------

  _showPalette() {
    this.paletteFiltered = this.paletteCommands;
    this.paletteSelected = 0;
    this.paletteVisible = true;
    this._drawInputArea();
  }

  _hidePalette() {
    this.paletteVisible = false;
    this._drawInputArea();
  }

  _filterPalette(query) {
    const q = query.toLowerCase();
    this.paletteFiltered = this.paletteCommands.filter(
      (c) => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
    );
    if (this.paletteSelected >= this.paletteFiltered.length) {
      this.paletteSelected = Math.max(0, this.paletteFiltered.length - 1);
    }
    this.paletteVisible = this.paletteFiltered.length > 0;
    this._drawInputArea();
  }

  _paletteUp() {
    if (this.paletteSelected > 0) {
      this.paletteSelected--;
      this._drawInputArea();
    }
  }

  _paletteDown() {
    if (this.paletteSelected < this.paletteFiltered.length - 1) {
      this.paletteSelected++;
      this._drawInputArea();
    }
  }

  _paletteSelect() {
    if (this.paletteFiltered.length > 0) {
      const selected = this.paletteFiltered[this.paletteSelected];
      if (selected) {
        this.inputBuffer = selected.cmd + " ";
        this.inputCursorPos = this.inputBuffer.length;
        this.paletteVisible = false;
        this._drawInputArea();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Scroll mode
  // -----------------------------------------------------------------------

  enterScrollMode() {
    this.scrollMode = true;
    this._drawContent();
    this._drawInputArea();
  }

  exitScrollMode() {
    this.scrollMode = false;
    this._drawContent();
    this._drawInputArea();
  }

  scrollUp(n = 3) {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
    this._drawContent();
    this._drawInputArea();
  }

  scrollDown(n = 3) {
    this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + n);
    this._drawContent();
    this._drawInputArea();
  }

  pageUp()   { this.scrollUp(this.contentHeight - 2); }
  pageDown() { this.scrollDown(this.contentHeight - 2); }
  scrollToTop()    { this.scrollOffset = 0; this._drawContent(); this._drawInputArea(); }
  scrollToBottom() { this.scrollOffset = this.maxScroll; this._drawContent(); this._drawInputArea(); }

  // -----------------------------------------------------------------------
  // Raw mode — proper paste handling
  // -----------------------------------------------------------------------

  _enableRawMode() {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    this._onResize = () => this._handleResize();
    process.stdout.on("resize", this._onResize);
    process.stdin.on("data", this._onKeypress = (data) => this._handleKeypress(data));
  }

  _disableRawMode() {
    if (!process.stdin.isTTY || !this._onKeypress) return;
    process.stdin.removeListener("data", this._onKeypress);
    if (this._onResize) process.stdout.removeListener("resize", this._onResize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
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
      this._processInputData(data);
    }
  }

  _processInputData(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      // Escape sequence
      if (ch === "\x1B") {
        const seq = data.slice(i);
        if (seq.startsWith("\x1B[A")) {        // Up arrow
          if (this.paletteVisible) {
            this._paletteUp();
          } else if (this.contentLines.length > this.contentHeight) {
            this.enterScrollMode();
          }
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[B")) {        // Down arrow
          if (this.paletteVisible) {
            this._paletteDown();
          }
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[C")) {        // Right arrow
          if (this.inputCursorPos < this.inputBuffer.length) this.inputCursorPos++;
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[D")) {        // Left arrow
          if (this.inputCursorPos > 0) this.inputCursorPos--;
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[H")) { this.inputCursorPos = 0; i += 3; continue; }
        if (seq.startsWith("\x1B[F")) { this.inputCursorPos = this.inputBuffer.length; i += 3; continue; }
        if (seq.startsWith("\x1B[3~")) {       // Delete
          if (this.inputCursorPos < this.inputBuffer.length) {
            this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos) + this.inputBuffer.slice(this.inputCursorPos + 1);
          }
          i += 4; continue;
        }
        if (seq.startsWith("\x1B[5~")) { this.pageUp(); i += 4; continue; }
        if (seq.startsWith("\x1B[6~")) { this.pageDown(); i += 4; continue; }
        if (seq.startsWith("\x1B[<")) {        // Mouse event (SGR format)
          const end = seq.indexOf("M", 3);
          const endR = seq.indexOf("m", 3);
          const termIdx = end !== -1 ? end : endR;
          if (termIdx !== -1) {
            this._handleMouseEvent(seq.slice(3, termIdx), end !== -1 ? "press" : "release");
            i += termIdx + 1; continue;
          }
        }
        // Escape — dismiss palette if visible
        if (this.paletteVisible) {
          this._hidePalette();
        }
        i++; continue;
      }

      // Enter
      if (ch === "\r" || ch === "\n") {
        if (this.paletteVisible) {
          this._paletteSelect();
        } else {
          this._submitInput();
        }
        i++; continue;
      }

      // Backspace
      if (ch === "\u007F" || ch === "\b") {
        if (this.inputCursorPos > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos - 1) + this.inputBuffer.slice(this.inputCursorPos);
          this.inputCursorPos--;
        }
        // Update palette filter
        if (this.inputBuffer.startsWith("/")) {
          this._filterPalette(this.inputBuffer);
        } else {
          this._hidePalette();
        }
        i++; continue;
      }

      // Tab — autocomplete from palette
      if (ch === "\t") {
        if (this.paletteVisible) {
          this._paletteSelect();
        }
        i++; continue;
      }

      // Regular printable character
      if (ch >= " ") {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos) + ch + this.inputBuffer.slice(this.inputCursorPos);
        this.inputCursorPos++;

        // Show/filter command palette when typing "/"
        if (this.inputBuffer === "/" || (this.inputBuffer.startsWith("/") && !this.inputBuffer.includes(" "))) {
          this._filterPalette(this.inputBuffer);
        } else {
          this._hidePalette();
        }

        i++; continue;
      }

      // Skip other control chars
      i++;
    }

    this._drawInputArea();
  }

  _handleScrollKey(data) {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === "\x1B" && i + 2 < data.length) {
        const seq = data.slice(i);
        if (seq.startsWith("\x1B[A")) { this.scrollUp(1); i += 2; continue; }
        if (seq.startsWith("\x1B[B")) { this.scrollDown(1); i += 2; continue; }
        if (seq.startsWith("\x1B[5~")) { this.pageUp(); i += 3; continue; }
        if (seq.startsWith("\x1B[6~")) { this.pageDown(); i += 3; continue; }
      }
      if (ch === "q" || ch === "\u001B") { this.exitScrollMode(); return; }
      if (ch === "j") { this.scrollDown(1); }
      if (ch === "k") { this.scrollUp(1); }
      if (ch === "g") { this.scrollToTop(); }
      if (ch === "G") { this.scrollToBottom(); }
    }
  }

  _handleMouseEvent(data, type) {
    const parts = data.split(";");
    if (parts.length < 3) return;
    const button = parseInt(parts[0], 10);
    if (type === "press") {
      if (button === 64) this.scrollUp(3);
      if (button === 65) this.scrollDown(3);
    }
  }

  // -----------------------------------------------------------------------
  // Resize
  // -----------------------------------------------------------------------

  _handleResize() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.inputRow = this.height;
    this.statusRow = this.height - 1;
    this.contentHeight = this.height - this.headerRowCount - this.footerRowCount;
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (this.scrollOffset > this.maxScroll) this.scrollOffset = this.maxScroll;
    process.stdout.write(ansi.clearScreen);
    this._drawAll();
  }
}

module.exports = { Terminal, C, ansi };

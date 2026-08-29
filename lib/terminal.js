"use strict";

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
  mouseEnable:    `${CSI}?1000h${CSI}?1002h${CSI}?1006h`,
  mouseDisable:   `${CSI}?1000l${CSI}?1002l${CSI}?1006l`,
};

const VERSION = require("../package.json").version;

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
// Terminal — Bubbletea-inspired Model-Update-View architecture
// ---------------------------------------------------------------------------
class Terminal {
  constructor() {
    // Layout
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.headerRowCount = 8;
    this.footerRowCount = 2;
    this.contentRowStart = this.headerRowCount + 1;
    this.contentHeight = this.height - this.headerRowCount - this.footerRowCount;
    this.inputRow = this.height;

    // Model state
    this.contentLines = [];
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this.inputBuffer = "";
    this.inputCursorPos = 0;
    this.inputPrefix = "  \u2502 wordcheck \u203a ";
    this.inputActive = false;
    this.scrollMode = false;
    this.headerLines = [];
    this.statusText = "ready";

    // Command palette state
    this.palette = {
      visible: false,
      selected: 0,
      filtered: [],
      commands: DEFAULT_COMMANDS,
    };

    // Callbacks
    this._onKeypress = null;
    this._onResize = null;
    this._promptResolve = null;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  open() {
    process.stdout.write(ansi.altScreenOn);
    process.stdout.write(ansi.cursorHide);
    process.stdout.write(ansi.clearScreen);
    process.stdout.write(ansi.mouseEnable);
    this._render();
    this._enableInput();
  }

  close() {
    this._disableInput();
    process.stdout.write(ansi.cursorShow);
    process.stdout.write(ansi.mouseDisable);
    process.stdout.write(ansi.altScreenOff);
  }

  // -----------------------------------------------------------------------
  // Public API — Update model
  // -----------------------------------------------------------------------

  addLine(line = "") {
    this.contentLines.push(line);
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (!this.scrollMode) this.scrollOffset = this.maxScroll;
    this._renderContent();
  }

  addLines(lines) {
    for (const line of lines) this.contentLines.push(line);
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (!this.scrollMode) this.scrollOffset = this.maxScroll;
    this._renderContent();
  }

  clearContent() {
    this.contentLines = [];
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this._renderContent();
  }

  setHeader(lines) {
    this.headerLines = lines;
    this._renderHeader();
  }

  setStatus(text) {
    this.statusText = text;
    this._renderStatus();
  }

  // -----------------------------------------------------------------------
  // Public API — Input
  // -----------------------------------------------------------------------

  async prompt() {
    return new Promise((resolve) => {
      this.inputActive = true;
      this.inputBuffer = "";
      this.inputCursorPos = 0;
      this.scrollMode = false;
      this._promptResolve = resolve;
      this._renderInput();
    });
  }

  cancelPrompt() {
    if (this._promptResolve) {
      this._promptResolve(null);
      this._promptResolve = null;
    }
    this.inputActive = false;
    this.palette.visible = false;
  }

  // -----------------------------------------------------------------------
  // View — Render functions
  // -----------------------------------------------------------------------

  _render() {
    this._renderHeader();
    this._renderContent();
    this._renderStatus();
    this._renderInput();
  }

  _renderHeader() {
    const lines = this.headerLines || [];
    for (let i = 0; i < this.headerRowCount; i++) {
      process.stdout.write(ansi.cursorTo(i + 1, 1) + ansi.eraseLine);
      if (lines[i]) process.stdout.write(lines[i]);
    }
  }

  _renderContent() {
    const visible = this.contentLines.slice(this.scrollOffset, this.scrollOffset + this.contentHeight);
    for (let i = 0; i < this.contentHeight; i++) {
      const row = this.contentRowStart + i;
      process.stdout.write(ansi.cursorTo(row, 1) + ansi.eraseLine);
      if (i < visible.length) process.stdout.write(visible[i]);
    }
  }

  _renderStatus() {
    process.stdout.write(ansi.cursorTo(this.inputRow - 1, 1) + ansi.eraseLine);
    const left = `  \u25CF ${C.pink("wordcheck")}  ${C.dim("v" + VERSION)}`;
    const right = C.dim(this.statusText + "  ");
    const leftV = left.replace(/\x1B\[[0-9;]*m/g, "");
    const rightV = right.replace(/\x1B\[[0-9;]*m/g, "");
    const gap = Math.max(1, this.width - leftV.length - rightV.length);
    process.stdout.write(left + " ".repeat(gap) + right);
  }

  _renderInput() {
    process.stdout.write(ansi.cursorTo(this.inputRow, 1) + ansi.eraseLine);

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
        C.dim("  \u2191\u2193jk scroll  q/Esc back  g/G top/bottom")
      );
    } else {
      process.stdout.write(C.dim("  \u2502 ") + C.dim("type a command or chat with AI"));
    }
  }

  _renderPalette() {
    const maxVisible = 8;
    const count = Math.min(this.palette.filtered.length, maxVisible);
    if (count === 0) return;

    // Palette sits above input, overlaying content
    const startRow = this.inputRow - count - 2;

    // Top border
    process.stdout.write(ansi.cursorTo(startRow, 1) + ansi.eraseLine);
    process.stdout.write(C.dim("  \u256D") + C.dim("\u2500".repeat(Math.min(this.width - 6, 52))) + C.dim("\u256E"));

    // Rows
    for (let i = 0; i < count; i++) {
      const row = startRow + 1 + i;
      process.stdout.write(ansi.cursorTo(row, 1) + ansi.eraseLine);

      const cmd = this.palette.filtered[i];
      if (!cmd) continue;

      const sel = i === this.palette.selected;
      process.stdout.write(
        (sel ? C.pink("  \u2502 \u25B6 ") : C.dim("  \u2502   ")) +
        (sel ? C.white.bold(cmd.cmd.padEnd(16)) : C.dim(cmd.cmd.padEnd(16))) +
        (sel ? C.dim(cmd.desc) : C.dim(cmd.desc))
      );
    }

    // Bottom border
    process.stdout.write(ansi.cursorTo(startRow + count + 1, 1) + ansi.eraseLine);
    process.stdout.write(C.dim("  \u2570") + C.dim("\u2500".repeat(Math.min(this.width - 6, 52))) + C.dim("\u256F"));
  }

  // -----------------------------------------------------------------------
  // Update — Message handlers
  // -----------------------------------------------------------------------

  _submit() {
    const input = this.inputBuffer;
    this.inputActive = false;
    this.palette.visible = false;
    this._renderContent(); // restore overlayed area
    this._renderInput();
    if (this._promptResolve) {
      const resolve = this._promptResolve;
      this._promptResolve = null;
      resolve(input);
    }
  }

  _insertChar(ch) {
    this.inputBuffer =
      this.inputBuffer.slice(0, this.inputCursorPos) +
      ch +
      this.inputBuffer.slice(this.inputCursorPos);
    this.inputCursorPos++;
  }

  _backspace() {
    if (this.inputCursorPos > 0) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.inputCursorPos - 1) +
        this.inputBuffer.slice(this.inputCursorPos);
      this.inputCursorPos--;
    }
  }

  _cursorLeft() {
    if (this.inputCursorPos > 0) this.inputCursorPos--;
  }

  _cursorRight() {
    if (this.inputCursorPos < this.inputBuffer.length) this.inputCursorPos++;
  }

  _cursorHome() { this.inputCursorPos = 0; }
  _cursorEnd()  { this.inputCursorPos = this.inputBuffer.length; }

  _delete() {
    if (this.inputCursorPos < this.inputBuffer.length) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.inputCursorPos) +
        this.inputBuffer.slice(this.inputCursorPos + 1);
    }
  }

  _scrollUp(n = 3) {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
    this._renderContent();
  }

  _scrollDown(n = 3) {
    this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + n);
    this._renderContent();
  }

  _pageUp()   { this._scrollUp(this.contentHeight - 2); }
  _pageDown() { this._scrollDown(this.contentHeight - 2); }
  _scrollToTop()    { this.scrollOffset = 0; this._renderContent(); }
  _scrollToBottom() { this.scrollOffset = this.maxScroll; this._renderContent(); }

  _enterScrollMode() {
    this.scrollMode = true;
    this._renderContent();
    this._renderInput();
  }

  _exitScrollMode() {
    this.scrollMode = false;
    this._renderContent();
    this._renderInput();
  }

  // -----------------------------------------------------------------------
  // Palette — Update
  // -----------------------------------------------------------------------

  _showPalette() {
    this.palette.filtered = this.palette.commands;
    this.palette.selected = 0;
    this.palette.visible = true;
    this._renderPalette();
    this._renderInput();
  }

  _hidePalette() {
    this.palette.visible = false;
    this._renderContent(); // restore overlayed content
    this._renderInput();
  }

  _filterPalette(query) {
    const q = query.toLowerCase();
    this.palette.filtered = this.palette.commands.filter(
      (c) => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
    );
    if (this.palette.selected >= this.palette.filtered.length) {
      this.palette.selected = Math.max(0, this.palette.filtered.length - 1);
    }
    const wasVisible = this.palette.visible;
    this.palette.visible = this.palette.filtered.length > 0;
    if (wasVisible && !this.palette.visible) {
      this._renderContent();
    }
    if (this.palette.visible) {
      this._renderPalette();
    }
    this._renderInput();
  }

  _paletteUp() {
    if (this.palette.selected > 0) {
      this.palette.selected--;
      this._renderPalette();
    }
  }

  _paletteDown() {
    if (this.palette.selected < this.palette.filtered.length - 1) {
      this.palette.selected++;
      this._renderPalette();
    }
  }

  _paletteSelect() {
    if (this.palette.filtered.length > 0) {
      const selected = this.palette.filtered[this.palette.selected];
      if (selected) {
        this.inputBuffer = selected.cmd + " ";
        this.inputCursorPos = this.inputBuffer.length;
        this.palette.visible = false;
        this._renderContent();
        this._renderInput();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Input — Raw mode handler
  // -----------------------------------------------------------------------

  _enableInput() {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    this._onResize = () => this._handleResize();
    process.stdout.on("resize", this._onResize);
    process.stdin.on("data", this._onKeypress = (data) => this._handleKeypress(data));
  }

  _disableInput() {
    if (!process.stdin.isTTY || !this._onKeypress) return;
    process.stdin.removeListener("data", this._onKeypress);
    if (this._onResize) process.stdout.removeListener("resize", this._onResize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  _handleKeypress(data) {
    if (data === "\u0003") { this.close(); process.exit(0); }

    if (this.scrollMode) {
      this._handleScrollKey(data);
      return;
    }

    if (this.inputActive) {
      this._processInput(data);
    }
  }

  _processInput(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      // Escape sequences
      if (ch === "\x1B") {
        const seq = data.slice(i);

        if (seq.startsWith("\x1B[A")) { // Up
          if (this.palette.visible) this._paletteUp();
          else if (this.contentLines.length > this.contentHeight) this._enterScrollMode();
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[B")) { // Down
          if (this.palette.visible) this._paletteDown();
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[C")) { this._cursorRight(); i += 3; continue; }
        if (seq.startsWith("\x1B[D")) { this._cursorLeft();  i += 3; continue; }
        if (seq.startsWith("\x1B[H")) { this._cursorHome();  i += 3; continue; }
        if (seq.startsWith("\x1B[F")) { this._cursorEnd();   i += 3; continue; }
        if (seq.startsWith("\x1B[3~")) { this._delete();     i += 4; continue; }
        if (seq.startsWith("\x1B[5~")) { this._pageUp();     i += 4; continue; }
        if (seq.startsWith("\x1B[6~")) { this._pageDown();   i += 4; continue; }
        if (seq.startsWith("\x1B[<")) { // Mouse
          const end = seq.indexOf("M", 3);
          const endR = seq.indexOf("m", 3);
          const ti = end !== -1 ? end : endR;
          if (ti !== -1) {
            this._handleMouse(seq.slice(3, ti), end !== -1 ? "press" : "release");
            i += ti + 1; continue;
          }
        }

        // Escape — dismiss palette
        if (this.palette.visible) this._hidePalette();
        i++; continue;
      }

      // Enter
      if (ch === "\r" || ch === "\n") {
        if (this.palette.visible) this._paletteSelect();
        else this._submit();
        i++; continue;
      }

      // Backspace
      if (ch === "\u007F" || ch === "\b") {
        this._backspace();
        if (this.inputBuffer.startsWith("/")) this._filterPalette(this.inputBuffer);
        else this._hidePalette();
        i++; continue;
      }

      // Tab
      if (ch === "\t") {
        if (this.palette.visible) this._paletteSelect();
        i++; continue;
      }

      // Printable
      if (ch >= " ") {
        this._insertChar(ch);
        if (this.inputBuffer.startsWith("/") && !this.inputBuffer.includes(" ")) {
          this._filterPalette(this.inputBuffer);
        } else {
          if (this.palette.visible) this._hidePalette();
        }
        i++; continue;
      }

      i++;
    }

    this._renderInput();
  }

  _handleScrollKey(data) {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === "\x1B" && i + 2 < data.length) {
        const seq = data.slice(i);
        if (seq.startsWith("\x1B[A")) { this._scrollUp(1); i += 2; continue; }
        if (seq.startsWith("\x1B[B")) { this._scrollDown(1); i += 2; continue; }
        if (seq.startsWith("\x1B[5~")) { this._pageUp(); i += 3; continue; }
        if (seq.startsWith("\x1B[6~")) { this._pageDown(); i += 3; continue; }
      }
      if (ch === "q" || ch === "\u001B") { this._exitScrollMode(); return; }
      if (ch === "j") this._scrollDown(1);
      if (ch === "k") this._scrollUp(1);
      if (ch === "g") this._scrollToTop();
      if (ch === "G") this._scrollToBottom();
    }
  }

  _handleMouse(data, type) {
    const parts = data.split(";");
    if (parts.length < 3) return;
    const button = parseInt(parts[0], 10);
    if (type === "press") {
      if (button === 64) this._scrollUp(3);
      if (button === 65) this._scrollDown(3);
    }
  }

  _handleResize() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.inputRow = this.height;
    this.contentHeight = this.height - this.headerRowCount - this.footerRowCount;
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (this.scrollOffset > this.maxScroll) this.scrollOffset = this.maxScroll;
    process.stdout.write(ansi.clearScreen);
    this._render();
  }
}

module.exports = { Terminal, C, ansi };

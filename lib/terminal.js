"use strict";

const chalk = require("chalk");
const C = require("./colors");

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
  mouseEnable:    `${CSI}?1000h${CSI}?1002h${CSI}?1006h`,
  mouseDisable:   `${CSI}?1000l${CSI}?1002l${CSI}?1006l`,
};

const VERSION = require("../package.json").version;

/** Word-wrap text to fit within max width, respecting ANSI codes */
function wrapText(text, maxWidth) {
  if (!text) return [""];
  // Strip ANSI for length measurement
  const strip = (s) => s.replace(/\x1B\[[0-9;]*m/g, "");
  const visLen = (s) => strip(s).length;

  const words = text.split(/(\s+)/);
  const lines = [];
  let line = "";

  for (const word of words) {
    if (visLen(line + word) > maxWidth && line.length > 0) {
      lines.push(line);
      line = word.trimStart();
    } else {
      line += word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

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
  { cmd: "/settings",    desc: "configure AI settings" },
  { cmd: "/model",       desc: "change AI model" },
  { cmd: "/open",        desc: "open in Word" },
  { cmd: "/file",        desc: "show file path" },
  { cmd: "/summary",     desc: "findings summary" },
  { cmd: "/status",      desc: "connection status" },
  { cmd: "/clear",       desc: "clear screen" },
  { cmd: "/help",        desc: "show help" },
  { cmd: "/quit",        desc: "exit" },
];

class Terminal {
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.headerRowCount = 8;

    this.headerRowStart = 1;
    this.contentRowStart = this.headerRowCount + 1;
    this.inputRow = this.height;
    this.statusRow = this.height - 1;
    this.contentHeight = this.statusRow - this.contentRowStart;

    // State
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

    // Palette
    this.palette = {
      visible: false,
      selected: 0,
      filtered: [],
      commands: DEFAULT_COMMANDS,
    };

    // Modal overlay
    this.modal = {
      visible: false,
      title: "",
      lines: [],
      selected: 0,
      onSelect: null,
      onCancel: null,
    };

    // Dirty tracking — only redraw what changed
    this._dirty = {
      header: true,
      content: true,
      status: true,
      input: true,
      palette: true,
      modal: true,
    };

    // Write buffer — batch all writes, flush once per frame
    this._buf = [];
    this._flushScheduled = false;

    this._onKeypress = null;
    this._onResize = null;
    this._promptResolve = null;
  }

  // -----------------------------------------------------------------------
  // Buffered write — collect all writes, flush once
  // -----------------------------------------------------------------------

  _write(str) {
    this._buf.push(str);
  }

  _flush() {
    if (this._buf.length > 0) {
      process.stdout.write(this._buf.join(""));
      this._buf = [];
    }
    this._flushScheduled = false;
  }

  _scheduleFlush() {
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      // Use setImmediate for next tick flush — batches multiple writes
      setImmediate(() => this._flush());
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  open() {
    process.stdout.write(ansi.altScreenOn + ansi.cursorHide + ansi.clearScreen + ansi.mouseEnable);
    this._renderAll();
    this._enableInput();
  }

  close() {
    this._disableInput();
    process.stdout.write(ansi.cursorShow + ansi.mouseDisable + ansi.altScreenOff);
  }

  // -----------------------------------------------------------------------
  // Public API — mark regions dirty
  // -----------------------------------------------------------------------

  addLine(line = "", noWrap = false) {
    if (noWrap) {
      this.contentLines.push(line);
    } else {
      const maxW = this.width - 2;
      const wrapped = wrapText(line, maxW);
      for (const w of wrapped) this.contentLines.push(w);
    }
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (!this.scrollMode) this.scrollOffset = this.maxScroll;
    this._dirty.content = true;
    this._dirty.palette = true;
    this._renderDirty();
  }

  addLines(lines, noWrap = false) {
    if (noWrap) {
      for (const line of lines) this.contentLines.push(line);
    } else {
      const maxW = this.width - 2;
      for (const line of lines) {
        const wrapped = wrapText(line, maxW);
        for (const w of wrapped) this.contentLines.push(w);
      }
    }
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (!this.scrollMode) this.scrollOffset = this.maxScroll;
    this._dirty.content = true;
    this._dirty.palette = true;
    this._renderDirty();
  }

  clearContent() {
    this.contentLines = [];
    this.scrollOffset = 0;
    this.maxScroll = 0;
    this._dirty.content = true;
    this._renderDirty();
  }

  setHeader(lines) {
    // Header lines should not be wrapped — they have fixed positions
    this.headerLines = lines;
    this._dirty.header = true;
    this._renderDirty();
  }

  setStatus(text) {
    this.statusText = text;
    this._dirty.status = true;
    this._renderDirty();
  }

  async prompt() {
    return new Promise((resolve) => {
      this.inputActive = true;
      this.inputBuffer = "";
      this.inputCursorPos = 0;
      this.scrollMode = false;
      this._promptResolve = resolve;
      this._dirty.input = true;
      this._renderDirty();
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
  // View — Render dirty regions only
  // -----------------------------------------------------------------------

  _renderAll() {
    this._dirty.header = true;
    this._dirty.content = true;
    this._dirty.status = true;
    this._dirty.input = true;
    this._dirty.palette = true;
    this._renderDirty();
  }

  _renderDirty() {
    if (this._dirty.header) { this._drawHeader(); this._dirty.header = false; }
    if (this._dirty.content) { this._drawContent(); this._dirty.content = false; }
    if (this._dirty.status) { this._drawStatus(); this._dirty.status = false; }
    if (this._dirty.palette) { this._drawPalette(); this._dirty.palette = false; }
    if (this._dirty.modal) { this._drawModal(); this._dirty.modal = false; }
    if (this._dirty.input) { this._drawInput(); this._dirty.input = false; }
    this._flush();
  }

  _drawHeader() {
    const lines = this.headerLines || [];
    for (let i = 0; i < this.headerRowCount; i++) {
      this._write(ansi.cursorTo(this.headerRowStart + i, 1) + ansi.eraseLine);
      if (lines[i]) this._write(lines[i]);
    }
  }

  _drawContent() {
    const usePalette = this.palette.visible && !this.scrollMode;
    const paletteRows = usePalette ? Math.min(this.palette.filtered.length, 8) + 2 : 0;
    const visibleRows = this.contentHeight - paletteRows;

    const visible = this.contentLines.slice(this.scrollOffset, this.scrollOffset + visibleRows);

    for (let i = 0; i < visibleRows; i++) {
      const row = this.contentRowStart + i;
      this._write(ansi.cursorTo(row, 1) + ansi.eraseLine);
      if (i < visible.length) this._write(visible[i]);
    }
  }

  _drawStatus() {
    this._write(ansi.cursorTo(this.statusRow, 1) + ansi.eraseLine);
    const left = `  \u25CF ${C.pink("wordcheck")}  ${C.dim("v" + VERSION)}`;
    const right = C.dim(this.statusText + "  ");
    const leftV = left.replace(/\x1B\[[0-9;]*m/g, "");
    const rightV = right.replace(/\x1B\[[0-9;]*m/g, "");
    const gap = Math.max(1, this.width - leftV.length - rightV.length);
    this._write(left + " ".repeat(gap) + right);
  }

  _drawInput() {
    this._write(ansi.cursorTo(this.inputRow, 1) + ansi.eraseLine);

    if (this.inputActive) {
      const before = this.inputBuffer.slice(0, this.inputCursorPos);
      const after = this.inputBuffer.slice(this.inputCursorPos);
      this._write(
        this.inputPrefix +
        before +
        chalk.inverse(after[0] || " ") +
        (after.length > 1 ? after.slice(1) : "")
      );
    } else if (this.scrollMode) {
      const total = this.contentLines.length;
      const top = this.scrollOffset + 1;
      const bottom = Math.min(this.scrollOffset + this.contentHeight, total);
      this._write(
        C.dim("  \u2502 ") +
        C.dim(`${top}-${bottom}/${total}`) +
        C.dim("  \u2191\u2193jk scroll  q/Esc back  g/G top/bottom")
      );
    } else {
      this._write(C.dim("  \u2502 ") + C.dim("type a command or chat with AI"));
    }
  }

  _drawPalette() {
    if (!this.palette.visible) return;

    const maxVisible = 8;
    const count = Math.min(this.palette.filtered.length, maxVisible);
    if (count === 0) return;

    const paletteStart = this.statusRow - count - 2;
    const w = this.width - 4;
    const descWidth = w - 20;

    // Top border
    this._write(ansi.cursorTo(paletteStart, 1) + ansi.eraseLine);
    this._write(C.dim("  \u256D") + C.dim("\u2500".repeat(w)) + C.dim("\u256E"));

    // Rows
    for (let i = 0; i < count; i++) {
      const row = paletteStart + 1 + i;
      this._write(ansi.cursorTo(row, 1) + ansi.eraseLine);

      const cmd = this.palette.filtered[i];
      if (!cmd) continue;

      const sel = i === this.palette.selected;
      const cmdText = cmd.cmd.padEnd(16);
      const desc = cmd.desc.length > descWidth ? cmd.desc.slice(0, descWidth - 1) + "\u2026" : cmd.desc.padEnd(descWidth);

      this._write(
        (sel ? C.pink("  \u2502 \u25B6 ") : C.dim("  \u2502   ")) +
        (sel ? C.white.bold(cmdText) : C.dim(cmdText)) +
        (sel ? C.dim(desc) : C.dim(desc))
      );
    }

    // Bottom border
    this._write(ansi.cursorTo(paletteStart + count + 1, 1) + ansi.eraseLine);
    this._write(C.dim("  \u2570") + C.dim("\u2500".repeat(w)) + C.dim("\u256F"));
  }

  // -----------------------------------------------------------------------
  // Modal overlay — centered panel with selectable rows
  // -----------------------------------------------------------------------

  showModal(title, lines, selected, onSelect, onCancel) {
    this.modal = { visible: true, title, lines, selected, onSelect, onCancel };
    this._dirty.modal = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  hideModal() {
    this.modal.visible = false;
    this._dirty.modal = true;
    this._dirty.content = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  _drawModal() {
    if (!this.modal.visible) return;

    const m = this.modal;
    const maxVisible = Math.min(m.lines.length, this.contentHeight - 4);
    const w = Math.min(this.width - 6, 64);
    const modalHeight = maxVisible + 4; // top border + title + lines + bottom border
    const startRow = this.contentRowStart + Math.max(0, Math.floor((this.contentHeight - modalHeight) / 2));

    // Top border
    this._write(ansi.cursorTo(startRow, 1) + ansi.eraseLine);
    this._write(C.dim("  \u256D") + C.dim("\u2500".repeat(w)) + C.dim("\u256E"));

    // Title
    this._write(ansi.cursorTo(startRow + 1, 1) + ansi.eraseLine);
    this._write(C.pink.bold("  \u2502 " + m.title));

    // Separator
    this._write(ansi.cursorTo(startRow + 2, 1) + ansi.eraseLine);
    this._write(C.dim("  \u251C") + C.dim("\u2500".repeat(w)) + C.dim("\u2524"));

    // Rows
    for (let i = 0; i < maxVisible; i++) {
      const row = startRow + 3 + i;
      this._write(ansi.cursorTo(row, 1) + ansi.eraseLine);
      const item = m.lines[i];
      if (!item) continue;
      const sel = i === m.selected;
      this._write(
        (sel ? C.pink("  \u2502 \u25B6 ") : C.dim("  \u2502   ")) +
        (sel ? C.white.bold(item) : C.dim(item))
      );
    }

    // Bottom border
    const bottomRow = startRow + 3 + maxVisible;
    this._write(ansi.cursorTo(bottomRow, 1) + ansi.eraseLine);
    this._write(C.dim("  \u2570") + C.dim("\u2500".repeat(w)) + C.dim("\u256F"));

    // Footer hint
    const hintRow = bottomRow + 1;
    if (hintRow <= this.statusRow - 2) {
      this._write(ansi.cursorTo(hintRow, 1) + ansi.eraseLine);
      this._write(C.dim("  \u2191\u2193 navigate  Enter select  Esc cancel"));
    }
  }

  modalUp() {
    if (this.modal.selected > 0) {
      this.modal.selected--;
      this._dirty.modal = true;
      this._renderDirty();
    }
  }

  modalDown() {
    if (this.modal.selected < this.modal.lines.length - 1) {
      this.modal.selected++;
      this._dirty.modal = true;
      this._renderDirty();
    }
  }

  modalSelect() {
    if (this.modal.visible && this.modal.onSelect) {
      const idx = this.modal.selected;
      this.modal.visible = false;
      this._dirty.modal = true;
      this._dirty.content = true;
      this._dirty.input = true;
      this._renderDirty();
      this.modal.onSelect(idx);
    }
  }

  modalCancel() {
    if (this.modal.visible && this.modal.onCancel) {
      this.modal.visible = false;
      this._dirty.modal = true;
      this._dirty.content = true;
      this._dirty.input = true;
      this._renderDirty();
      this.modal.onCancel();
    }
  }

  // -----------------------------------------------------------------------
  // Update — State mutations
  // -----------------------------------------------------------------------

  _submit() {
    const input = this.inputBuffer;
    this.inputActive = false;
    this.palette.visible = false;
    this._dirty.content = true;
    this._dirty.input = true;
    this._renderDirty();
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

  _cursorLeft()  { if (this.inputCursorPos > 0) this.inputCursorPos--; }
  _cursorRight() { if (this.inputCursorPos < this.inputBuffer.length) this.inputCursorPos++; }
  _cursorHome()  { this.inputCursorPos = 0; }
  _cursorEnd()   { this.inputCursorPos = this.inputBuffer.length; }

  _delete() {
    if (this.inputCursorPos < this.inputBuffer.length) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.inputCursorPos) +
        this.inputBuffer.slice(this.inputCursorPos + 1);
    }
  }

  _scrollUp(n = 3) {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
    this._dirty.content = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  _scrollDown(n = 3) {
    this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + n);
    this._dirty.content = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  _pageUp()        { this._scrollUp(this.contentHeight - 2); }
  _pageDown()      { this._scrollDown(this.contentHeight - 2); }
  _scrollToTop()   { this.scrollOffset = 0; this._dirty.content = true; this._dirty.input = true; this._renderDirty(); }
  _scrollToBottom(){ this.scrollOffset = this.maxScroll; this._dirty.content = true; this._dirty.input = true; this._renderDirty(); }

  _enterScrollMode() {
    this.scrollMode = true;
    this.palette.visible = false; // hide palette when scrolling
    this._dirty.content = true;
    this._dirty.palette = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  _exitScrollMode() {
    this.scrollMode = false;
    this._dirty.content = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  // -----------------------------------------------------------------------
  // Palette — State mutations
  // -----------------------------------------------------------------------

  _showPalette() {
    this.palette.filtered = this.palette.commands;
    this.palette.selected = 0;
    this.palette.visible = true;
    this._dirty.content = true;
    this._dirty.palette = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  _hidePalette() {
    this.palette.visible = false;
    this._dirty.content = true;
    this._dirty.palette = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  _filterPalette(query) {
    const q = query.toLowerCase();
    this.palette.filtered = this.palette.commands.filter(
      (c) => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)
    );
    if (this.palette.selected >= this.palette.filtered.length) {
      this.palette.selected = Math.max(0, this.palette.filtered.length - 1);
    }
    this.palette.visible = this.palette.filtered.length > 0;
    this._dirty.content = true;
    this._dirty.palette = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  _paletteUp() {
    if (this.palette.selected > 0) {
      this.palette.selected--;
      this._dirty.palette = true;
      this._renderDirty();
    }
  }

  _paletteDown() {
    if (this.palette.selected < this.palette.filtered.length - 1) {
      this.palette.selected++;
      this._dirty.palette = true;
      this._renderDirty();
    }
  }

  _paletteSelect() {
    if (this.palette.filtered.length > 0) {
      const selected = this.palette.filtered[this.palette.selected];
      if (selected) {
        this.inputBuffer = selected.cmd + " ";
        this.inputCursorPos = this.inputBuffer.length;
        this.palette.visible = false;
        this._dirty.content = true;
        this._dirty.palette = true;
        this._dirty.input = true;
        this._renderDirty();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Input — Raw mode
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
    if (this.modal.visible) { this._handleModalKey(data); return; }
    if (this.scrollMode) { this._handleScrollKey(data); return; }
    if (this.inputActive) { this._processInput(data); }
  }

  _processInput(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === "\x1B") {
        const seq = data.slice(i);

        if (seq.startsWith("\x1B[A")) {
          if (this.palette.visible) this._paletteUp();
          else if (this.contentLines.length > this.contentHeight) this._enterScrollMode();
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[B")) {
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

        // Mouse events (SGR format: ESC[<button;col;rowM or m)
        if (seq.startsWith("\x1B[<")) {
          const endM = seq.indexOf("M", 3);
          const endm = seq.indexOf("m", 3);
          const endIdx = endM !== -1 ? endM : endm;
          if (endIdx !== -1) {
            const parts = seq.slice(3, endIdx).split(";");
            const button = parseInt(parts[0], 10);
            if (endM !== -1) { // press
              if (button === 64) this._scrollUp(3);   // wheel up
              if (button === 65) this._scrollDown(3);  // wheel down
            }
            i += endIdx + 1; continue;
          }
        }

        // Unknown escape — skip entire sequence
        // Find the end of the escape sequence (letter terminator)
        let j = i + 1;
        while (j < data.length && !/[a-zA-Z]/.test(data[j])) j++;
        if (j < data.length) j++; // consume the terminator letter
        i = j; continue;
      }

      if (ch === "\r" || ch === "\n") {
        if (this.palette.visible) this._paletteSelect();
        else this._submit();
        i++; continue;
      }

      if (ch === "\u007F" || ch === "\b") {
        this._backspace();
        if (this.inputBuffer.startsWith("/")) this._filterPalette(this.inputBuffer);
        else if (this.palette.visible) this._hidePalette();
        this._dirty.input = true;
        this._renderDirty();
        i++; continue;
      }

      if (ch === "\t") {
        if (this.palette.visible) this._paletteSelect();
        i++; continue;
      }

      if (ch >= " ") {
        this._insertChar(ch);
        if (this.inputBuffer.startsWith("/") && !this.inputBuffer.includes(" ")) {
          this._filterPalette(this.inputBuffer);
        } else if (this.palette.visible) {
          this._hidePalette();
        }
        this._dirty.input = true;
        this._renderDirty();
        i++; continue;
      }

      i++;
    }
  }

  _handleModalKey(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === "\x1B") {
        const seq = data.slice(i);
        if (seq.startsWith("\x1B[A")) { this.modalUp(); i += 3; continue; }
        if (seq.startsWith("\x1B[B")) { this.modalDown(); i += 3; continue; }
        // Escape
        this.modalCancel();
        return;
      }

      if (ch === "\r" || ch === "\n") { this.modalSelect(); i++; continue; }
      if (ch === "\t") { this.modalSelect(); i++; continue; }
      if (ch === "q") { this.modalCancel(); i++; continue; }

      // Skip unknown
      i++;
    }
  }

  _handleScrollKey(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === "\x1B") {
        const seq = data.slice(i);

        if (seq.startsWith("\x1B[A")) { this._scrollUp(1); i += 3; continue; }
        if (seq.startsWith("\x1B[B")) { this._scrollDown(1); i += 3; continue; }
        if (seq.startsWith("\x1B[5~")) { this._pageUp(); i += 4; continue; }
        if (seq.startsWith("\x1B[6~")) { this._pageDown(); i += 4; continue; }

        // Mouse events
        if (seq.startsWith("\x1B[<")) {
          const endM = seq.indexOf("M", 3);
          const endm = seq.indexOf("m", 3);
          const endIdx = endM !== -1 ? endM : endm;
          if (endIdx !== -1) {
            const parts = seq.slice(3, endIdx).split(";");
            const button = parseInt(parts[0], 10);
            if (endM !== -1) {
              if (button === 64) this._scrollUp(3);
              if (button === 65) this._scrollDown(3);
            }
            i += endIdx + 1; continue;
          }
        }

        // Escape alone — exit scroll mode
        this._exitScrollMode();
        return;
      }

      if (ch === "q") { this._exitScrollMode(); return; }
      if (ch === "j") { this._scrollDown(1); i++; continue; }
      if (ch === "k") { this._scrollUp(1); i++; continue; }
      if (ch === "g") { this._scrollToTop(); i++; continue; }
      if (ch === "G") { this._scrollToBottom(); i++; continue; }

      // Skip unknown characters
      i++;
    }
  }

  _handleResize() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.inputRow = this.height;
    this.statusRow = this.height - 1;
    this.contentHeight = this.statusRow - this.contentRowStart;
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (this.scrollOffset > this.maxScroll) this.scrollOffset = this.maxScroll;
    process.stdout.write(ansi.clearScreen);
    this._renderAll();
  }
}

module.exports = { Terminal, C, ansi, wrapText, DEFAULT_COMMANDS };

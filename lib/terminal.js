"use strict";

const chalk = require("chalk");

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
  mouseSGR:       `${CSI}?1006h`,
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
  purple: chalk.hex("#BD93F9"),
};

const VERSION = require("../package.json").version;

// ---------------------------------------------------------------------------
// Terminal TUI — alternate screen, scrollable, fixed input, mouse support
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
    this.inputPrefix = "  │ wordcheck › ";
    this.inputActive = false;

    // Scroll mode
    this.scrollMode = false;

    // Header lines
    this._headerLines = [];

    // Collapsible sections
    this._sections = new Map(); // id -> { title, collapsed, lines }
    this._sectionOrder = [];

    // Dirty tracking — only redraw what changed
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
  // Drawing — differential updates
  // -----------------------------------------------------------------------

  _drawAll() {
    this._drawHeader();
    this._drawContent();
    this._drawStatusBar();
    this._drawInput();
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
    const left = `  ● ${C.pink("wordcheck")}  ${C.dim("v" + VERSION)}`;
    const status = this._statusText || "ready";
    const right = C.dim(status + "  ");
    const leftV = left.replace(/\x1B\[[0-9;]*m/g, "");
    const rightV = right.replace(/\x1B\[[0-9;]*m/g, "");
    const gap = Math.max(1, w - leftV.length - rightV.length);
    process.stdout.write(left + " ".repeat(gap) + right);
    this._dirty.status = false;
  }

  _drawInput() {
    process.stdout.write(ansi.cursorTo(this.inputRow, 1) + ansi.eraseLine);
    if (this.inputActive) {
      // Draw prefix + buffer + cursor
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
        C.dim("  │ ") +
        C.dim(`${top}-${bottom}/${total}`) +
        C.dim("  ↑↓jk scroll") +
        C.dim("  q/Esc back") +
        C.dim("  g/G top/bottom")
      );
    } else {
      process.stdout.write(C.dim("  │ ") + C.dim("type a command or 'help'"));
    }
    this._dirty.input = false;
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
    if (this._dirty.header || lines.length > 0) this._drawHeader();
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
      this._drawInput();
      this._promptResolve = resolve;
    });
  }

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
    this._drawInput();
  }

  exitScrollMode() {
    this.scrollMode = false;
    this._drawContent();
    this._drawInput();
  }

  scrollUp(n = 3) {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
    this._drawContent();
    this._drawInput();
  }

  scrollDown(n = 3) {
    this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + n);
    this._drawContent();
    this._drawInput();
  }

  pageUp()   { this.scrollUp(this.contentHeight - 2); }
  pageDown() { this.scrollDown(this.contentHeight - 2); }
  scrollToTop()    { this.scrollOffset = 0; this._drawContent(); this._drawInput(); }
  scrollToBottom() { this.scrollOffset = this.maxScroll; this._drawContent(); this._drawInput(); }

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

    // Input mode — process each character
    if (this.inputActive) {
      this._processInputData(data);
    }
  }

  /**
   * Process input data — handles both single chars and pasted text.
   * Escape sequences start with \x1B and are 3+ chars.
   * Regular characters are 1 char each.
   * Pasted text arrives as multiple regular characters in one chunk.
   */
  _processInputData(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      // Escape sequence
      if (ch === "\x1B") {
        const seq = data.slice(i);
        if (seq.startsWith("\x1B[A")) {        // Up arrow
          if (this.contentLines.length > this.contentHeight) this.enterScrollMode();
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[B")) { i += 3; continue; }        // Down arrow
        if (seq.startsWith("\x1B[C")) {        // Right arrow
          if (this.inputCursorPos < this.inputBuffer.length) this.inputCursorPos++;
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[D")) {        // Left arrow
          if (this.inputCursorPos > 0) this.inputCursorPos--;
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[H")) { this.inputCursorPos = 0; i += 3; continue; }         // Home
        if (seq.startsWith("\x1B[F")) { this.inputCursorPos = this.inputBuffer.length; i += 3; continue; } // End
        if (seq.startsWith("\x1B[3~")) {       // Delete
          if (this.inputCursorPos < this.inputBuffer.length) {
            this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos) + this.inputBuffer.slice(this.inputCursorPos + 1);
          }
          i += 4; continue;
        }
        if (seq.startsWith("\x1B[5~")) { this.pageUp(); i += 4; continue; }   // Page Up
        if (seq.startsWith("\x1B[6~")) { this.pageDown(); i += 4; continue; }  // Page Down
        if (seq.startsWith("\x1B[<")) {        // Mouse event (SGR format)
          const end = seq.indexOf("M", 3);
          const endR = seq.indexOf("m", 3);
          const termIdx = end !== -1 ? end : endR;
          if (termIdx !== -1) {
            this._handleMouseEvent(seq.slice(3, termIdx), end !== -1 ? "press" : "release");
            i += termIdx + 1; continue;
          }
        }
        // Unknown escape — skip it
        i++; continue;
      }

      // Enter
      if (ch === "\r" || ch === "\n") {
        this._submitInput();
        i++; continue;
      }

      // Backspace
      if (ch === "\u007F" || ch === "\b") {
        if (this.inputCursorPos > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos - 1) + this.inputBuffer.slice(this.inputCursorPos);
          this.inputCursorPos--;
        }
        i++; continue;
      }

      // Tab
      if (ch === "\t") {
        // Auto-complete could go here
        i++; continue;
      }

      // Regular printable character
      if (ch >= " ") {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos) + ch + this.inputBuffer.slice(this.inputCursorPos);
        this.inputCursorPos++;
        i++; continue;
      }

      // Skip other control chars
      i++;
    }

    this._drawInput();
  }

  _handleScrollKey(data) {
    // Handle paste in scroll mode too — process char by char
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
    // SGR mouse: CSI < Cb ; Cx ; Cy M/m
    const parts = data.split(";");
    if (parts.length < 3) return;
    const button = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);

    // Scroll wheel
    if (type === "press") {
      if (button === 64) this.scrollUp(3);   // wheel up
      if (button === 65) this.scrollDown(3);  // wheel down
    }

    // Click on content area — could be used for collapsible sections
    if (type === "press" && (button === 0 || button === 32)) {
      if (y >= this.contentRowStart && y < this.contentRowStart + this.contentHeight) {
        this._handleContentClick(x, y - this.contentRowStart + this.scrollOffset);
      }
    }
  }

  _handleContentClick(x, lineIdx) {
    // Check if clicked line is a collapsible header
    if (lineIdx < this.contentLines.length) {
      const line = this.contentLines[lineIdx];
      // Look for section markers
      const sectionMatch = line.match(/▶\s*(.+)/) || line.match(/▼\s*(.+)/);
      if (sectionMatch) {
        this._toggleSection(sectionMatch[1]);
      }
    }
  }

  _toggleSection(title) {
    for (const [id, section] of this._sections) {
      if (section.title === title) {
        section.collapsed = !section.collapsed;
        this._rebuildContentFromSections();
        this._drawContent();
        return;
      }
    }
  }

  _rebuildContentFromSections() {
    this.contentLines = [];
    for (const id of this._sectionOrder) {
      const section = this._sections.get(id);
      if (!section) continue;
      const icon = section.collapsed ? "▶" : "▼";
      this.contentLines.push(`  ${C.pink(icon)} ${C.white.bold(section.title)}`);
      if (!section.collapsed) {
        this.contentLines.push(...section.lines);
      }
    }
    this.maxScroll = Math.max(0, this.contentLines.length - this.contentHeight);
    if (this.scrollOffset > this.maxScroll) this.scrollOffset = this.maxScroll;
  }

  // -----------------------------------------------------------------------
  // Collapsible sections API
  // -----------------------------------------------------------------------

  addSection(id, title, lines) {
    this._sections.set(id, { title, collapsed: false, lines });
    if (!this._sectionOrder.includes(id)) this._sectionOrder.push(id);
    this._rebuildContentFromSections();
    if (!this.scrollMode) this._drawContent();
  }

  collapseSection(id) {
    const s = this._sections.get(id);
    if (s) { s.collapsed = true; this._rebuildContentFromSections(); this._drawContent(); }
  }

  expandSection(id) {
    const s = this._sections.get(id);
    if (s) { s.collapsed = false; this._rebuildContentFromSections(); this._drawContent(); }
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

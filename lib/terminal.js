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
  eraseDisplay:   `${CSI}2J`,
  mouseEnable:    `${CSI}?1000h${CSI}?1002h${CSI}?1006h`,
  mouseDisable:   `${CSI}?1000l${CSI}?1002l${CSI}?1006l`,
};

const VERSION = require("../package.json").version;

function wrapText(text, maxWidth) {
  if (!text) return [""];
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

// ---------------------------------------------------------------------------
// ProviderModal — provider picker with search, hover, click
// ---------------------------------------------------------------------------
class ProviderModal {
  constructor() {
    this.visible    = false;
    this.title      = "";
    this.search     = "";
    this.sections   = [];
    this.allItems   = [];
    this.filtered   = [];
    this.hovered    = 0;
    this.activeId   = null;
    this.escHint    = "esc";
    this.onSelect   = null;
    this.onCancel   = null;
    this._itemRows  = [];
    this._startRow  = 0;
    this._modalW    = 0;
  }

  open({ title, sections, activeId, onSelect, onCancel, escHint = "esc" }) {
    this.visible   = true;
    this.title     = title;
    this.sections  = sections;
    this.search    = "";
    this.activeId  = activeId;
    this.escHint   = escHint;
    this.onSelect  = onSelect;
    this.onCancel  = onCancel;
    this._buildAll();
    this._applyFilter();
    const activeIdx = this.filtered.findIndex((r) => r.id === activeId);
    this.hovered = activeIdx >= 0 ? activeIdx : 0;
  }

  close() { this.visible = false; }

  _buildAll() {
    this.allItems = [];
    for (const section of this.sections) {
      if (section.label) this.allItems.push({ sectionSep: true, label: section.label });
      for (const item of section.items) this.allItems.push({ ...item, sectionSep: false });
    }
  }

  _applyFilter() {
    const q = this.search.toLowerCase().trim();
    if (!q) {
      this.filtered = this.allItems.slice();
    } else {
      const result = [];
      for (const section of this.sections) {
        const matched = section.items.filter(
          (it) => it.label.toLowerCase().includes(q) || (it.desc || "").toLowerCase().includes(q)
        );
        if (matched.length > 0) {
          if (section.label) result.push({ sectionSep: true, label: section.label });
          for (const it of matched) result.push({ ...it, sectionSep: false });
        }
      }
      this.filtered = result;
    }
    const itemCount = this.filtered.filter((r) => !r.sectionSep).length;
    if (this.hovered >= itemCount) this.hovered = Math.max(0, itemCount - 1);
  }

  searchAppend(ch) { this.search += ch; this._applyFilter(); this.hovered = 0; }
  searchBackspace() { if (this.search.length > 0) { this.search = this.search.slice(0, -1); this._applyFilter(); } }

  up() {
    const items = this.filtered.map((r, i) => ({ r, i })).filter((x) => !x.r.sectionSep);
    const cur = items.findIndex((x) => this._itemHoverIdx(x.i) === this.hovered);
    if (cur > 0) this.hovered = this._itemHoverIdx(items[cur - 1].i);
  }

  down() {
    const items = this.filtered.map((r, i) => ({ r, i })).filter((x) => !x.r.sectionSep);
    const cur = items.findIndex((x) => this._itemHoverIdx(x.i) === this.hovered);
    if (cur < items.length - 1) this.hovered = this._itemHoverIdx(items[cur + 1].i);
  }

  _itemHoverIdx(filteredIdx) {
    let count = 0;
    for (let i = 0; i < filteredIdx; i++) {
      if (!this.filtered[i].sectionSep) count++;
    }
    return count;
  }

  selectHovered() {
    const items = this.filtered.filter((r) => !r.sectionSep);
    const item = items[this.hovered];
    if (item && this.onSelect) this.onSelect(item.id, item);
  }

  clickRow(termRow) {
    const hit = this._itemRows.find((r) => r.row === termRow);
    if (!hit) return false;
    this.hovered = hit.itemIdx;
    if (this.onSelect) {
      const items = this.filtered.filter((r) => !r.sectionSep);
      const item = items[hit.itemIdx];
      if (item) this.onSelect(item.id, item);
    }
    return true;
  }

  hoverRow(termRow) {
    const hit = this._itemRows.find((r) => r.row === termRow);
    if (!hit) return false;
    this.hovered = hit.itemIdx;
    return true;
  }
}

// ---------------------------------------------------------------------------
// ModelModal — model picker with search, hover, click, Ctrl+A for provider
// ---------------------------------------------------------------------------
class ModelModal {
  constructor() {
    this.visible      = false;
    this.search       = "";
    this.models       = []; // [{ id, desc }]
    this.filtered     = [];
    this.hovered      = 0;
    this.activeModel  = "";
    this.providerLabel = "";
    this.onSelect     = null;
    this.onCancel     = null;
    this.onProvider   = null; // Ctrl+A callback
    this._itemRows    = [];
    this._startRow    = 0;
    this._modalW      = 0;
    this.loading      = false;
  }

  open({ models, activeModel, providerLabel, onSelect, onCancel, onProvider }) {
    this.visible      = true;
    this.search       = "";
    this.models       = models || [];
    this.activeModel  = activeModel || "";
    this.providerLabel = providerLabel || "";
    this.onSelect     = onSelect;
    this.onCancel     = onCancel;
    this.onProvider   = onProvider;
    this._applyFilter();
    const idx = this.filtered.findIndex((m) => m.id === this.activeModel);
    this.hovered = idx >= 0 ? idx : 0;
  }

  close() { this.visible = false; }

  setLoading(loading) { this.loading = loading; }
  setModels(models) { this.models = models; this._applyFilter(); }

  _applyFilter() {
    const q = this.search.toLowerCase().trim();
    if (!q) {
      this.filtered = this.models.slice();
    } else {
      this.filtered = this.models.filter(
        (m) => m.id.toLowerCase().includes(q) || (m.desc || "").toLowerCase().includes(q)
      );
    }
    if (this.hovered >= this.filtered.length) this.hovered = Math.max(0, this.filtered.length - 1);
  }

  searchAppend(ch) { this.search += ch; this._applyFilter(); this.hovered = 0; }
  searchBackspace() { if (this.search.length > 0) { this.search = this.search.slice(0, -1); this._applyFilter(); } }
  up()   { if (this.hovered > 0) this.hovered--; }
  down() { if (this.hovered < this.filtered.length - 1) this.hovered++; }

  selectHovered() {
    const item = this.filtered[this.hovered];
    if (item && this.onSelect) this.onSelect(item.id, item);
  }

  clickRow(termRow) {
    const hit = this._itemRows.find((r) => r.row === termRow);
    if (!hit) return false;
    this.hovered = hit.itemIdx;
    if (this.onSelect) {
      const item = this.filtered[hit.itemIdx];
      if (item) this.onSelect(item.id, item);
    }
    return true;
  }

  hoverRow(termRow) {
    const hit = this._itemRows.find((r) => r.row === termRow);
    if (!hit) return false;
    this.hovered = hit.itemIdx;
    return true;
  }
}

// ---------------------------------------------------------------------------
// SettingsModal — inline editable fields panel
// ---------------------------------------------------------------------------
class SettingsModal {
  constructor() {
    this.visible    = false;
    this.fields     = [];
    this.hovered    = 0;
    this.editing    = -1;
    this.editBuffer = "";
    this.onSave     = null;
    this.onCancel   = null;
    this.onOpenProvider = null;
    this._fieldRows = [];
    this._startRow  = 0;
    this._modalW    = 0;
  }

  open({ fields, onSave, onCancel, onOpenProvider }) {
    this.visible    = true;
    this.fields     = fields;
    this.hovered    = 0;
    this.editing    = -1;
    this.editBuffer = "";
    this.onSave     = onSave;
    this.onCancel   = onCancel;
    this.onOpenProvider = onOpenProvider;
  }

  close() { this.visible = false; this.editing = -1; }

  startEdit(idx) { this.editing = idx; this.editBuffer = this.fields[idx].raw || ""; }

  commitEdit() {
    if (this.editing >= 0 && this.onSave) {
      this.onSave(this.fields[this.editing].key, this.editBuffer);
      this.fields[this.editing].value = this.editBuffer;
      this.fields[this.editing].raw   = this.editBuffer;
    }
    this.editing = -1;
    this.editBuffer = "";
  }

  cancelEdit() { this.editing = -1; this.editBuffer = ""; }

  clickRow(termRow) {
    const hit = this._fieldRows.find((r) => r.row === termRow);
    if (!hit) return false;
    this.hovered = hit.fieldIdx;
    if (hit.fieldIdx === 0 && this.onOpenProvider) {
      this.onOpenProvider();
    } else {
      this.startEdit(hit.fieldIdx);
    }
    return true;
  }

  hoverRow(termRow) {
    const hit = this._fieldRows.find((r) => r.row === termRow);
    if (!hit) return false;
    this.hovered = hit.fieldIdx;
    return true;
  }

  up()   { if (this.hovered > 0) this.hovered--; }
  down() { if (this.hovered < this.fields.length - 1) this.hovered++; }

  appendChar(ch)  { if (this.editing >= 0) this.editBuffer += ch; }
  backspace()     { if (this.editing >= 0 && this.editBuffer.length > 0) this.editBuffer = this.editBuffer.slice(0, -1); }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
class Terminal {
  constructor() {
    this.width  = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.headerRowCount = 10;

    this.headerRowStart  = 1;
    this.contentRowStart = this.headerRowCount + 1;
    this.inputRow        = this.height;
    this.statusRow       = this.height - 1;
    this.contentHeight   = this.statusRow - this.contentRowStart;

    this.contentLines   = [];
    this.scrollOffset   = 0;
    this.maxScroll      = 0;
    this.inputBuffer    = "";
    this.inputCursorPos = 0;
    this.inputPrefix    = "  \u2502 wordcheck \u203a ";
    this.inputActive    = false;
    this.scrollMode     = false;
    this.headerLines    = [];
    this.statusText     = "ready";

    this.palette = {
      visible: false, selected: 0, filtered: [], commands: DEFAULT_COMMANDS,
    };

    this.providerModal = new ProviderModal();
    this.modelModal    = new ModelModal();
    this.settingsModal = new SettingsModal();

    this.modal = {
      visible: false, title: "", lines: [], selected: 0, onSelect: null, onCancel: null,
    };

    this._dirty = {
      header: true, content: true, status: true, input: true,
      palette: true, modal: true, providerModal: true, settingsModal: true, modelModal: true,
    };

    this._buf = [];
    this._flushScheduled = false;
    this._onKeypress = null;
    this._onResize   = null;
    this._promptResolve = null;
  }

  _write(str) { this._buf.push(str); }
  _flush() {
    if (this._buf.length > 0) { process.stdout.write(this._buf.join("")); this._buf = []; }
    this._flushScheduled = false;
  }

  open() {
    process.stdout.write(ansi.altScreenOn + ansi.cursorHide + ansi.clearScreen + ansi.mouseEnable);
    this._renderAll();
    this._enableInput();
  }

  close() {
    this._disableInput();
    process.stdout.write(ansi.cursorShow + ansi.mouseDisable + ansi.altScreenOff);
  }

  // --- Public API ---
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
    if (!this._anyModalOpen()) {
      this._dirty.content = true;
      this._dirty.palette = true;
      this._renderDirty();
    }
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
    if (!this._anyModalOpen()) {
      this._dirty.content = true;
      this._dirty.palette = true;
      this._renderDirty();
    }
  }

  clearContent() {
    this.contentLines = [];
    this.scrollOffset = 0;
    this.maxScroll    = 0;
    this._dirty.content = true;
    this._renderDirty();
  }

  setHeader(lines) { this.headerLines = lines; this._dirty.header = true; this._renderDirty(); }
  setStatus(text)  { this.statusText = text; this._dirty.status = true; this._renderDirty(); }

  async prompt() {
    return new Promise((resolve) => {
      this.inputActive    = true;
      this.inputBuffer    = "";
      this.inputCursorPos = 0;
      this.scrollMode     = false;
      this._promptResolve = resolve;
      this._dirty.input   = true;
      this._renderDirty();
    });
  }

  cancelPrompt() {
    if (this._promptResolve) { this._promptResolve(null); this._promptResolve = null; }
    this.inputActive     = false;
    this.palette.visible = false;
  }

  _anyModalOpen() {
    return this.providerModal.visible || this.modelModal.visible ||
           this.settingsModal.visible || this.modal.visible;
  }

  // --- Render pipeline ---
  _renderAll() {
    Object.keys(this._dirty).forEach((k) => (this._dirty[k] = true));
    this._renderDirty();
  }

  _renderDirty() {
    if (this._dirty.header)        { this._drawHeader();        this._dirty.header        = false; }
    if (this._dirty.content)       { this._drawContent();       this._dirty.content       = false; }
    if (this._dirty.status)        { this._drawStatus();        this._dirty.status        = false; }
    if (this._dirty.palette)       { this._drawPalette();       this._dirty.palette       = false; }
    if (this._dirty.modal)         { this._drawModal();         this._dirty.modal         = false; }
    if (this._dirty.providerModal) { this._drawProviderModal(); this._dirty.providerModal = false; }
    if (this._dirty.modelModal)    { this._drawModelModal();    this._dirty.modelModal    = false; }
    if (this._dirty.settingsModal) { this._drawSettingsModal(); this._dirty.settingsModal = false; }
    if (this._dirty.input)         { this._drawInput();         this._dirty.input         = false; }
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
    const usePalette  = this.palette.visible && !this.scrollMode;
    const paletteRows = usePalette ? Math.min(this.palette.filtered.length, 8) + 2 : 0;
    const visibleRows = this.contentHeight - paletteRows;
    const visible     = this.contentLines.slice(this.scrollOffset, this.scrollOffset + visibleRows);

    for (let i = 0; i < visibleRows; i++) {
      const row = this.contentRowStart + i;
      this._write(ansi.cursorTo(row, 1) + ansi.eraseLine);
      if (i < visible.length) this._write(visible[i]);
    }
  }

  _drawStatus() {
    this._write(ansi.cursorTo(this.statusRow, 1) + ansi.eraseLine);
    const left  = `  \u25CF ${C.pink("wordcheck")}  ${C.dim("v" + VERSION)}`;
    const right = C.dim(this.statusText + "  ");
    const leftV  = left.replace(/\x1B\[[0-9;]*m/g, "");
    const rightV = right.replace(/\x1B\[[0-9;]*m/g, "");
    const gap = Math.max(1, this.width - leftV.length - rightV.length);
    this._write(left + " ".repeat(gap) + right);
  }

  _drawInput() {
    this._write(ansi.cursorTo(this.inputRow, 1) + ansi.eraseLine);

    if (this.settingsModal.visible && this.settingsModal.editing >= 0) {
      const f = this.settingsModal.fields[this.settingsModal.editing];
      const buf = this.settingsModal.editBuffer;
      this._write(
        C.bar("  \u2502 ") + C.pink.bold(f.label) + C.dim(" \u203A ") +
        C.white(buf) + chalk.inverse(" ")
      );
    } else if (this.inputActive) {
      const before = this.inputBuffer.slice(0, this.inputCursorPos);
      const after  = this.inputBuffer.slice(this.inputCursorPos);
      this._write(
        this.inputPrefix +
        before +
        chalk.inverse(after[0] || " ") +
        (after.length > 1 ? after.slice(1) : "")
      );
    } else if (this.scrollMode) {
      const total  = this.contentLines.length;
      const top    = this.scrollOffset + 1;
      const bottom = Math.min(this.scrollOffset + this.contentHeight, total);
      this._write(C.dim("  \u2502 ") + C.dim(`${top}-${bottom}/${total}`) + C.dim("  \u2191\u2193jk scroll  q/Esc back  g/G top/bottom"));
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

    this._write(ansi.cursorTo(paletteStart, 1) + ansi.eraseLine);
    this._write(C.dim("  \u256D") + C.dim("\u2500".repeat(w)) + C.dim("\u256E"));

    for (let i = 0; i < count; i++) {
      const row = paletteStart + 1 + i;
      this._write(ansi.cursorTo(row, 1) + ansi.eraseLine);
      const cmd = this.palette.filtered[i];
      if (!cmd) continue;
      const sel     = i === this.palette.selected;
      const cmdText = cmd.cmd.padEnd(16);
      const desc    = cmd.desc.length > descWidth ? cmd.desc.slice(0, descWidth - 1) + "\u2026" : cmd.desc.padEnd(descWidth);
      this._write(
        (sel ? C.pink("  \u2502 \u25B6 ") : C.dim("  \u2502   ")) +
        (sel ? C.white.bold(cmdText) : C.dim(cmdText)) +
        C.dim(desc)
      );
    }

    this._write(ansi.cursorTo(paletteStart + count + 1, 1) + ansi.eraseLine);
    this._write(C.dim("  \u2570") + C.dim("\u2500".repeat(w)) + C.dim("\u256F"));
  }

  // -----------------------------------------------------------------------
  // Clear content area behind modal (solid dark bg)
  // -----------------------------------------------------------------------
  _clearModalBg() {
    const bg = chalk.bgHex("#1e1e2e");
    for (let i = 0; i < this.contentHeight; i++) {
      this._write(ansi.cursorTo(this.contentRowStart + i, 1) + ansi.eraseLine + bg(" ".repeat(this.width)));
    }
  }

  // -----------------------------------------------------------------------
  // Provider modal
  // -----------------------------------------------------------------------
  openProviderModal(opts) {
    this.providerModal.open(opts);
    this._dirty.providerModal = true;
    this._dirty.content = true;
    this._dirty.input   = true;
    this._renderDirty();
  }

  closeProviderModal() {
    this.providerModal.close();
    this._dirty.providerModal = true;
    this._dirty.content       = true;
    this._dirty.input         = true;
    this._renderDirty();
  }

  _drawProviderModal() {
    const pm = this.providerModal;
    if (!pm.visible) return;

    this._clearModalBg();

    const w        = Math.min(this.width - 4, 66);
    const startCol = Math.max(1, Math.floor((this.width - w) / 2));
    const startRow = this.contentRowStart;
    const maxItems = this.contentHeight - 6;

    pm._itemRows = [];
    pm._startRow = startRow;
    pm._modalW   = w;

    let row = startRow;

    // Title
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    const titlePad = w - 2 - pm.title.length - pm.escHint.length;
    this._write(
      chalk.bgHex("#1e1e2e")(
        " " + C.white.bold(pm.title) + " ".repeat(Math.max(1, titlePad)) + C.dim(pm.escHint) + " "
      )
    );
    row++;

    // Search bar
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    const searchDisplay = pm.search ? C.white(pm.search) : C.dim("Search");
    this._write(
      chalk.bgHex("#1e1e2e")(" " + C.cyan("S") + C.dim("earch") + C.dim(" ") + searchDisplay + " ".repeat(Math.max(0, w - 8 - pm.search.length)) + " ")
    );
    row++;

    // Separator
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    this._write(chalk.bgHex("#1e1e2e")(" " + C.dim("\u2500".repeat(w - 2)) + " "));
    row++;

    // Items
    let itemIdx = 0;
    let rendered = 0;
    for (const entry of pm.filtered) {
      if (rendered >= maxItems) break;
      this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);

      if (entry.sectionSep) {
        this._write(
          chalk.bgHex("#1e1e2e")(" " + C.pink.bold(entry.label) + " ".repeat(Math.max(0, w - 2 - entry.label.length)) + " ")
        );
      } else {
        const isHovered = itemIdx === pm.hovered;
        const isActive  = entry.id === pm.activeId;
        const check     = isActive ? C.green("\u2713 ") : "  ";
        const labelStr  = entry.label || "";
        const badgeStr  = entry.badge ? C.dim(" " + entry.badge) : "";
        const descStr   = entry.desc  ? C.dim("  " + entry.desc)  : "";
        const labelVisible = (isActive ? "  " : "  ") + labelStr + (entry.badge ? " " + entry.badge : "") + (entry.desc ? "  " + entry.desc : "");
        const pad = Math.max(0, w - 2 - labelVisible.length);
        const bg = isHovered ? chalk.bgHex("#313244") : chalk.bgHex("#1e1e2e");

        this._write(
          bg(
            " " + check +
            (isHovered ? C.white.bold(labelStr) : C.white(labelStr)) +
            badgeStr + descStr +
            " ".repeat(pad) + " "
          )
        );
        pm._itemRows.push({ row, itemIdx });
        itemIdx++;
      }
      row++;
      rendered++;
    }

    // Footer
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    this._write(
      chalk.bgHex("#1e1e2e")(
        " " + C.dim("\u2191\u2193 navigate  Enter select  type to search  Esc cancel") +
        " ".repeat(Math.max(0, w - 51)) + " "
      )
    );
  }

  // -----------------------------------------------------------------------
  // Model modal
  // -----------------------------------------------------------------------
  openModelModal(opts) {
    this.modelModal.open(opts);
    this._dirty.modelModal = true;
    this._dirty.content    = true;
    this._dirty.input      = true;
    this._renderDirty();
  }

  closeModelModal() {
    this.modelModal.close();
    this._dirty.modelModal = true;
    this._dirty.content    = true;
    this._dirty.input      = true;
    this._renderDirty();
  }

  markModelDirty() {
    this._dirty.modelModal = true;
    this._dirty.input      = true;
    this._renderDirty();
  }

  _drawModelModal() {
    const mm = this.modelModal;
    if (!mm.visible) return;

    this._clearModalBg();

    const w        = Math.min(this.width - 4, 66);
    const startCol = Math.max(1, Math.floor((this.width - w) / 2));
    const startRow = this.contentRowStart;
    const maxItems = this.contentHeight - 7;

    mm._itemRows = [];
    mm._startRow = startRow;
    mm._modalW   = w;

    let row = startRow;

    // Title bar with provider badge
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    const titleStr = "MODEL";
    const providerStr = mm.providerLabel ? "  " + C.dim(mm.providerLabel) : "";
    const escStr = "esc";
    const titleVisible = titleStr + providerStr;
    const titlePad = w - 2 - titleStr.length - mm.providerLabel.length - 2 - escStr.length;
    this._write(
      chalk.bgHex("#1e1e2e")(
        " " + C.white.bold(titleStr) + C.dim("  " + mm.providerLabel) +
        " ".repeat(Math.max(1, titlePad)) + C.dim(escStr) + " "
      )
    );
    row++;

    // Search
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    const searchDisplay = mm.search ? C.white(mm.search) : C.dim("Search models...");
    this._write(
      chalk.bgHex("#1e1e2e")(" " + C.cyan("S") + C.dim("earch") + C.dim(" ") + searchDisplay + " ".repeat(Math.max(0, w - 8 - mm.search.length)) + " ")
    );
    row++;

    // Separator
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    this._write(chalk.bgHex("#1e1e2e")(" " + C.dim("\u2500".repeat(w - 2)) + " "));
    row++;

    // Loading state
    if (mm.loading && mm.filtered.length === 0) {
      this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
      this._write(chalk.bgHex("#1e1e2e")(" " + C.dim("  Loading models...") + " ".repeat(w - 22) + " "));
      row++;
    }

    // Models
    let itemIdx = 0;
    let rendered = 0;
    for (const model of mm.filtered) {
      if (rendered >= maxItems) break;
      this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);

      const isHovered = itemIdx === mm.hovered;
      const isActive  = model.id === mm.activeModel;
      const check     = isActive ? C.green("\u2713 ") : "  ";
      const labelStr  = model.id;
      const descStr   = model.desc ? C.dim("  " + model.desc) : "";
      const pad = Math.max(0, w - 2 - (isActive ? "  " : "  ") - labelStr.length - (model.desc ? model.desc.length + 2 : 0));
      const bg = isHovered ? chalk.bgHex("#313244") : chalk.bgHex("#1e1e2e");

      this._write(
        bg(
          " " + check +
          (isHovered ? C.white.bold(labelStr) : C.white(labelStr)) +
          descStr +
          " ".repeat(pad) + " "
        )
      );
      mm._itemRows.push({ row, itemIdx });
      itemIdx++;
      row++;
      rendered++;
    }

    // Show count if models exist
    if (mm.models.length > 0) {
      this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
      this._write(chalk.bgHex("#1e1e2e")(" " + C.dim(`  ${mm.filtered.length}/${mm.models.length} models`) + " ".repeat(Math.max(0, w - 4 - String(mm.models.length).length * 2)) + " "));
      row++;
    }

    // Footer
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    this._write(
      chalk.bgHex("#1e1e2e")(
        " " + C.dim("\u2191\u2193 select  Enter pick  Ctrl+A providers  type search  Esc cancel") +
        " ".repeat(Math.max(0, w - 58)) + " "
      )
    );
  }

  // -----------------------------------------------------------------------
  // Settings modal
  // -----------------------------------------------------------------------
  openSettingsModal(opts) {
    this.settingsModal.open(opts);
    this._dirty.settingsModal = true;
    this._dirty.content       = true;
    this._dirty.input         = true;
    this._renderDirty();
  }

  closeSettingsModal() {
    this.settingsModal.close();
    this._dirty.settingsModal = true;
    this._dirty.content       = true;
    this._dirty.input         = true;
    this._renderDirty();
  }

  markSettingsDirty() {
    this._dirty.settingsModal = true;
    this._dirty.input         = true;
    this._renderDirty();
  }

  _drawSettingsModal() {
    const sm = this.settingsModal;
    if (!sm.visible) return;

    this._clearModalBg();

    const w        = Math.min(this.width - 4, 66);
    const startCol = Math.max(1, Math.floor((this.width - w) / 2));
    const startRow = this.contentRowStart;

    sm._fieldRows = [];
    sm._startRow  = startRow;
    sm._modalW    = w;

    let row = startRow;

    // Title bar
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    const titlePad = w - 2 - "SETTINGS".length - "esc".length;
    this._write(
      chalk.bgHex("#1e1e2e")(
        " " + C.pink.bold("SETTINGS") + " ".repeat(Math.max(1, titlePad)) + C.dim("esc") + " "
      )
    );
    row++;

    // Separator
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    this._write(chalk.bgHex("#1e1e2e")(" " + C.dim("\u2500".repeat(w - 2)) + " "));
    row++;

    // Fields
    for (let i = 0; i < sm.fields.length; i++) {
      const f         = sm.fields[i];
      const isHovered = i === sm.hovered;
      const isEditing = i === sm.editing;

      this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);

      const label = f.label.padEnd(14);
      let   val   = f.masked ? (f.raw ? "*".repeat(Math.min(f.raw.length, 16)) + "..." : C.dim("(not set)")) : f.value;
      if (isEditing) {
        val = C.white(sm.editBuffer) + chalk.inverse(" ");
      }

      const bg = isHovered ? chalk.bgHex("#313244") : chalk.bgHex("#1e1e2e");
      const labelRendered = isHovered ? C.white.bold(label) : C.dim(label);
      const numStr = C.cyan(String(i + 1) + ". ");

      this._write(bg(" " + numStr + labelRendered + val + " "));
      sm._fieldRows.push({ row, fieldIdx: i });
      row++;
    }

    // Separator
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    this._write(chalk.bgHex("#1e1e2e")(" " + C.dim("\u2500".repeat(w - 2)) + " "));
    row++;

    // Footer hints
    this._write(ansi.cursorTo(row, startCol) + ansi.eraseLine);
    const hint = sm.editing >= 0
      ? C.dim("Enter to save  Esc to cancel edit")
      : C.dim("click or \u2191\u2193/number to edit  Esc to close");
    this._write(chalk.bgHex("#1e1e2e")(" " + hint + " ".repeat(Math.max(0, w - 2 - 40)) + " "));
  }

  // -----------------------------------------------------------------------
  // Legacy modal
  // -----------------------------------------------------------------------
  showModal(title, lines, selected, onSelect, onCancel) {
    this.modal = { visible: true, title, lines, selected, onSelect, onCancel };
    this._dirty.modal = true;
    this._dirty.input = true;
    this._renderDirty();
  }

  hideModal() {
    this.modal.visible = false;
    this._dirty.modal = true; this._dirty.content = true; this._dirty.input = true;
    this._renderDirty();
  }

  _drawModal() {
    if (!this.modal.visible) return;
    const m = this.modal;

    this._clearModalBg();

    const maxVisible = Math.min(m.lines.length, this.contentHeight - 4);
    const w          = Math.min(this.width - 6, 64);
    const modalHeight = maxVisible + 4;
    const startRow   = this.contentRowStart + Math.max(0, Math.floor((this.contentHeight - modalHeight) / 2));
    const startCol   = Math.max(1, Math.floor((this.width - w) / 2));

    this._write(ansi.cursorTo(startRow, startCol) + ansi.eraseLine);
    this._write(chalk.bgHex("#1e1e2e")(" " + C.pink.bold(m.title) + " ".repeat(Math.max(0, w - 2 - m.title.length)) + " "));

    this._write(ansi.cursorTo(startRow + 1, startCol) + ansi.eraseLine);
    this._write(chalk.bgHex("#1e1e2e")(" " + C.dim("\u2500".repeat(w - 2)) + " "));

    for (let i = 0; i < maxVisible; i++) {
      const r = startRow + 2 + i;
      this._write(ansi.cursorTo(r, startCol) + ansi.eraseLine);
      const item = m.lines[i];
      if (!item) continue;
      const sel = i === m.selected;
      const bg  = sel ? chalk.bgHex("#313244") : chalk.bgHex("#1e1e2e");
      this._write(
        bg(" " + (sel ? C.pink("\u25B6 ") : "  ") + (sel ? C.white.bold(item) : C.dim(item)) + " ")
      );
    }

    const bottomRow = startRow + 2 + maxVisible;
    this._write(ansi.cursorTo(bottomRow, startCol) + ansi.eraseLine);
    this._write(chalk.bgHex("#1e1e2e")(" " + C.dim("\u2500".repeat(w - 2)) + " "));

    const hintRow = bottomRow + 1;
    if (hintRow <= this.statusRow - 2) {
      this._write(ansi.cursorTo(hintRow, startCol) + ansi.eraseLine);
      this._write(chalk.bgHex("#1e1e2e")(" " + C.dim("\u2191\u2193 navigate  Enter select  Esc cancel") + " "));
    }
  }

  modalUp()     { if (this.modal.selected > 0) { this.modal.selected--; this._dirty.modal = true; this._renderDirty(); } }
  modalDown()   { if (this.modal.selected < this.modal.lines.length - 1) { this.modal.selected++; this._dirty.modal = true; this._renderDirty(); } }
  modalSelect() {
    if (this.modal.visible && this.modal.onSelect) {
      const idx = this.modal.selected;
      this.modal.visible = false;
      this._dirty.modal = true; this._dirty.content = true; this._dirty.input = true;
      this._renderDirty();
      this.modal.onSelect(idx);
    }
  }
  modalCancel() {
    if (this.modal.visible && this.modal.onCancel) {
      this.modal.visible = false;
      this._dirty.modal = true; this._dirty.content = true; this._dirty.input = true;
      this._renderDirty();
      this.modal.onCancel();
    }
  }

  // -----------------------------------------------------------------------
  // Input dispatch
  // -----------------------------------------------------------------------
  _submit() {
    const input = this.inputBuffer;
    this.inputActive     = false;
    this.palette.visible = false;
    this._dirty.content  = true;
    this._dirty.input    = true;
    this._renderDirty();
    if (this._promptResolve) {
      const resolve       = this._promptResolve;
      this._promptResolve = null;
      resolve(input);
    }
  }

  _insertChar(ch)  { this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos) + ch + this.inputBuffer.slice(this.inputCursorPos); this.inputCursorPos++; }
  _backspace()     { if (this.inputCursorPos > 0) { this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos - 1) + this.inputBuffer.slice(this.inputCursorPos); this.inputCursorPos--; } }
  _cursorLeft()    { if (this.inputCursorPos > 0) this.inputCursorPos--; }
  _cursorRight()   { if (this.inputCursorPos < this.inputBuffer.length) this.inputCursorPos++; }
  _cursorHome()    { this.inputCursorPos = 0; }
  _cursorEnd()     { this.inputCursorPos = this.inputBuffer.length; }
  _delete()        { if (this.inputCursorPos < this.inputBuffer.length) this.inputBuffer = this.inputBuffer.slice(0, this.inputCursorPos) + this.inputBuffer.slice(this.inputCursorPos + 1); }
  _scrollUp(n=3)   { this.scrollOffset = Math.max(0, this.scrollOffset - n); this._dirty.content = true; this._dirty.input = true; this._renderDirty(); }
  _scrollDown(n=3) { this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + n); this._dirty.content = true; this._dirty.input = true; this._renderDirty(); }
  _pageUp()        { this._scrollUp(this.contentHeight - 2); }
  _pageDown()      { this._scrollDown(this.contentHeight - 2); }
  _scrollToTop()   { this.scrollOffset = 0; this._dirty.content = true; this._dirty.input = true; this._renderDirty(); }
  _scrollToBottom(){ this.scrollOffset = this.maxScroll; this._dirty.content = true; this._dirty.input = true; this._renderDirty(); }
  _enterScrollMode(){ this.scrollMode = true; this.palette.visible = false; this._dirty.content = true; this._dirty.palette = true; this._dirty.input = true; this._renderDirty(); }
  _exitScrollMode() { this.scrollMode = false; this._dirty.content = true; this._dirty.input = true; this._renderDirty(); }

  _showPalette()  { this.palette.filtered = this.palette.commands; this.palette.selected = 0; this.palette.visible = true; this._dirty.content = true; this._dirty.palette = true; this._dirty.input = true; this._renderDirty(); }
  _hidePalette()  { this.palette.visible = false; this._dirty.content = true; this._dirty.palette = true; this._dirty.input = true; this._renderDirty(); }
  _filterPalette(query) {
    const q = query.toLowerCase();
    this.palette.filtered = this.palette.commands.filter((c) => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
    if (this.palette.selected >= this.palette.filtered.length) this.palette.selected = Math.max(0, this.palette.filtered.length - 1);
    this.palette.visible = this.palette.filtered.length > 0;
    this._dirty.content = true; this._dirty.palette = true; this._dirty.input = true;
    this._renderDirty();
  }
  _paletteUp()     { if (this.palette.selected > 0) { this.palette.selected--; this._dirty.palette = true; this._renderDirty(); } }
  _paletteDown()   { if (this.palette.selected < this.palette.filtered.length - 1) { this.palette.selected++; this._dirty.palette = true; this._renderDirty(); } }
  _paletteSelect() {
    if (this.palette.filtered.length > 0) {
      const selected = this.palette.filtered[this.palette.selected];
      if (selected) {
        this.inputBuffer    = selected.cmd + " ";
        this.inputCursorPos = this.inputBuffer.length;
        this.palette.visible = false;
        this._dirty.content = true; this._dirty.palette = true; this._dirty.input = true;
        this._renderDirty();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Input handler
  // -----------------------------------------------------------------------
  _enableInput() {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    this._onResize   = () => this._handleResize();
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

    // Modal priority: provider > model > settings > legacy
    if (this.providerModal.visible) { this._handleProviderModalKey(data); return; }
    if (this.modelModal.visible)    { this._handleModelModalKey(data);    return; }
    if (this.settingsModal.visible) { this._handleSettingsModalKey(data); return; }
    if (this.modal.visible)         { this._handleModalKey(data);         return; }

    if (this.scrollMode) { this._handleScrollKey(data); return; }
    if (this.inputActive) { this._processInput(data); }
  }

  // --- Parse mouse SGR from escape sequence, return { button, col, row, pressed } or null ---
  _parseMouse(seq) {
    const endM   = seq.indexOf("M", 3);
    const endm   = seq.indexOf("m", 3);
    const endIdx = endM !== -1 ? (endm !== -1 ? Math.min(endM, endm) : endM) : endm;
    if (endIdx === -1) return null;
    const parts  = seq.slice(3, endIdx).split(";");
    return {
      button:  parseInt(parts[0], 10),
      col:     parseInt(parts[1], 10),
      row:     parseInt(parts[2], 10),
      pressed: seq[endIdx] === "M",
    };
  }

  _handleProviderModalKey(data) {
    const pm = this.providerModal;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === "\x1B") {
        const seq = data.slice(i);
        if (seq.startsWith("\x1B[A")) { pm.up(); this._dirty.providerModal = true; this._renderDirty(); i += 3; continue; }
        if (seq.startsWith("\x1B[B")) { pm.down(); this._dirty.providerModal = true; this._renderDirty(); i += 3; continue; }

        if (seq.startsWith("\x1B[<")) {
          const m = this._parseMouse(seq);
          if (m) {
            if (m.pressed && m.button === 32) {
              if (pm.clickRow(m.row)) { this._dirty.providerModal = true; this._dirty.input = true; this._renderDirty(); }
            } else if (!m.pressed || m.button >= 32) {
              if (pm.hoverRow(m.row)) { this._dirty.providerModal = true; this._renderDirty(); }
            }
            if (m.button === 64) this._scrollUp(3);
            if (m.button === 65) this._scrollDown(3);
            i += seq.indexOf("M", 3) !== -1 ? seq.indexOf("M", 3) + 1 : seq.indexOf("m", 3) + 1;
            continue;
          }
        }

        if (pm.onCancel) pm.onCancel();
        this.closeProviderModal();
        return;
      }

      if (ch === "\r" || ch === "\n") { pm.selectHovered(); i++; continue; }
      if (ch === "\u007F" || ch === "\b") { pm.searchBackspace(); this._dirty.providerModal = true; this._renderDirty(); i++; continue; }
      if (ch >= " ") { pm.searchAppend(ch); this._dirty.providerModal = true; this._renderDirty(); i++; continue; }
      i++;
    }
  }

  _handleModelModalKey(data) {
    const mm = this.modelModal;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === "\x1B") {
        const seq = data.slice(i);
        if (seq.startsWith("\x1B[A")) { mm.up(); this._dirty.modelModal = true; this._renderDirty(); i += 3; continue; }
        if (seq.startsWith("\x1B[B")) { mm.down(); this._dirty.modelModal = true; this._renderDirty(); i += 3; continue; }

        // Ctrl+A = \x01 — open provider picker
        // (handled below as non-escape char)

        if (seq.startsWith("\x1B[<")) {
          const m = this._parseMouse(seq);
          if (m) {
            if (m.pressed && m.button === 32) {
              if (mm.clickRow(m.row)) { this._dirty.modelModal = true; this._dirty.input = true; this._renderDirty(); }
            } else if (!m.pressed || m.button >= 32) {
              if (mm.hoverRow(m.row)) { this._dirty.modelModal = true; this._renderDirty(); }
            }
            if (m.button === 64) this._scrollUp(3);
            if (m.button === 65) this._scrollDown(3);
            i += seq.indexOf("M", 3) !== -1 ? seq.indexOf("M", 3) + 1 : seq.indexOf("m", 3) + 1;
            continue;
          }
        }

        if (mm.onCancel) mm.onCancel();
        this.closeModelModal();
        return;
      }

      // Ctrl+A — open provider picker
      if (ch === "\x01") {
        if (mm.onProvider) mm.onProvider();
        i++; continue;
      }

      if (ch === "\r" || ch === "\n") { mm.selectHovered(); i++; continue; }
      if (ch === "\u007F" || ch === "\b") { mm.searchBackspace(); this._dirty.modelModal = true; this._renderDirty(); i++; continue; }
      if (ch >= " ") { mm.searchAppend(ch); this._dirty.modelModal = true; this._renderDirty(); i++; continue; }
      i++;
    }
  }

  _handleSettingsModalKey(data) {
    const sm = this.settingsModal;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === "\x1B") {
        const seq = data.slice(i);
        if (seq.startsWith("\x1B[A")) {
          if (sm.editing < 0) { sm.up(); this._dirty.settingsModal = true; this._renderDirty(); }
          i += 3; continue;
        }
        if (seq.startsWith("\x1B[B")) {
          if (sm.editing < 0) { sm.down(); this._dirty.settingsModal = true; this._renderDirty(); }
          i += 3; continue;
        }

        if (seq.startsWith("\x1B[<")) {
          const m = this._parseMouse(seq);
          if (m) {
            if (m.pressed && m.button === 32) {
              sm.clickRow(m.row);
              this._dirty.settingsModal = true; this._dirty.input = true; this._renderDirty();
            } else {
              sm.hoverRow(m.row);
              this._dirty.settingsModal = true; this._renderDirty();
            }
            if (m.button === 64) this._scrollUp(3);
            if (m.button === 65) this._scrollDown(3);
            i += seq.indexOf("M", 3) !== -1 ? seq.indexOf("M", 3) + 1 : seq.indexOf("m", 3) + 1;
            continue;
          }
        }

        // Esc: cancel edit or close modal
        if (sm.editing >= 0) { sm.cancelEdit(); this._dirty.settingsModal = true; this._dirty.input = true; this._renderDirty(); }
        else { if (sm.onCancel) sm.onCancel(); this.closeSettingsModal(); }
        return;
      }

      if (ch === "\r" || ch === "\n") {
        if (sm.editing >= 0) {
          sm.commitEdit();
          this._dirty.settingsModal = true; this._dirty.input = true; this._renderDirty();
        } else {
          if (sm.hovered === 0 && sm.onOpenProvider) {
            sm.onOpenProvider();
          } else {
            sm.startEdit(sm.hovered);
            this._dirty.settingsModal = true; this._dirty.input = true; this._renderDirty();
          }
        }
        i++; continue;
      }

      if (ch === "\u007F" || ch === "\b") {
        if (sm.editing >= 0) { sm.backspace(); this._dirty.settingsModal = true; this._dirty.input = true; this._renderDirty(); }
        i++; continue;
      }

      // Number shortcut when not editing
      if (sm.editing < 0 && ch >= "1" && ch <= "9") {
        const idx = parseInt(ch, 10) - 1;
        if (idx < sm.fields.length) {
          sm.hovered = idx;
          if (idx === 0 && sm.onOpenProvider) {
            sm.onOpenProvider();
          } else {
            sm.startEdit(idx);
          }
          this._dirty.settingsModal = true; this._dirty.input = true; this._renderDirty();
        }
        i++; continue;
      }

      // Typing in edit mode — ONLY when editing
      if (ch >= " " && sm.editing >= 0) {
        sm.appendChar(ch);
        this._dirty.settingsModal = true; this._dirty.input = true; this._renderDirty();
        i++; continue;
      }

      // All other keys ignored while modal is open (no close on random typing)
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
        this.modalCancel(); return;
      }
      if (ch === "\r" || ch === "\n") { this.modalSelect(); i++; continue; }
      if (ch === "\t") { this.modalSelect(); i++; continue; }
      if (ch === "q") { this.modalCancel(); i++; continue; }
      i++;
    }
  }

  _processInput(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === "\x1B") {
        const seq = data.slice(i);

        if (seq.startsWith("\x1B[A")) { if (this.palette.visible) this._paletteUp(); else if (this.contentLines.length > this.contentHeight) this._enterScrollMode(); i += 3; continue; }
        if (seq.startsWith("\x1B[B")) { if (this.palette.visible) this._paletteDown(); i += 3; continue; }
        if (seq.startsWith("\x1B[C")) { this._cursorRight(); i += 3; continue; }
        if (seq.startsWith("\x1B[D")) { this._cursorLeft();  i += 3; continue; }
        if (seq.startsWith("\x1B[H")) { this._cursorHome();  i += 3; continue; }
        if (seq.startsWith("\x1B[F")) { this._cursorEnd();   i += 3; continue; }
        if (seq.startsWith("\x1B[3~")) { this._delete();     i += 4; continue; }
        if (seq.startsWith("\x1B[5~")) { this._pageUp();     i += 4; continue; }
        if (seq.startsWith("\x1B[6~")) { this._pageDown();   i += 4; continue; }

        if (seq.startsWith("\x1B[<")) {
          const m = this._parseMouse(seq);
          if (m) {
            if (m.pressed) {
              if (m.button === 64) this._scrollUp(3);
              if (m.button === 65) this._scrollDown(3);
            }
            i += seq.indexOf("M", 3) !== -1 ? seq.indexOf("M", 3) + 1 : seq.indexOf("m", 3) + 1;
            continue;
          }
        }

        let j = i + 1;
        while (j < data.length && !/[a-zA-Z]/.test(data[j])) j++;
        if (j < data.length) j++;
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
        if (this.palette.visible) {
          this._paletteSelect();
          if (this.inputBuffer.trim() === "/settings" || this.inputBuffer.trim() === "/modal" || this.inputBuffer.trim() === "/model") {
            this._submit();
          }
        }
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

        if (seq.startsWith("\x1B[<")) {
          const m = this._parseMouse(seq);
          if (m) {
            if (m.pressed) {
              if (m.button === 64) this._scrollUp(3);
              if (m.button === 65) this._scrollDown(3);
            }
            i += seq.indexOf("M", 3) !== -1 ? seq.indexOf("M", 3) + 1 : seq.indexOf("m", 3) + 1;
            continue;
          }
        }

        this._exitScrollMode(); return;
      }

      if (ch === "q") { this._exitScrollMode(); return; }
      if (ch === "j") { this._scrollDown(1); i++; continue; }
      if (ch === "k") { this._scrollUp(1); i++; continue; }
      if (ch === "g") { this._scrollToTop(); i++; continue; }
      if (ch === "G") { this._scrollToBottom(); i++; continue; }
      i++;
    }
  }

  _handleResize() {
    this.width       = process.stdout.columns || 80;
    this.height      = process.stdout.rows    || 24;
    this.inputRow    = this.height;
    this.statusRow   = this.height - 1;
    this.contentHeight = this.statusRow - this.contentRowStart;
    this.maxScroll   = Math.max(0, this.contentLines.length - this.contentHeight);
    if (this.scrollOffset > this.maxScroll) this.scrollOffset = this.maxScroll;
    process.stdout.write(ansi.clearScreen);
    this._renderAll();
  }
}

module.exports = { Terminal, C, ansi, wrapText, DEFAULT_COMMANDS };

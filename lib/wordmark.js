"use strict";

const C = require("./colors");

// Pixel / retro block font — matches the supplied design:
// Wide, chunky squared letterforms. WORD in lavender, CHECK in white.
//
// Each half is exactly 7 lines tall so short-banner can still slice [0,2,6].

const WORD_ART = [
  "██╗    ██╗ ██████╗ ██████╗ ██████╗ ",
  "██║    ██║██╔═══██╗██╔══██╗██╔══██╗",
  "██║ █╗ ██║██║   ██║██████╔╝██║  ██║",
  "██║███╗██║██║   ██║██╔══██╗██║  ██║",
  "██║███╗██║██║   ██║██║  ██║██║  ██║",
  "╚███╔███╔╝╚██████╔╝██║  ██║██████╔╝",
  " ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝ ",
];

const CHECK_ART = [
  " ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗",
  "██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝",
  "██║     ███████║█████╗  ██║     █████╔╝ ",
  "██║     ██╔══██║██╔══╝  ██║     ██╔═██╗ ",
  "██║     ██║  ██║██║     ██║     ██║  ██╗",
  "╚██████╗██║  ██║███████╗╚██████╗██║  ██║",
  " ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝",
];

function renderWordmark() {
  return WORD_ART.map((word, index) => C.word.bold(word) + C.check.bold(CHECK_ART[index]));
}

module.exports = { WORD_ART, CHECK_ART, renderWordmark };

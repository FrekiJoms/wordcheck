"use strict";

const C = require("./colors");

// Separate halves allow the terminal title to match the supplied design:
// lavender/blue WORD followed by a white CHECK.
const WORD_ART = [
  "██     ██  ████████  ███████   ███████ ",
  "██     ██ ██      ██ ██    ██ ██      ██",
  "██  █  ██ ██      ██ ██    ██ ██      ██",
  "██ ███ ██ ██      ██ ███████  ██      ██",
  "███   ███ ██      ██ ██  ██   ██      ██",
  "██     ██  ████████  ██   ██   ███████ ",
];

const CHECK_ART = [
  " ███████  ██    ██ ███████  ███████  ██   ██",
  "██       ██    ██ ██       ██       ██  ██ ",
  "██       ████████ █████    █████    █████  ",
  "██       ██    ██ ██       ██       ██  ██ ",
  "██       ██    ██ ██       ██       ██   ██",
  " ███████ ██    ██ ███████  ███████  ██    ██",
];

function renderWordmark() {
  return WORD_ART.map((word, index) => C.word.bold(word) + C.check.bold(CHECK_ART[index]));
}

module.exports = { WORD_ART, CHECK_ART, renderWordmark };

// @index language-catalog — Generated from resources/co/languages.json; do not edit.
export const languageIds = {
  "mips": "mipsasm",
  "verilog": "verilog",
  "systemVerilog": "systemverilog",
  "logisim": "logisim-circ"
} as const;
export const languageCatalog = [
  {
    "key": "mips",
    "id": "mipsasm",
    "extensions": [
      ".asm",
      ".s",
      ".mips"
    ],
    "aliases": [
      "MIPS ASM",
      "mipsasm"
    ],
    "configuration": "./language-configuration/mipsasm.json",
    "grammar": {
      "scopeName": "source.mips",
      "path": "./syntaxes/mips.tmLanguage.json"
    },
    "snippets": "./snippets/mipsasm.json",
    "lsp": {
      "selector": "language",
      "formatting": true,
      "semanticHighlighting": true
    }
  },
  {
    "key": "verilog",
    "id": "verilog",
    "extensions": [
      ".v",
      ".vh"
    ],
    "aliases": [
      "Verilog",
      "verilog"
    ],
    "configuration": "./language-configuration/verilog.json",
    "grammar": {
      "scopeName": "source.verilog",
      "path": "./syntaxes/verilog.tmLanguage.json"
    },
    "snippets": "./snippets/verilog.json",
    "lsp": {
      "selector": "language",
      "formatting": true,
      "rangeFormatting": true,
      "semanticHighlighting": true
    }
  },
  {
    "key": "systemVerilog",
    "id": "systemverilog",
    "extensions": [
      ".sv",
      ".svh"
    ],
    "aliases": [
      "SystemVerilog",
      "systemverilog"
    ],
    "configuration": "./language-configuration/verilog.json",
    "grammar": {
      "scopeName": "source.systemverilog.co",
      "path": "./syntaxes/systemverilog.tmLanguage.json"
    }
  },
  {
    "key": "logisim",
    "id": "logisim-circ",
    "extensions": [
      ".circ"
    ],
    "lsp": {
      "selector": "extension",
      "formatting": false,
      "semanticHighlighting": false
    }
  }
] as const;
export const languageServiceIds = ["mipsasm","verilog","logisim-circ"] as const;
export type LanguageServiceId = typeof languageServiceIds[number];

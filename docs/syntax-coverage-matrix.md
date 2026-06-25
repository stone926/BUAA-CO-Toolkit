# Built-in Syntax Coverage Matrix

This matrix freezes the supported course subset for local diagnostics. It intentionally documents both supported syntax and course-out handling so future parser changes do not turn legal course code into noisy syntax errors.

## MIPS ASM

### Directives

| Directive | Operands | Section | Status | Primary Diagnostics |
| --- | --- | --- | --- | --- |
| `.data` | optional address | any | supported | `directive-operand`, `co-section-address`, `section-address-range` |
| `.text` | optional address | any | supported | `directive-operand`, `co-section-address`, `section-address-range` |
| `.kdata` | optional address | any | supported | `directive-operand` |
| `.ktext` | optional address | any | supported; P7 `0x4180` allowed | `directive-operand`, `co-section-address` |
| `.word` | integer, char, label, repeat count | data | supported, continuation-aware | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.half` | integer, char, repeat count | data | supported, continuation-aware | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.byte` | integer, char, repeat count | data | supported, continuation-aware | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.float` | float, char, repeat count | data | supported, continuation-aware | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.double` | float, char, repeat count | data | supported, continuation-aware | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.space` | one non-negative integer | data | supported | `directive-segment`, `directive-operand-count`, `directive-operand`, `space-alignment` |
| `.ascii` | string list | data | supported, continuation-aware | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.asciiz` | string list | data | supported, continuation-aware | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.align` | one non-negative integer | data | supported | `directive-segment`, `directive-operand-count`, `directive-operand`, `align-large` |
| `.globl` | label list | any | supported | `directive-operand-count`, `directive-operand` |
| `.extern` | label, size | any | supported | `directive-operand-count`, `directive-operand` |
| `.set` | any | any | parsed with warning; effect ignored by MARS mode | `set-ignored` |
| `.eqv` | name, replacement | any | supported with declaration-order checks | `directive-operand`, `reserved-symbol`, `eqv-forward-reference` |
| `.macro` | name, formal params | any | supported with static body analysis | `macro-header`, `macro-parameter`, `nested-macro`, `duplicate-macro` |
| `.end_macro` | none | macro body | supported | `macro-end`, `directive-operand` |
| `.include` | quoted path | any | syntax supported; no expansion in realtime parser | `directive-operand` |

### Instructions

- Resource source: `resources/mips/instructions.json`
- Current resource count: 114 instructions.
- Operand pattern source: `resources/mips/instructionMeta.json`.
- Instruction validation is table-backed through `src/language/mips/instructionValidation.ts`.
- Test coverage: `src/test/language/mips/instructionValidation.test.ts` generates concrete positive examples from every declared resource format and representative negative examples for each operand family.

| Operand Family | Patterns | Valid Example | Invalid Example |
| --- | --- | --- | --- |
| register | `$rd`, `$rs`, `$rt`, `$base`, `$temp` | `add $t0, $t1, $t2` | `add 1, $t1, $t2` |
| CP0 register | `cp0` | `mfc0 $t0, $12` | `mfc0 $t0, $bad` |
| memory | `offset($base)` | `lw $t0, 4($sp)` | `lw $t0, 4($bad)` |
| signed immediate | `simm16` | `addi $t0, $t1, -1` | `addi $t0, $t1, label` |
| unsigned immediate | `uimm16` | `ori $t0, $t1, 0xffff` | `ori $t0, $t1, -1` |
| shift amount | `shamt` | `sll $t0, $t1, 4` | `sll $t0, $t1, 40` |
| position/size | `pos`, `size` | `ext $t0, $t1, 0, 8` | `ext $t0, $t1, x, 8` |
| trap code | `code`, `code16` | `teqi $t0, 1` | `teqi $t0, label` |
| label | `label` | `beq $t0, $t1, done` | `beq $t0, $t1, 4($sp)` |

### Lexical And Line Syntax

| Feature | Status | Diagnostics |
| --- | --- | --- |
| unknown token (`@`, backtick, isolated `%`, isolated `$`) | supported | `mips-lex-unknown-token` |
| unclosed string | supported | `mips-lex-unclosed-string` |
| invalid string escape | supported | `mips-lex-string-escape` |
| malformed char literal | supported | `mips-lex-char-literal`, `mips-lex-unclosed-char` |
| bad line without executable (`:`, `1bad: nop`, `a:: nop`) | supported | `mips-syntax-line` |
| data directive continuation | supported for `.byte/.half/.word/.float/.double/.ascii/.asciiz` | `directive-operand-count`, `directive-operand` |

## Verilog

### Course Subset

| Area | Supported Forms | Diagnostics |
| --- | --- | --- |
| module header | empty, legacy ports, ANSI ports, parameter list | `syntax-module-declaration`, `syntax-malformed-port-list` |
| declarations | `input/output/inout/wire/reg/logic/integer/time/real/realtime/genvar/parameter/localparam` | `syntax-malformed-declaration` |
| assign | continuous and procedural blocking/nonblocking | `syntax-malformed-assignment`, `syntax-missing-semicolon` |
| expressions | unary, binary, ternary, concat, repeat concat, calls, system calls, selects | `syntax-malformed-assignment`, `syntax-malformed-declaration`, `syntax-malformed-instance` |
| procedural control | `always`, `initial`, event/delay controls, `if/else`, `case`, `for/while/repeat/forever`; for-loop init/condition/step are checked structurally | `syntax-malformed-event-control`, `syntax-malformed-if`, `syntax-malformed-for`, `syntax-malformed-while`, `syntax-malformed-repeat`, `syntax-orphan-*` |
| blocks | `begin/end`, `case/endcase`, `generate/endgenerate`, `function/endfunction`, `task/endtask` | `syntax-unclosed-*`, `syntax-unmatched-*` |
| instances | named/positional ports, parameter overrides, common gate primitives | `syntax-malformed-instance`, `syntax-malformed-gate-primitive` |
| preprocessor | static ``include``, ``define``, ``default_nettype`` recognition | `missing-include`, implicit-net diagnostics |
| generate | common generate-for with named begin block; generate-if bodies are recognized enough to avoid module-scope false positives | `syntax-malformed-for`, `syntax-malformed-generate`, `syntax-unclosed-generate` where applicable |
| task/function | common headers, declarations, procedural body | `syntax-malformed-procedural-block`, `syntax-unclosed-*` |

### Course-out Classification

| Construct | Behavior | Rationale |
| --- | --- | --- |
| `tri`, `tri1`, `supply0`, `supply1`, `wand`, `wor` | parsed as wire-like declarations and reported as `syntax-unsupported-construct` information | legal Verilog, uncommon in CO projects |
| drive-strength assign | parsed after stripping the strength tuple and reported as `syntax-unsupported-construct` information | legal Verilog but outside course subset |
| `specify`, `primitive`, `table` | `syntax-unsupported-construct` | simulator/library modeling, not course subset |
| `defparam` | `syntax-unsupported-construct` | prefer parameter override in instances |
| `fork/join`, `event` | `syntax-unsupported-construct` | behavioral simulation-only constructs |
| SystemVerilog (`always_ff`, interfaces, packages, typedef/enum/struct`) | unsupported construct or syntax error depending on recoverability | outside Verilog course subset |

### Performance Baseline

| Scenario | Coverage | Test |
| --- | --- | --- |
| 2000+ line course-style Verilog file | `getVerilogDiagnostics` must complete without external tools, produce no `syntax-*` diagnostics for the generated valid design, and stay under the default 4000ms budget | `src/test/language/verilog/performance.test.ts` |
| repeated diagnostics on same URI/version/text | parse result must be reused from `getCachedVerilogParse` instead of reparsing | `src/test/language/verilog/performance.test.ts` |

The timing budget can be overridden for slower CI hosts with `CO_VERILOG_PERF_BUDGET_MS`.

## Fixture Layout

```text
src/test/fixtures/syntax/
  mips/
    valid/
    invalid/
    course/
  verilog/
    valid/
    invalid/
    course-out/
    real-project/
```

Fixture expectation files use the same base name with `.json` and assert diagnostic `code` plus 1-based `line`.

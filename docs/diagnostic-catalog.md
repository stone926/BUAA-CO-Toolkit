# Built-in Diagnostic Catalog

This catalog records stable diagnostic codes used by the built-in MIPS and Verilog analyzers. Historical codes are kept for compatibility with `co.diagnostics.disabledCodes`; new codes should be added here before tests depend on them.

## Severity

- Error: blocks the course subset syntax or structural model.
- Warning: legal or parseable code that is risky, course-out, missing external context, or likely unintended.
- Information: course guidance and optional style hints.

## MIPS

| Code | Severity | Layer | Source | Example |
| --- | --- | --- | --- | --- |
| `mips-lex-unknown-token` | Error | Lexical | `src/language/mips/parser.ts` | `@` |
| `mips-lex-unclosed-string` | Error | Lexical | `src/language/mips/parser.ts` | `.asciiz "abc` |
| `mips-lex-string-escape` | Error | Lexical | `src/language/mips/parser.ts` | `.asciiz "\q"` |
| `mips-lex-char-literal` | Error | Lexical | `src/language/mips/parser.ts` | `.byte '\x'` |
| `mips-lex-unclosed-char` | Error | Lexical | `src/language/mips/parser.ts` | `.byte '\` |
| `mips-syntax-line` | Error | Parse | `src/language/mips/parser.ts` | `1bad: nop`, `:` |
| `unknown-directive` | Error | Parse | `src/language/mips/parser.ts` | `.unknown` |
| `unknown-instruction` | Error | Parse | `src/language/mips/parser.ts` | `ad $t0, $t1, $t2` |
| `unknown-register` | Error | Semantic | `src/language/mips/parser.ts` | `$bad` |
| `reserved-symbol` | Error | Semantic | `src/language/mips/parser.ts` | `add:` |
| `duplicate-symbol` | Error | Semantic | `src/language/mips/parser.ts` | repeated label |
| `missing-label` | Error | Semantic | `src/language/mips/parser.ts` | `beq $t0, $t1, missing` |
| `undeclared-symbol` | Error | Semantic | `src/language/mips/parser.ts` | `.word missing` |
| `eqv-forward-reference` | Error | Semantic | `src/language/mips/parser.ts` | use `.eqv` before declaration |
| `directive-segment` | Error | Directive | `src/language/mips/parser.ts` | `.word 1` before `.data` |
| `directive-operand-count` | Error | Directive | `src/language/mips/parser.ts` | `.word` at EOF |
| `directive-operand` | Error | Directive | `src/language/mips/parser.ts` | `.space foo` |
| `co-section-address` | Error | Course Lint | `src/language/mips/parser.ts` | `.data 0x10010000` |
| `section-address-range` | Warning | Course Lint | `src/language/mips/parser.ts` | `.text 0x80000000` |
| `set-ignored` | Warning | Directive | `src/language/mips/parser.ts` | `.set noreorder` |
| `space-alignment` | Warning | Course Lint | `src/language/mips/parser.ts` | `.space 3` |
| `align-large` | Warning | Course Lint | `src/language/mips/parser.ts` | `.align 8` |
| `macro-header` | Error | Structural | `src/language/mips/parser.ts` | `.macro` |
| `macro-unclosed` | Error | Structural | `src/language/mips/parser.ts` | missing `.end_macro` |
| `macro-end` | Error | Structural | `src/language/mips/parser.ts` | stray `.end_macro` |
| `nested-macro` | Warning | Structural | `src/language/mips/parser.ts` | `.macro` inside `.macro` |
| `duplicate-macro` | Error | Structural | `src/language/mips/parser.ts` | repeated macro overload |
| `duplicate-macro-parameter` | Error | Structural | `src/language/mips/parser.ts` | `.macro m(%a, %a)` |
| `macro-parameter` | Error | Structural | `src/language/mips/parser.ts` | malformed macro parameter |
| `macro-argument` | Error | Structural | `src/language/mips/parser.ts` | macro argument `4($t0)` |
| `macro-argument-count` | Error | Structural | `src/language/mips/parser.ts` | wrong macro arity |
| `operand-count` | Error | Instruction | `src/language/mips/instructionValidation.ts` | `add $t0, $t1` |
| `operand-type` | Error | Instruction | `src/language/mips/instructionValidation.ts` | register where immediate is required |
| `memory-alignment` | Warning | Instruction | `src/language/mips/instructionValidation.ts` | `lw $t0, 2($sp)` |
| `cp0-write` | Warning | Course Lint | `src/language/mips/instructionValidation.ts` | `mtc0 $t0, 13` |
| `pseudo-instruction` | Information | Course Lint | `src/language/mips/instructionValidation.ts` | `li $t0, 1` |
| `instruction-in-data` | Error | Structural | `src/language/mips/parser.ts` | `add` in `.data` |
| `syscall-v0-uninitialized` | Warning | Course Lint | `src/language/mips/parser.ts` | P2 `syscall` before `$v0` write |
| `missing-syscall` | Warning | Course Lint | `src/language/mips/parser.ts` | P2 file without syscall |

## Verilog

| Code | Severity | Layer | Source | Example |
| --- | --- | --- | --- | --- |
| `syntax-unexpected-character` | Error | Lexical | `src/language/verilog/lexer.ts` | non-Verilog control character |
| `syntax-unclosed-comment` | Error | Lexical | `src/language/verilog/lexer.ts` | `/*` |
| `syntax-unclosed-string` | Error | Lexical | `src/language/verilog/lexer.ts` | `"abc` |
| `syntax-malformed-number` | Error | Lexical | `src/language/verilog/syntaxParser.ts` | `4'b1020` |
| `syntax-module-declaration` | Error | Parse | `src/language/verilog/syntaxDiagnostics.ts` | `module ;` |
| `syntax-unmatched-delimiter` | Error | Parse | `src/language/verilog/syntaxDiagnostics.ts` | extra `)` |
| `syntax-unclosed-delimiter` | Error | Parse | `src/language/verilog/syntaxDiagnostics.ts` | missing `]` |
| `syntax-unclosed-begin` | Error | Parse | `src/language/verilog/syntaxDiagnostics.ts` | missing `end` |
| `syntax-unclosed-case` | Error | Parse | `src/language/verilog/syntaxDiagnostics.ts` | missing `endcase` |
| `syntax-missing-semicolon` | Error | Parse | `src/language/verilog/syntaxParser.ts` | declaration without `;` |
| `syntax-malformed-declaration` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `wire reg foo;` |
| `syntax-malformed-port-list` | Error | Parse | `src/language/verilog/syntaxParser.ts` | broken ANSI port list |
| `syntax-malformed-assignment` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `assign y = ;` |
| `syntax-malformed-instance` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `.a a` |
| `syntax-malformed-gate-primitive` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `not ;` |
| `syntax-malformed-procedural-block` | Error | Parse | `src/language/verilog/syntaxParser.ts` | broken `always` or `initial` |
| `syntax-malformed-event-control` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `always @(posedge clk` |
| `syntax-malformed-if` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `if a)` |
| `syntax-malformed-for` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `for (i = ; i < 4; i = i + 1)` |
| `syntax-malformed-while` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `while a)` |
| `syntax-malformed-repeat` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `repeat ()` |
| `syntax-malformed-generate` | Error | Parse | `src/language/verilog/syntaxParser.ts` | generate-for without `begin : name` |
| `syntax-orphan-else` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `else y = 1;` |
| `syntax-orphan-default` | Error | Parse | `src/language/verilog/syntaxParser.ts` | `default: y = 1;` outside case |
| `syntax-unexpected-token` | Error | Parse | `src/language/verilog/syntaxParser.ts` | unsupported token at module scope |
| `syntax-unsupported-construct` | Information | Course-out | `src/language/verilog/syntaxParser.ts` | `specify`, `primitive`, `fork`, `tri1`, drive strength |
| `missing-endmodule` | Error | Structural | `src/language/verilog/diagnostics.ts` | module without `endmodule` |
| `duplicate-module` | Error | Structural | `src/language/verilog/diagnostics.ts`, `src/language/verilog/workspaceDiagnostics.ts` | repeated module name |
| `missing-include` | Warning | Preprocess | `src/language/verilog/diagnostics.ts` | ``include "missing.v"` |
| `unknown-port` | Error | Semantic | `src/language/verilog/instanceConnectionDiagnostics.ts` | `.bad(signal)` |
| `unknown-parameter` | Error | Semantic | `src/language/verilog/instanceConnectionDiagnostics.ts` | `#(.BAD(1))` |
| `port-width-mismatch` | Warning | Semantic | `src/language/verilog/instanceConnectionDiagnostics.ts` | 1-bit port driven by 32-bit signal |
| `width-mismatch` | Warning | Semantic | `src/language/verilog/diagnostics.ts` | assignment truncation |
| `select-out-of-range` | Warning | Semantic | `src/language/verilog/diagnostics.ts` | `a[8]` on 4-bit signal |
| `constant-division-by-zero` | Warning | Semantic | `src/language/verilog/diagnostics.ts` | `a / 0` |
| `implicit-net` | Configurable | Semantic | `src/language/verilog/lintDiagnostics.ts` | undeclared wire under implicit net mode |
| `explicit-port-net-type` | Warning | Course Lint | `src/language/verilog/lintDiagnostics.ts` | `input wire clk` |
| `synth-*` | Warning | Course Lint | `src/language/verilog/lintDiagnostics.ts` | synthesizability hints |
| `vc-001` - `vc-022` | Error/Warning/Info | Course Lint | `src/language/verilog/lintDiagnostics.ts` | CO course style/profile rules |

### Verilog Course Lint Catalog

<!-- generated:verilog-lint-rules:start -->

Configurable VC rules and synthesizable hint rules are generated from `resources/verilog/lintRules.json`.

Configurable rule ids: `vc-001`, `vc-002`, `vc-003`, `vc-004`, `vc-005`, `vc-006`, `vc-007`, `vc-008`, `vc-009`, `vc-010`, `vc-011`, `vc-012`, `vc-013`, `vc-014`, `vc-015`, `vc-017`, `vc-021`.

| Code | Severity | Default | Configurable | Title | Description |
| --- | --- | --- | --- | --- | --- |
| `vc-001` | information | disabled | yes | Signal naming style | Keep signal names in one recognizable style. |
| `vc-002` | information | enabled | yes | Low-active suffix | Low-active signal names should use the _n suffix. |
| `vc-003` | information | disabled | yes | Multiplexer signal naming | Multiplexer signal names should reveal width or input count. |
| `vc-004` | information | disabled | yes | Magic number | Replace unexplained numeric literals with a localparam, parameter, or macro. |
| `vc-005` | warning | enabled | yes | Multiple always drivers | Avoid assigning one signal in multiple always blocks. |
| `vc-006` | warning | enabled | yes | Combinational sensitivity | Combinational logic should use always @(*) or assign. |
| `vc-007` | warning | enabled | yes | Combinational blocking assignment | Combinational always blocks should use blocking assignments. |
| `vc-008` | information | disabled | yes | Combinational completeness | Combinational branches and case statements should assign every output path. |
| `vc-009` | warning | enabled | yes | Sequential posedge | Sequential logic should use always @(posedge clock). |
| `vc-010` | warning | enabled | yes | Sequential nonblocking assignment | Sequential always blocks should use nonblocking assignments. |
| `vc-011` | warning | enabled | yes | Negedge trigger | Avoid negedge-triggered logic unless a protocol requires it. |
| `vc-012` | warning | enabled | yes | Edge signal kind | Edge-triggered sensitivity signals should be clocks or resets. |
| `vc-013` | information | enabled | yes | Clock used as data | Clock signals should not be used as ordinary data inside sequential logic. |
| `vc-014` | information | enabled | yes | Synchronous reset preference | Prefer synchronous reset when async reset appears in sensitivity lists. |
| `vc-015` | warning | enabled | yes | Internal inout port | Internal modules should avoid inout ports. |
| `vc-017` | information | disabled | yes | Instance port formatting | Instances should use named, multiline, one-port-per-line mapping. |
| `vc-021` | information | disabled | yes | Explicit signal width | Declare explicit widths for non-parameter signals. |
| `synth-decl-init` | information | enabled | no | Declaration initializer | Avoid declaration initializers for registers in synthesizable modules. |
| `synth-initial` | information | enabled | no | Initial block | Avoid initial blocks in synthesizable design modules. |
| `synth-mul-div` | information | enabled | no | Expensive arithmetic operator | Avoid multiply, divide, and modulo operators unless hardware cost is intentional. |

<!-- generated:verilog-lint-rules:end -->

## Adding A Code

1. Pick the narrowest layer prefix that matches the diagnostic.
2. Keep existing codes stable; add aliases only when a rename is unavoidable.
3. Add at least one valid fixture and one invalid fixture or unit test.
4. Add the code to this catalog with severity, layer, source, and example.

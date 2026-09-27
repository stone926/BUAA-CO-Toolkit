# 内置诊断目录

本目录记录内置 MIPS、Verilog 和 Logisim 分析器当前会产生的稳定诊断码。用户可以通过 `co.diagnostics.disabledCodes` 和 `co.diagnostics.disabledFileCodes` 精确禁用诊断。

带 `<...>` 的条目表示带动态后缀的诊断码模式，例如 `implicit-net:<name>` 会实际发出 `implicit-net:missing`。带 `*` 的条目表示同一基础规则下的多个稳定子码。

## 严重级别

- 错误：阻断课程子集语法、结构模型或关键接口约束。
- 警告：代码合法或可解析，但有课程风险、宽度/连接风险、缺少上下文或行为可能不符合预期。
- 信息：课程建议、可选质量提示。
- 可配置：严重级别由设置决定，或可关闭。

## 当前诊断码清单

<!-- generated:diagnostic-codes:start -->

此清单由 MIPS、Verilog 和 Logisim 诊断生产代码生成。新增诊断码、动态码模式或遗漏更新都会使 `check:diagnostic-catalog` 失败。

| 语言 | 发出的代码或动态模式 | 来源 |
| --- | --- | --- |
| logisim | `circ-project` | `src/language/logisim/service.ts` |
| logisim | `circ-xml` | `src/language/logisim/service.ts` |
| logisim | `memory-contents` | `src/language/logisim/service.ts` |
| logisim | `memory-widths` | `src/language/logisim/service.ts` |
| logisim | `missing-label` | `src/language/logisim/service.ts` |
| mips | `align-large` | `src/language/mips/parser.ts` |
| mips | `co-section-address` | `src/language/mips/parser.ts` |
| mips | `cp0-write` | `src/language/mips/instructionValidation.ts` |
| mips | `directive-operand` | `src/language/mips/parser.ts` |
| mips | `directive-operand-count` | `src/language/mips/parser.ts` |
| mips | `directive-segment` | `src/language/mips/parser.ts` |
| mips | `duplicate-macro` | `src/language/mips/parser.ts` |
| mips | `duplicate-macro-parameter` | `src/language/mips/parser.ts` |
| mips | `duplicate-symbol` | `src/language/mips/parser.ts` |
| mips | `eqv-forward-reference` | `src/language/mips/parser.ts` |
| mips | `instruction-in-data` | `src/language/mips/parser.ts` |
| mips | `macro-argument` | `src/language/mips/parser.ts` |
| mips | `macro-argument-count` | `src/language/mips/parser.ts` |
| mips | `macro-end` | `src/language/mips/parser.ts` |
| mips | `macro-header` | `src/language/mips/parser.ts` |
| mips | `macro-parameter` | `src/language/mips/parser.ts` |
| mips | `macro-unclosed` | `src/language/mips/parser.ts` |
| mips | `memory-alignment` | `src/language/mips/instructionValidation.ts` |
| mips | `mips-lex-char-literal` | `src/language/mips/parser.ts` |
| mips | `mips-lex-string-escape` | `src/language/mips/parser.ts` |
| mips | `mips-lex-unclosed-char` | `src/language/mips/parser.ts` |
| mips | `mips-lex-unclosed-string` | `src/language/mips/parser.ts` |
| mips | `mips-lex-unknown-token` | `src/language/mips/parser.ts` |
| mips | `mips-syntax-line` | `src/language/mips/parser.ts` |
| mips | `missing-label` | `src/language/mips/parser.ts` |
| mips | `missing-syscall` | `src/language/mips/parser.ts` |
| mips | `nested-macro` | `src/language/mips/parser.ts` |
| mips | `operand-count` | `src/language/mips/instructionValidation.ts` |
| mips | `operand-type` | `src/language/mips/instructionValidation.ts` |
| mips | `project-instruction` | `src/language/mips/instructionValidation.ts` |
| mips | `pseudo-instruction:<mnemonic>` | `src/language/mips/instructionValidation.ts` |
| mips | `reserved-symbol` | `src/language/mips/parser.ts` |
| mips | `section-address-range` | `src/language/mips/parser.ts` |
| mips | `set-ignored` | `src/language/mips/parser.ts` |
| mips | `space-alignment` | `src/language/mips/parser.ts` |
| mips | `syscall-v0-uninitialized` | `src/language/mips/parser.ts` |
| mips | `undeclared-symbol` | `src/language/mips/parser.ts` |
| mips | `unknown-directive` | `src/language/mips/parser.ts` |
| mips | `unknown-instruction` | `src/language/mips/parser.ts` |
| mips | `unknown-register` | `src/language/mips/parser.ts` |
| verilog | `<profile>-display` | `src/language/verilog/diagnostics.ts` |
| verilog | `<profile>-port` | `src/language/verilog/diagnostics.ts` |
| verilog | `<profile>-port-width` | `src/language/verilog/diagnostics.ts` |
| verilog | `constant-division-by-zero` | `src/language/verilog/diagnostics.ts` |
| verilog | `display-format` | `src/language/verilog/diagnostics.ts` |
| verilog | `duplicate-module` | `src/language/verilog/diagnostics.ts`, `src/language/verilog/workspaceDiagnostics.ts` |
| verilog | `duplicate-parameter-connection` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `duplicate-port-connection` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `explicit-port-wire` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `implicit-net:<name>` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `iverilog-syntax` | `src/language/verilog/iverilogSyntaxCheck.ts` |
| verilog | `iverilog-toolchain` | `src/language/verilog/externalSyntaxCheck.ts`, `src/language/verilog/iverilogSyntaxCheck.ts` |
| verilog | `localparam-override` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `missing-endmodule` | `src/language/verilog/diagnostics.ts` |
| verilog | `missing-include` | `src/language/verilog/diagnostics.ts` |
| verilog | `missing-port:<name>` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `missing-top` | `src/language/verilog/diagnostics.ts` |
| verilog | `multi-driver` | `src/language/verilog/driverDiagnostics.ts` |
| verilog | `p7-cp0-<registerName>` | `src/language/verilog/workspaceDiagnostics.ts` |
| verilog | `p7-instance-<required>` | `src/language/verilog/workspaceDiagnostics.ts` |
| verilog | `p7-module-<required>` | `src/language/verilog/workspaceDiagnostics.ts` |
| verilog | `p7-module-cp0` | `src/language/verilog/workspaceDiagnostics.ts` |
| verilog | `parameter-index-out-of-range` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `parameter-not-constant` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `parameter-width-mismatch` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `port-index-out-of-range` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `port-width-mismatch` | `src/language/verilog/diagnostics.ts`, `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `project-dm-size` | `src/language/verilog/workspaceDiagnostics.ts` |
| verilog | `project-im-size` | `src/language/verilog/workspaceDiagnostics.ts` |
| verilog | `project-pc-reset` | `src/language/verilog/workspaceDiagnostics.ts` |
| verilog | `select-out-of-range` | `src/language/verilog/diagnostics.ts` |
| verilog | `syntax-malformed-<kind>` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-assignment` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-declaration` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-event-control` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-for` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-gate-primitive` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-generate` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-instance` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-number` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-port-list` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-malformed-procedural-block` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-missing-semicolon` | `src/language/verilog/syntaxDiagnostics.ts`, `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-module-declaration` | `src/language/verilog/syntaxDiagnostics.ts` |
| verilog | `syntax-orphan-<value>` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-orphan-default` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-orphan-else` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-unclosed-<token>` | `src/language/verilog/syntaxDiagnostics.ts` |
| verilog | `syntax-unclosed-<value>` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-unclosed-delimiter` | `src/language/verilog/syntaxDiagnostics.ts` |
| verilog | `syntax-unexpected-token` | `src/language/verilog/syntaxParser.ts` |
| verilog | `syntax-unmatched-<value>` | `src/language/verilog/syntaxDiagnostics.ts` |
| verilog | `syntax-unmatched-delimiter` | `src/language/verilog/syntaxDiagnostics.ts` |
| verilog | `syntax-unsupported-construct` | `src/language/verilog/syntaxParser.ts` |
| verilog | `tb-clock` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `unknown-parameter` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `unknown-port` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `unused-parameter` | `src/language/verilog/usageDiagnostics.ts` |
| verilog | `unused-signal` | `src/language/verilog/usageDiagnostics.ts` |
| verilog | `width-mismatch` | `src/language/verilog/diagnostics.ts` |

<!-- generated:diagnostic-codes:end -->

## 新增诊断码

1. 选择能反映最窄来源层级的前缀。
2. 保持已有代码稳定；只有确实需要重命名时才增加别名。
3. 至少增加一个合法用例和一个非法用例，或补充对应单元测试。
4. 先把代码、严重级别、来源和示例加入本目录，再让测试依赖它。

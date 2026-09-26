# 内置诊断目录

本目录记录内置 MIPS、Verilog 和 Logisim 分析器当前会产生的稳定诊断码。历史代码需要保持兼容，因为用户可以通过 `co.diagnostics.disabledCodes` 和 `co.diagnostics.disabledFileCodes` 精确禁用诊断；Verilog 课程 Lint 还可以通过 `co.verilog.lint.disabledRules` 按基础规则 ID 禁用一组 `vc-xxx-*` 子码。

带 `<...>` 的条目表示带动态后缀的诊断码模式，例如 `implicit-net:<name>` 会实际发出 `implicit-net:missing`。带 `*` 的条目表示同一基础规则下的多个稳定子码。

## 严重级别

- 错误：阻断课程子集语法、结构模型或关键接口约束。
- 警告：代码合法或可解析，但有课程风险、宽度/连接风险、缺少上下文或行为可能不符合预期。
- 信息：课程建议、风格提示、可选质量提示。
- 可配置：严重级别由设置决定，或可关闭。

## 当前诊断码清单

<!-- generated:diagnostic-codes:start -->

此清单由 MIPS、Verilog、Logisim 诊断生产代码和 `resources/verilog/lintRules.json` 生成。新增诊断码、动态码模式或遗漏更新都会使 `check:diagnostic-catalog` 失败。

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
| verilog | `mixed-assignment` | `src/language/verilog/lintDiagnostics.ts` |
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
| verilog | `synth-decl-init` | `resources/verilog/lintRules.json`, `src/language/verilog/lintDiagnostics.ts` |
| verilog | `synth-initial` | `resources/verilog/lintRules.json`, `src/language/verilog/lintDiagnostics.ts` |
| verilog | `synth-mul-div` | `resources/verilog/lintRules.json`, `src/language/verilog/lintDiagnostics.ts` |
| verilog | `tb-clock` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `unknown-parameter` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `unknown-port` | `src/language/verilog/instanceConnectionDiagnostics.ts` |
| verilog | `unused-parameter` | `src/language/verilog/usageDiagnostics.ts` |
| verilog | `unused-signal` | `src/language/verilog/usageDiagnostics.ts` |
| verilog | `vc-001` | `resources/verilog/lintRules.json` |
| verilog | `vc-001-mixed-name-style` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-001-name-style` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-002` | `resources/verilog/lintRules.json` |
| verilog | `vc-002-low-active-suffix` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-003` | `resources/verilog/lintRules.json` |
| verilog | `vc-003-mux-name` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-004` | `resources/verilog/lintRules.json` |
| verilog | `vc-004-magic-number` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-005` | `resources/verilog/lintRules.json` |
| verilog | `vc-005-multiple-always` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-006` | `resources/verilog/lintRules.json` |
| verilog | `vc-006-comb-sensitivity` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-007` | `resources/verilog/lintRules.json` |
| verilog | `vc-007-comb-nonblocking` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-008` | `resources/verilog/lintRules.json` |
| verilog | `vc-008-case-default` | `src/language/verilog/dataflowDiagnostics.ts` |
| verilog | `vc-008-comb-branch` | `src/language/verilog/dataflowDiagnostics.ts` |
| verilog | `vc-008-comb-incomplete-assignment` | `src/language/verilog/dataflowDiagnostics.ts` |
| verilog | `vc-009` | `resources/verilog/lintRules.json` |
| verilog | `vc-009-seq-posedge` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-010` | `resources/verilog/lintRules.json` |
| verilog | `vc-010-seq-blocking` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-011` | `resources/verilog/lintRules.json` |
| verilog | `vc-011-negedge` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-012` | `resources/verilog/lintRules.json` |
| verilog | `vc-012-edge-signal` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-013` | `resources/verilog/lintRules.json` |
| verilog | `vc-013-clock-data` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-014` | `resources/verilog/lintRules.json` |
| verilog | `vc-014-sync-reset` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-015` | `resources/verilog/lintRules.json` |
| verilog | `vc-015-inout` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-017` | `resources/verilog/lintRules.json` |
| verilog | `vc-017-multiline-instance` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-017-named-ports` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-017-one-port-per-line` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `vc-021` | `resources/verilog/lintRules.json` |
| verilog | `vc-021-explicit-width` | `src/language/verilog/lintDiagnostics.ts` |
| verilog | `width-mismatch` | `src/language/verilog/diagnostics.ts` |

<!-- generated:diagnostic-codes:end -->

### Verilog 课程 Lint 规则目录

<!-- generated:verilog-lint-rules:start -->

可配置 VC 规则和可综合性提示规则由 `resources/verilog/lintRules.json` 生成。

可配置规则 ID：`vc-001`, `vc-002`, `vc-003`, `vc-004`, `vc-005`, `vc-006`, `vc-007`, `vc-008`, `vc-009`, `vc-010`, `vc-011`, `vc-012`, `vc-013`, `vc-014`, `vc-015`, `vc-017`, `vc-021`。

| 代码 | 严重级别 | 默认 | 可配置 | 标题 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `vc-001` | 信息 | 禁用 | 是 | 信号命名风格 | 信号名应保持一种可识别且一致的命名风格。 |
| `vc-002` | 信息 | 禁用 | 是 | 低有效后缀 | 低有效信号名应使用 _n 后缀。 |
| `vc-003` | 信息 | 禁用 | 是 | 多路选择器命名 | 多路选择器信号名应体现位宽或输入数量。 |
| `vc-004` | 信息 | 禁用 | 是 | 魔数 | 将缺少说明的数字字面量替换为 localparam、parameter 或宏。 |
| `vc-005` | 警告 | 启用 | 是 | 多个 always 驱动 | 避免在多个 always 块中给同一个信号赋值。 |
| `vc-006` | 警告 | 禁用 | 是 | 组合逻辑敏感列表 | 组合逻辑应使用 always @(*) 或 assign。 |
| `vc-007` | 警告 | 启用 | 是 | 组合逻辑阻塞赋值 | 组合逻辑 always 块应使用阻塞赋值。 |
| `vc-008` | 信息 | 禁用 | 是 | 组合逻辑完备性 | 组合逻辑分支和 case 语句应覆盖每条输出赋值路径。 |
| `vc-009` | 警告 | 禁用 | 是 | 时序逻辑 posedge | 时序逻辑应使用 always @(posedge clock)。 |
| `vc-010` | 警告 | 启用 | 是 | 时序逻辑非阻塞赋值 | 时序逻辑 always 块应使用非阻塞赋值。 |
| `vc-011` | 警告 | 禁用 | 是 | negedge 触发 | 除非协议需要，否则避免使用 negedge 触发逻辑。 |
| `vc-012` | 警告 | 禁用 | 是 | 边沿触发信号类型 | 边沿触发敏感信号应为时钟或复位。 |
| `vc-013` | 信息 | 禁用 | 是 | 时钟作为数据 | 时钟信号不应在时序逻辑中作为普通数据使用。 |
| `vc-014` | 信息 | 禁用 | 是 | 同步复位偏好 | 当敏感列表中出现异步复位时，优先考虑同步复位写法。 |
| `vc-015` | 警告 | 禁用 | 是 | 内部 inout 端口 | 内部模块应避免使用 inout 端口。 |
| `vc-017` | 信息 | 禁用 | 是 | 实例端口格式 | 模块实例应使用命名映射、多行格式，并让每个端口单独占一行。 |
| `vc-021` | 信息 | 禁用 | 是 | 显式信号位宽 | 非参数信号应显式声明位宽。 |
| `synth-decl-init` | 信息 | 启用 | 否 | 声明初始化器 | 可综合模块中的寄存器应避免在声明处初始化。 |
| `synth-initial` | 信息 | 启用 | 否 | initial 块 | 可综合设计模块中应避免使用 initial 块。 |
| `synth-mul-div` | 信息 | 启用 | 否 | 高成本算术运算符 | 除非明确接受硬件代价，否则避免使用乘法、除法和取模运算符。 |

<!-- generated:verilog-lint-rules:end -->

## 新增诊断码

1. 选择能反映最窄来源层级的前缀。
2. 保持已有代码稳定；只有确实需要重命名时才增加别名。
3. 至少增加一个合法用例和一个非法用例，或补充对应单元测试。
4. 先把代码、严重级别、来源和示例加入本目录，再让测试依赖它。

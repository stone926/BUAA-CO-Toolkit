# 内置诊断目录

本目录记录插件内置 MIPS 与 Verilog 分析器当前会产生的稳定诊断码。历史代码需要保持兼容，因为用户可以通过 `co.diagnostics.disabledCodes` 和 `co.diagnostics.disabledFileCodes` 精确禁用诊断；Verilog 课程 Lint 还可以通过 `co.verilog.lint.disabledRules` 按基础规则 ID 禁用一组 `vc-xxx-*` 子码。

带 `<...>` 的条目表示带动态后缀的诊断码模式，例如 `implicit-net:<name>` 会实际发出 `implicit-net:missing`。带 `*` 的条目表示同一基础规则下的多个稳定子码。

## 严重级别

- 错误：阻断课程子集语法、结构模型或关键接口约束。
- 警告：代码合法或可解析，但有课程风险、宽度/连接风险、缺少上下文或行为可能不符合预期。
- 信息：课程建议、风格提示、可选质量提示。
- 可配置：严重级别由设置决定，或可关闭。

## MIPS

| 代码 | 严重级别 | 层级 | 来源 | 触发示例 |
| --- | --- | --- | --- | --- |
| `mips-lex-unknown-token` | 错误 | 词法 | `src/language/mips/parser.ts` | `@` |
| `mips-lex-unclosed-string` | 错误 | 词法 | `src/language/mips/parser.ts` | `.asciiz "abc` |
| `mips-lex-string-escape` | 错误 | 词法 | `src/language/mips/parser.ts` | `.asciiz "\q"` |
| `mips-lex-char-literal` | 错误 | 词法 | `src/language/mips/parser.ts` | `.byte '\x'` |
| `mips-lex-unclosed-char` | 错误 | 词法 | `src/language/mips/parser.ts` | `.byte '\` |
| `mips-syntax-line` | 错误 | 行语法 | `src/language/mips/parser.ts` | `1bad: nop`、`:`、寄存器作标签 |
| `unknown-directive` | 错误 | 解析 | `src/language/mips/parser.ts` | `.unknown` |
| `unknown-instruction` | 错误 | 解析 | `src/language/mips/parser.ts` | `ad $t0, $t1, $t2` |
| `unknown-register` | 错误 | 语义 | `src/language/mips/parser.ts` | `$bad` |
| `reserved-symbol` | 错误 | 语义 | `src/language/mips/parser.ts` | `add:`、`.eqv add 1` |
| `duplicate-symbol` | 错误 | 语义 | `src/language/mips/parser.ts` | 重复标签或数据符号 |
| `missing-label` | 错误 | 语义 | `src/language/mips/parser.ts` | `beq $t0, $t1, missing` |
| `undeclared-symbol` | 错误 | 语义 | `src/language/mips/parser.ts` | `.word missing` 或未声明宏参数 |
| `eqv-forward-reference` | 错误 | 语义 | `src/language/mips/parser.ts` | 在 `.eqv` 声明前使用该符号 |
| `directive-segment` | 错误 | 伪指令 | `src/language/mips/parser.ts` | 在 `.text` 中写 `.word 1` |
| `directive-operand-count` | 错误 | 伪指令 | `src/language/mips/parser.ts` | `.word` 到 EOF 仍无操作数 |
| `directive-operand` | 错误 | 伪指令 | `src/language/mips/parser.ts` | `.space foo` |
| `co-section-address` | 错误 | 课程 Lint | `src/language/mips/parser.ts` | `.data 0x10010000` |
| `section-address-range` | 警告 | 课程 Lint | `src/language/mips/parser.ts` | `.text 0x80000000` |
| `set-ignored` | 警告 | 伪指令 | `src/language/mips/parser.ts` | `.set noreorder` |
| `space-alignment` | 警告 | 课程 Lint | `src/language/mips/parser.ts` | `.space 3` |
| `align-large` | 警告 | 课程 Lint | `src/language/mips/parser.ts` | `.align 8` |
| `macro-header` | 错误 | 宏结构 | `src/language/mips/parser.ts` | `.macro` |
| `macro-unclosed` | 错误 | 宏结构 | `src/language/mips/parser.ts` | 缺少 `.end_macro` |
| `macro-end` | 错误 | 宏结构 | `src/language/mips/parser.ts` | 孤立 `.end_macro` |
| `nested-macro` | 警告 | 宏结构 | `src/language/mips/parser.ts` | `.macro` 中再定义 `.macro` |
| `duplicate-macro` | 错误 | 宏结构 | `src/language/mips/parser.ts` | 重复同名同参数数量宏 |
| `duplicate-macro-parameter` | 错误 | 宏结构 | `src/language/mips/parser.ts` | `.macro m(%a, %a)` |
| `macro-parameter` | 错误 | 宏结构 | `src/language/mips/parser.ts` | 形参没有以 `%` 或 `$` 开头 |
| `macro-argument` | 错误 | 宏调用 | `src/language/mips/parser.ts` | 宏实参为 `4($t0)` |
| `macro-argument-count` | 错误 | 宏调用 | `src/language/mips/parser.ts` | 宏调用参数数量错误 |
| `operand-count` | 错误 | 指令 | `src/language/mips/instructionValidation.ts` | `add $t0, $t1` |
| `operand-type` | 错误 | 指令 | `src/language/mips/instructionValidation.ts` | 需要立即数却传入标签 |
| `memory-alignment` | 警告 | 指令 | `src/language/mips/instructionValidation.ts` | `lw $t0, 2($sp)` |
| `cp0-write` | 警告 | 课程 Lint | `src/language/mips/instructionValidation.ts` | `mtc0 $t0, 13` |
| `pseudo-instruction:<mnemonic>` | 信息 | 课程 Lint | `src/language/mips/instructionValidation.ts` | `pseudo-instruction:li` |
| `project-instruction` | 警告 | 课程 Profile | `src/language/mips/instructionValidation.ts` | 在非 P7 Profile 下使用 `eret` |
| `instruction-in-data` | 错误 | 结构 | `src/language/mips/parser.ts` | `.data` 中出现 `add` |
| `syscall-v0-uninitialized` | 警告 | 课程 Lint | `src/language/mips/parser.ts` | P2 中 `syscall` 前未写 `$v0` |
| `missing-syscall` | 警告 | 课程 Lint | `src/language/mips/parser.ts` | P2 文件没有 `syscall` |

## Verilog

| 代码 | 严重级别 | 层级 | 来源 | 触发示例 |
| --- | --- | --- | --- | --- |
| `syntax-unexpected-character` | 错误 | 词法 | `src/language/verilog/lexer.ts` | 非 Verilog 控制字符 |
| `syntax-unclosed-comment` | 错误 | 词法 | `src/language/verilog/lexer.ts` | `/*` |
| `syntax-unclosed-string` | 错误 | 词法 | `src/language/verilog/lexer.ts` | `"abc` |
| `syntax-malformed-number` | 错误 | 词法/表达式 | `src/language/verilog/syntaxParser.ts` | `4'b1020` |
| `syntax-module-declaration` | 错误 | 解析 | `src/language/verilog/syntaxDiagnostics.ts` | `module ;` |
| `syntax-unmatched-delimiter` | 错误 | 解析 | `src/language/verilog/syntaxDiagnostics.ts` | 多余的 `)` |
| `syntax-unclosed-delimiter` | 错误 | 解析 | `src/language/verilog/syntaxDiagnostics.ts` | 缺少 `]` |
| `syntax-unmatched-<end>` | 错误 | 解析 | `src/language/verilog/syntaxDiagnostics.ts` | 孤立 `endcase` |
| `syntax-unclosed-<block>` | 错误 | 解析 | `src/language/verilog/syntaxDiagnostics.ts` | `begin/case/generate/function/task` 缺少结束关键字 |
| `syntax-missing-semicolon` | 错误 | 解析 | `src/language/verilog/syntaxDiagnostics.ts` | 声明或 `assign` 缺少 `;` |
| `syntax-malformed-declaration` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `wire reg foo;` |
| `syntax-malformed-port-list` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | ANSI 端口列表缺少逗号 |
| `syntax-malformed-assignment` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `assign y = ;` |
| `syntax-malformed-instance` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `.a a` 或实例参数列表残缺 |
| `syntax-malformed-gate-primitive` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `not ;` |
| `syntax-malformed-procedural-block` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | 残缺 `always` 或 `initial` |
| `syntax-malformed-event-control` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `always @(posedge clk` |
| `syntax-malformed-if` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `if a)` |
| `syntax-malformed-case` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `case sel` |
| `syntax-malformed-for` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `for (i = ; i < 4; i = i + 1)` |
| `syntax-malformed-while` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `while a)` |
| `syntax-malformed-repeat` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `repeat ()` |
| `syntax-malformed-generate` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | generate-for 缺少 `begin : name` |
| `syntax-orphan-else` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `else y = 1;` 不在 `if` 后 |
| `syntax-orphan-default` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | `default: y = 1;` 不在 `case` 中 |
| `syntax-unexpected-token` | 错误 | 解析 | `src/language/verilog/syntaxParser.ts` | 模块作用域出现不支持的语句 |
| `syntax-unsupported-construct` | 信息 | 课程外语法 | `src/language/verilog/syntaxParser.ts` | `specify`、`primitive`、`defparam`、`fork`、`event`、`tri1`、驱动强度 |
| `missing-endmodule` | 错误 | 结构 | `src/language/verilog/diagnostics.ts` | 模块没有 `endmodule` |
| `duplicate-module` | 错误 | 结构/工作区 | `src/language/verilog/diagnostics.ts`, `src/language/verilog/workspaceDiagnostics.ts` | 重复模块名 |
| `missing-include` | 警告 | 预处理 | `src/language/verilog/diagnostics.ts` | ``include "missing.v"` |
| `unknown-port` | 错误 | 实例连接 | `src/language/verilog/instanceConnectionDiagnostics.ts` | `.bad(signal)` |
| `duplicate-port-connection` | 警告 | 实例连接 | `src/language/verilog/instanceConnectionDiagnostics.ts` | `.a(x), .a(y)` |
| `port-index-out-of-range` | 错误 | 实例连接 | `src/language/verilog/instanceConnectionDiagnostics.ts` | 位置端口数量超过目标模块端口数 |
| `missing-port:<port>` | 信息 | 实例连接 | `src/language/verilog/instanceConnectionDiagnostics.ts` | 命名连接未连接输入端口 |
| `port-width-mismatch` | 警告 | 实例连接/数据流 | `src/language/verilog/instanceConnectionDiagnostics.ts`, `src/language/verilog/diagnostics.ts` | 1 位端口连接 32 位信号 |
| `unknown-parameter` | 错误 | 参数覆盖 | `src/language/verilog/instanceConnectionDiagnostics.ts` | `#(.BAD(1))` |
| `duplicate-parameter-connection` | 警告 | 参数覆盖 | `src/language/verilog/instanceConnectionDiagnostics.ts` | `#(.W(1), .W(2))` |
| `parameter-index-out-of-range` | 错误 | 参数覆盖 | `src/language/verilog/instanceConnectionDiagnostics.ts` | 位置参数数量超过目标模块参数数 |
| `parameter-not-constant` | 警告 | 参数覆盖 | `src/language/verilog/instanceConnectionDiagnostics.ts` | 用普通信号覆盖 parameter |
| `parameter-width-mismatch` | 警告 | 参数覆盖 | `src/language/verilog/instanceConnectionDiagnostics.ts` | 4 位参数覆盖为 32 位表达式 |
| `width-mismatch` | 警告 | 数据流 | `src/language/verilog/diagnostics.ts` | 赋值或声明初始化发生截断 |
| `select-out-of-range` | 警告 | 数据流 | `src/language/verilog/diagnostics.ts` | `a[8]` 访问 4 位信号 |
| `constant-division-by-zero` | 警告 | 数据流 | `src/language/verilog/diagnostics.ts` | `a / 0` 或 `a % 0` |
| `implicit-net:<name>` | 可配置 | 语义 | `src/language/verilog/lintDiagnostics.ts` | 未声明标识符 `missing` |
| `explicit-port-wire` | 错误 | 语义 | `src/language/verilog/lintDiagnostics.ts` | ``default_nettype none` 下老式端口声明缺少 `wire` |
| `mixed-assignment` | 警告 | 赋值分析 | `src/language/verilog/lintDiagnostics.ts` | 同一信号混用 `=` 和 `<=` |
| `multi-driver` | 警告 | 驱动分析 | `src/language/verilog/driverDiagnostics.ts` | 连续赋值和实例输出同时驱动同一信号 |
| `unused-parameter` | 信息 | 使用分析 | `src/language/verilog/usageDiagnostics.ts` | parameter/localparam 从未被引用 |
| `unused-signal` | 信息 | 使用分析 | `src/language/verilog/usageDiagnostics.ts` | 内部 wire/reg/logic/time 未读写 |
| `uninstantiated-module` | 信息 | 工作区 | `src/language/verilog/workspaceDiagnostics.ts` | 模块未被索引到的层次实例化 |
| `missing-top` | 警告 | 课程 Profile | `src/language/verilog/diagnostics.ts` | P4-P7 找不到顶层模块 |
| `default-nettype-none` | 信息 | 课程 Lint | `src/language/verilog/diagnostics.ts` | 未写 ``default_nettype none` |
| `display-format` | 警告 | 课程 Profile | `src/language/verilog/diagnostics.ts` | P4/P5 `$display` trace 格式不匹配 |
| `p6-display`, `p7-display` | 错误 | 课程 Profile | `src/language/verilog/diagnostics.ts` | P6/P7 顶层设计中使用 `$display` |
| `p4-port` - `p7-port` | 错误 | 课程 Profile | `src/language/verilog/diagnostics.ts` | 顶层模块缺少课程要求端口 |
| `p4-port-width` - `p7-port-width` | 警告 | 课程 Profile | `src/language/verilog/diagnostics.ts` | 顶层端口位宽与课程要求不一致 |
| `project-pc-reset` | 信息 | 工作区 Profile | `src/language/verilog/workspaceDiagnostics.ts` | P4/P5 工作区未发现 `0x3000` 复位常量 |
| `project-im-size` | 信息 | 工作区 Profile | `src/language/verilog/workspaceDiagnostics.ts` | P4/P5 指令存储器深度不像 4096 字 |
| `project-dm-size` | 信息 | 工作区 Profile | `src/language/verilog/workspaceDiagnostics.ts` | P4/P5 数据存储器深度不像 3072 字 |
| `p7-module-cpu`, `p7-module-bridge`, `p7-module-tc`, `p7-module-cp0` | 警告 | 工作区 Profile | `src/language/verilog/workspaceDiagnostics.ts` | P7 工作区缺少关键模块 |
| `p7-instance-cpu`, `p7-instance-bridge`, `p7-instance-tc` | 信息 | 工作区 Profile | `src/language/verilog/workspaceDiagnostics.ts` | P7 关键模块存在但未明显实例化 |
| `p7-cp0-sr`, `p7-cp0-cause`, `p7-cp0-epc` | 警告 | 工作区 Profile | `src/language/verilog/workspaceDiagnostics.ts` | CP0 模块缺少关键寄存器 |
| `tb-timescale` | 信息 | 测试台 Lint | `src/language/verilog/lintDiagnostics.ts` | testbench 缺少 ``timescale 1ns / 1ps` |
| `tb-clock` | 信息 | 测试台 Lint | `src/language/verilog/lintDiagnostics.ts` | testbench 缺少自由运行时钟 |
| `tb-reset` | 信息 | 测试台 Lint | `src/language/verilog/lintDiagnostics.ts` | testbench 缺少 reset 逻辑 |
| `tb-readmemh` | 信息 | 测试台 Lint | `src/language/verilog/lintDiagnostics.ts` | testbench 未用 `$readmemh("code.txt", im)` |
| `synth-*` | 信息 | 可综合性提示 | `src/language/verilog/lintDiagnostics.ts` | `initial`、声明初始化、乘除取模 |
| `vc-001-*` 等 VC 子码 | 可配置 | 课程 Lint | `src/language/verilog/lintDiagnostics.ts`, `src/language/verilog/dataflowDiagnostics.ts` | 课程风格、组合/时序逻辑规则；基础规则见下表 |
| `ise-syntax` | 错误/警告/信息 | 外部 ISE | `src/language/verilog/iseSyntaxCheck.ts` | ISE fuse 输出的语法诊断 |

### Verilog 课程 Lint 规则目录

<!-- generated:verilog-lint-rules:start -->

可配置 VC 规则和可综合性提示规则由 `resources/verilog/lintRules.json` 生成。

可配置规则 ID：`vc-001`, `vc-002`, `vc-003`, `vc-004`, `vc-005`, `vc-006`, `vc-007`, `vc-008`, `vc-009`, `vc-010`, `vc-011`, `vc-012`, `vc-013`, `vc-014`, `vc-015`, `vc-017`, `vc-021`。

| 代码 | 严重级别 | 默认 | 可配置 | 标题 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `vc-001` | 信息 | 禁用 | 是 | 信号命名风格 | 信号名应保持一种可识别且一致的命名风格。 |
| `vc-002` | 信息 | 启用 | 是 | 低有效后缀 | 低有效信号名应使用 _n 后缀。 |
| `vc-003` | 信息 | 禁用 | 是 | 多路选择器命名 | 多路选择器信号名应体现位宽或输入数量。 |
| `vc-004` | 信息 | 禁用 | 是 | 魔数 | 将缺少说明的数字字面量替换为 localparam、parameter 或宏。 |
| `vc-005` | 警告 | 启用 | 是 | 多个 always 驱动 | 避免在多个 always 块中给同一个信号赋值。 |
| `vc-006` | 警告 | 启用 | 是 | 组合逻辑敏感列表 | 组合逻辑应使用 always @(*) 或 assign。 |
| `vc-007` | 警告 | 启用 | 是 | 组合逻辑阻塞赋值 | 组合逻辑 always 块应使用阻塞赋值。 |
| `vc-008` | 信息 | 禁用 | 是 | 组合逻辑完备性 | 组合逻辑分支和 case 语句应覆盖每条输出赋值路径。 |
| `vc-009` | 警告 | 启用 | 是 | 时序逻辑 posedge | 时序逻辑应使用 always @(posedge clock)。 |
| `vc-010` | 警告 | 启用 | 是 | 时序逻辑非阻塞赋值 | 时序逻辑 always 块应使用非阻塞赋值。 |
| `vc-011` | 警告 | 启用 | 是 | negedge 触发 | 除非协议需要，否则避免使用 negedge 触发逻辑。 |
| `vc-012` | 警告 | 启用 | 是 | 边沿触发信号类型 | 边沿触发敏感信号应为时钟或复位。 |
| `vc-013` | 信息 | 启用 | 是 | 时钟作为数据 | 时钟信号不应在时序逻辑中作为普通数据使用。 |
| `vc-014` | 信息 | 启用 | 是 | 同步复位偏好 | 当敏感列表中出现异步复位时，优先考虑同步复位写法。 |
| `vc-015` | 警告 | 启用 | 是 | 内部 inout 端口 | 内部模块应避免使用 inout 端口。 |
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

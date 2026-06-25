# CO 课程子集 + 常见误写完整覆盖执行计划书

本文档规划插件内置语法/诊断能力的下一阶段建设目标：在不调用 ISE 的前提下，完整覆盖 BUAA CO 课程中实际会写到的 MIPS ASM、Verilog 结构诊断，并系统覆盖学生常见误写

## 1. 目标

### 1.1 总目标

把当前“已覆盖大量高频错误”的内置诊断，推进到“课程子集内可作为第一道可靠语法防线”的程度：

- 课程支持范围内的合法代码不误报语法错误
- 课程支持范围内的常见语法错误必须有稳定、准确、可定位的诊断
- 不依赖 ISE 也能完成 Problems 面板中的基础语法诊断
- 诊断结果可通过测试用例、错误码目录和覆盖矩阵持续维护

### 1.2 非目标

- 不实现完整 Verilog-2001/SystemVerilog 编译器
- 不在编辑器实时诊断路径调用 ISE、ISim、MARS、Logisim 或 Hazard Analyzer
- 不做 CPU 功能正确性证明；本计划只覆盖语法、结构、静态形态和课程常见误用
- 不把所有合法但课程外的 Verilog 构造都提升到完整支持。课程外构造应被明确分类为“支持解析”“降级为信息提示”或“课程外不支持”，避免混成普通语法错误

## 2. 范围定义

### 2.1 MIPS ASM 支持范围

文件类型：

- `.asm`
- `.s`
- `.mips`

课程子集：

- MARS 常用 MIPS 指令和插件资源表中的 114 条 instruction。
- 插件资源表中的 20 条 directive。
- MARS 常用伪指令、扩展立即数形式和课程测试常用 trap/CP0 指令。
- 标签、data symbol、`.eqv`、`.macro`、`.end_macro`、宏参数、宏调用。
- `.text/.data/.ktext/.kdata` 段切换及课程固定地址约束。
- 字符串、字符、整数、浮点、label + immediate、memory operand。
- P2-P7 相关课程提示，例如 syscall、CP0、伪指令、section 地址等。

课程外或降级处理：

- MARS 非常用 directive 若不在资源表中，继续作为未知 directive。
- 宏展开后的精确 assembler 语义不在实时诊断中执行，但应通过静态规则尽量贴近 MARS。
- 与运行时行为相关的问题只做提示，不作为语法错误。

### 2.2 Verilog 支持范围

文件类型：

- `.v`

课程子集：

- 模块声明、ANSI/legacy 端口声明、参数列表。
- `input/output/inout/wire/reg/logic/integer/time/real/realtime/genvar/parameter/localparam` 等课程常见声明。
- packed width、unpacked dimension、initializer。
- continuous assign、procedural blocking/nonblocking assign。
- `always`、`initial`、event control、delay control。
- `begin/end`、`if/else`、`case/casex/casez/default/endcase`。
- `for/while/repeat/forever` 的课程常见形态。
- function/task 的声明、局部声明和过程体。
- module instance，含 named/positional port connection、parameter override。
- built-in gate primitives。
- expression 子集：一元/二元/三元、拼接、重复拼接、函数调用、系统函数、bit/range/indexed part-select。
- 常见预处理：``define``、``include``、``default_nettype``、宏引用的保守识别。
- 课程常见 `generate for` 形态，至少做到结构识别、实例/assign 收集、缺失 `endgenerate/end` 诊断。

课程外或降级处理：

- `specify/primitive/defparam/fork/event` 继续视为课程外构造，但诊断级别应避免误导为普通语法错误。
- `tri/tri1/wand/wor`、drive strength assign 等合法 Verilog 但课程外写法，需要明确策略：可以提示“课程外/不建议”，不应无条件当作语法错误污染普通课程代码。
- SystemVerilog 专属语法，如 `always_ff`、interface、typedef、enum、struct、package，不纳入本阶段完整支持。

## 3. 当前基线

### 3.1 已有能力

MIPS：

- 已有 AST 主路径和 typed operand。
- 已覆盖未知指令、未知 directive、操作数数量/类型、未知寄存器、重复符号、未声明符号、宏、`.eqv`、段约束、部分课程规则。
- 指令格式来自资源表，具备继续扩大测试覆盖的基础。

Verilog：

- 已有 lexer、statement source、AST、expression AST、procedural AST、semantic model。
- 已覆盖词法错误、模块声明、括号/块平衡、缺分号、声明、assign、实例、过程块、部分表达式、端口连接、宽度、隐式线网、课程 lint、跨文件诊断。
- 近期架构已明显从 token fallback 迁移到 AST，有利于继续系统化。

### 3.2 当前关键缺口

MIPS：

- 宽松 tokenizer 会记录 unknown token，但缺少统一 lexical diagnostic
- 无 executable 的坏行可能被忽略，例如 `@`、单独 `:`、`1bad: nop`
- 空 data directive 在文件末尾没有续行时可能漏报，例如 `.word`、`.asciiz`
- 未闭合字符串/字符、非法转义、坏 label 结构缺少统一错误恢复
- 缺少按资源表自动生成的全 instruction 格式正反例矩阵

Verilog：

- 当前不是 grammar-first parser，一些过程语句只做浅检查
- `for` 只检查分号数量，不充分验证三段表达式
- `generate for` 有局部 AST 支撑，但 syntax diagnostics 仍可能把内部 `for/begin/end` 当模块级异常 token
- 声明类型集合偏窄，合法但课程外的 net type/drive strength 容易被当成语法错误
- 预处理只做保守识别，不做宏展开，因此宏影响结构时仍可能误报
- 错误码和覆盖矩阵没有集中目录，维护时难判断“哪些错误已承诺覆盖”

## 4. 设计原则

1. 先定义支持边界，再补实现
2. 诊断分层：词法、语法、结构、语义、课程 lint 不混用错误码
3. 对课程外合法语法，不需要完整支持，但也不轻易报 syntax error
4. 每个诊断必须有稳定错误码、稳定 range、至少一个正例和一个反例
5. 错误恢复优先于完美 AST：一个错误不应吞掉后续整文件诊断
6. 性能优先保持当前实时体验：本地诊断仍走缓存和 debounce，不引入外部工具
7. 每批完成一定量功能或 bug 修复后提交规范 commit

## 5. 诊断分层模型

### 5.1 通用层级

- Lexical：未知字符、未闭合注释/字符串、坏数字、坏字符字面量
- Parse：缺关键 token、非法 token 顺序、括号/块不平衡、语句切分失败
- Structural：模块/宏/段/声明/实例/过程块等结构缺失或重复
- Semantic：符号解析、重复定义、未声明引用、宽度、端口连接
- Course Lint：课程风格、profile 约束、测试输出格式、可综合提示

### 5.2 错误码规范

建议按语言分前缀：

- MIPS 词法：`mips-lex-*`
- MIPS 语法：`mips-syntax-*`
- MIPS directive：`mips-directive-*`
- MIPS 指令：继续兼容现有 `operand-*`，新码可逐步前缀化
- Verilog 词法：沿用 `syntax-unclosed-string` 等，或逐步补 `verilog-lex-*` alias
- Verilog 语法：继续沿用 `syntax-*`，但要建立 catalog
- 课程 lint：继续使用 `vc-xxx-*`。

短期不要求重命名全部历史 code，避免破坏用户禁用配置；新文档需要记录兼容 code

## 6. 功能条目

### 6.1 MIPS-Lex-001：未知字符诊断

状态：✅ 已完成（`mips-lex-unknown-token`、`mips-lex-char-literal`、`mips-lex-unclosed-char`、`mips-lex-unclosed-string`、`mips-lex-string-escape` 已接入 `parseMips`，并由 parser/fixture 测试覆盖）

目标：

- 对 tokenizer 产出的 `unknown` token 统一报错
- 覆盖 `@`、反引号、非法 Unicode 控制字符、孤立 `%`、孤立 `$` 等

验收：

- `@` 在 Problems 中出现错误
- 合法 `$t0`、`%arg`、字符串内特殊字符不误报
- 后续同文件合法指令仍能继续诊断

涉及模块：

- `src/language/mips/syntax.ts`
- `src/language/mips/parser.ts`
- `src/test/language/mips/parser.test.ts`

### 6.2 MIPS-Line-001：坏行结构诊断

状态：✅ 已完成（无 executable 的坏行、错位冒号、非法 label 结构统一报 `mips-syntax-line`，并保持 `a: b: nop` 合法）

目标：

- 无 executable 但有非空 code/token 的 statement 不再静默通过
- 覆盖单独 `:`、`1bad: nop`、`$t0:`、多个冒号错位、标签后非法 token

验收：

- 坏行报 `mips-syntax-line` 或等价错误码
- `a: b: nop` 继续合法
- data label 与 instruction label 保持现有规则

### 6.3 MIPS-Literal-001：字符串和字符字面量完整性

状态：✅ 已完成（未闭合字符串/字符、非法字符串转义、空字符、多字符和非法字符字面量均有稳定诊断；坏字符不再派生 undeclared symbol 噪音）

目标：

- 未闭合字符串、未闭合字符、非法转义、空字符、多字符字面量均有稳定诊断
- 字符串内 `#`、转义引号、末尾反斜杠按 MARS 常见规则处理

验收：

- `.asciiz "abc` 报未闭合字符串
- `.byte '\x'` 报坏字符字面量，不额外泄漏 undeclared symbol
- `.asciiz "\\\\"# comment` 不误报

### 6.4 MIPS-Directive-001：空操作数与续行终结

状态：✅ 已完成（`.byte/.half/.word/.float/.double/.ascii/.asciiz` 空头部支持续行；EOF、新 label、新 directive 或新 section 终结时报告 `directive-operand-count`）

目标：

- 支持 MARS data directive 续行，同时在没有实际续行时报告缺操作数
- 覆盖 `.word`、`.byte`、`.half`、`.float`、`.double`、`.ascii`、`.asciiz`

验收：

- 文件末尾 `arr: .word` 报缺操作数
- `.word` 后下一行 `1, 2` 继续合法
- 遇到新 label、新 directive、新 section 时能判断上一条 directive 已终结

### 6.5 MIPS-Directive-002：directive 参数矩阵

状态：✅ 已完成（`parser.test.ts` 新增 20 条 directive 的参数矩阵正/反例；`.include/.extern/.globl/.align/.space` 均有边界覆盖）

目标：

- 为 20 条 directive 建立参数数量、类型、允许 section、课程约束矩阵
- 将现有规则补成表驱动或集中 catalog

验收：

- 每条 directive 至少一个合法例、一个非法例
- `.include`、`.extern`、`.globl`、`.align`、`.space` 有边界测试

### 6.6 MIPS-Instruction-001：全 instruction 格式覆盖

状态：✅ 已完成（`instructionValidation.test.ts` 从 `resources/mips/instructions.json` 自动生成 114 条 instruction 至少一个正例，并覆盖所有声明 format；寄存器/立即数/label/memory/shamt/CP0 常见错误有稳定负例）

目标：

- 从 `resources/mips/instructions.json` 生成或手写覆盖每条 instruction 的格式测试
- 对每个 operand pattern 设正例和负例

验收：

- 114 条 instruction 均有至少一个合法格式用例
- 常见 operand 类型错误能稳定报错：register/immediate/label/memory/shamt/cp0
- 伪指令信息提示不干扰语法 error 断言

### 6.7 MIPS-Macro-001：宏完整性

状态：✅ 已完成（现有 parser/semantic/real-project 测试覆盖 `.macro` header、参数、重复参数、嵌套宏、缺 `.end_macro`、实参数量、宏参数 operand、宏局部 label/data label 作用域与非法 memory 实参）

目标：

- 覆盖 `.macro` header、参数命名、重复参数、嵌套宏、缺 `.end_macro`、调用实参数量和非法实参。

验收：

- 宏内部 label/data label 作用域不误报重复。
- 宏参数可作为指令 operand 和 directive operand。
- 非法 memory operand 作为宏参数时按 MARS 规则提示。

### 6.8 MIPS-Semantic-001：符号解析边界

状态：✅ 已完成（parser/semantic 测试覆盖 label、data symbol、`.eqv`、宏局部符号、forward reference、label+immediate、memory offset 符号解析，并验证坏字符 literal 不派生 undeclared symbol 噪音）

目标：

- 补齐 label、data symbol、`.eqv`、宏局部符号、forward reference 的正反例。
- 减少坏语法导致的二次 undeclared symbol 噪音。

验收：

- 一个坏字符字面量不会再派生多个无意义 symbol 错误。
- label+immediate、memory offset 中的符号能正确解析。

### 6.9 Verilog-Lex-001：词法稳定性

状态：✅ 已完成（`syntaxDiagnostics.test.ts` 补充 escaped identifier、system identifier、directive、based literal 边界；`4'b1020` 稳定报 `syntax-malformed-number`，`4'hxxzz`、`'hff`、`32'h0000_7f00` 通过）

目标：

- 保持并扩展未闭合注释、未闭合字符串、异常字符、坏数字诊断。
- 补充 escaped identifier、system identifier、directive、based literal 的边界测试。

验收：

- `4'b1020`、`4'hxxzz`、`'hff`、`32'h0000_7f00` 分别按预期报错或通过。
- 未闭合字符串不会吞掉后续整文件诊断。

### 6.10 Verilog-Preproc-001：预处理课程子集

状态：✅ 已完成（`syntaxDiagnostics.test.ts` 覆盖 ``default_nettype none``、``include "missing.v"``、``define WIDTH 32`` 与 ``WIDTH-1:0``；默认线网、缺 include warning、宏宽度表达式均按静态子集处理）

目标：

- 明确支持 ``include``、``define``、``default_nettype`` 的静态识别。
- 对宏引用采取保守策略：不完整展开，但避免把常见宏形态误判为普通语法错误。

验收：

- ``default_nettype none`` 能被识别并影响 implicit net 提示。
- ``include "x.v"`` 缺文件继续 warning。
- 常见 ``define WIDTH 32``、``WIDTH-1:0`` 不误报表达式语法错误。

### 6.11 Verilog-Module-001：模块头完整性

状态：✅ 已完成（现有 parser/syntax 测试覆盖空端口、legacy、ANSI、参数化模块头；`syntaxDiagnostics.test.ts` 覆盖缺分号、缺逗号、端口缺名、参数化 header 正例）

目标：

- 完整覆盖课程常见模块声明：
  - `module m;`
  - `module m(a, b);`
  - `module m(input clk, output reg y);`
  - `module m #(parameter WIDTH = 32) (...);`

验收：

- 缺模块名、缺分号、端口列表缺逗号、端口缺名字、参数列表括号不闭合均稳定报错。
- legacy 和 ANSI 风格不互相误报。

### 6.12 Verilog-Decl-001：声明语法矩阵

状态：✅ 已完成（module/procedural 声明已有 parser/syntax 入口覆盖；`wire reg foo`、`input output bar` 稳定报 `syntax-malformed-declaration`；`tri/tri1/wand/wor` 等课程外 net type 降级为 wire-like declaration + course-out 信息）

目标：

- 覆盖 module scope 和 procedural scope 的声明。
- 明确课程支持类型与课程外类型的处理策略。

验收：

- `wire/reg/logic/integer/genvar/parameter/localparam` 正常通过。
- `wire reg foo;`、`input output bar;` 报 malformed declaration。
- `tri1` 等合法但课程外 net type 不应伪装成“未知 token”；应按策略提示课程外或降级忽略。

### 6.13 Verilog-Expr-001：表达式完整性

状态：✅ 已完成（expression AST 已接入 assign、initializer、width/select、case label、event/loop control、instance/gate 入口；`syntaxDiagnostics.test.ts` 覆盖缺 operand、空括号、坏 select、坏三元、额外 token 与函数/系统函数正例）

目标：

- 将 expression AST 错误用于所有表达式入口：assign、initializer、width、select、case label、event control、for control、instance connection。
- 补齐空括号、缺 operand、尾随 token、嵌套 delimiter、三元表达式缺分支等错误。

验收：

- `assign y = (a +);`
- `assign y = ();`
- `assign y = a[];`
- `assign y = a ? ;`
- `assign y = a b;`

以上均有稳定语法错误。

### 6.14 Verilog-Assign-001：赋值语句完整性

状态：✅ 已完成（continuous/procedural assign 共用 assignment parser；缺 lhs/rhs、缺分号、额外 token、比较运算符边界均由 `syntaxDiagnostics.test.ts` 覆盖，drive-strength assign 进入 course-out 降级路径）

目标：

- continuous assign 和 procedural assign 统一复用 assignment parser。
- 覆盖缺 lhs、缺 rhs、缺分号、额外 token、比较运算符误识别等。

验收：

- `assign = a;` 报缺 lhs。
- `assign y = ;` 报缺 rhs。
- `assign a b = c;` 报表达式或 assign 结构错误。
- `assign y = a <= b;` 不被误认为两个赋值。

### 6.15 Verilog-Procedural-001：过程语句 grammar

状态：✅ 已完成（`if/case/default` 保持结构诊断；`for` 三段控制现在验证赋值/表达式形态，`for (i = ; ...)` 稳定报 `syntax-malformed-for`；`while/repeat` 缺括号或空表达式分别报 `syntax-malformed-while/repeat`；空 for condition 按合法 Verilog 放行）

目标：

- 对 `if/else`、`case/default`、`for/while/repeat/forever` 从浅 token 检查升级为结构检查。
- `for` 必须验证 init/condition/step 的表达式或赋值形态。

验收：

- `if a) begin` 报缺左括号。
- 孤立 `else` 报 orphan else。
- `default` 出现在 case 外时报错。
- `for (i = ; i < 4; i = i + 1)` 报 init 缺 rhs。
- `for (i = 0; ; i = i + 1)` 根据课程策略决定允许或提示空 condition。

### 6.16 Verilog-Block-001：块和分隔符恢复

状态：✅ 已完成（begin/end、case/endcase、generate/endgenerate、function/endfunction、task/endtask 均由 syntax/task/function/generate 测试覆盖；缺失或多余 block token 使用稳定 range 并保持后续模块解析）

目标：

- 统一 begin/end、case/endcase、generate/endgenerate、function/endfunction、task/endtask 的配对逻辑。
- 避免一个缺 `end` 导致后续模块级大量误报。

验收：

- 缺 `end`、多余 `end`、缺 `endcase`、多余 `endmodule` 都有准确 range。
- 第二个 module 仍能被解析并继续诊断。

### 6.17 Verilog-Generate-001：课程常见 generate 支持

状态：✅ 已完成（`generate_for` snippet 已新增；syntax parser 识别 generate block 范围，generate-for 正例不再产生 module-scope syntax error，缺 named block 报 `syntax-malformed-generate`，内部 assign/instance 继续复用原有 AST/语法路径）

目标：

- 支持最常见 generate-for：
  - `genvar i;`
  - `generate for (...) begin : name ... end endgenerate`
- 在 generate 内继续识别 assign、instance、gate primitive。

验收：

- 插件自带 `generate_for` snippet 生成的代码不报 syntax error。
- 缺 `endgenerate`、缺 named block、for control 错误能定位。
- generate 内实例能进入 workspace/module connection 分析。

### 6.18 Verilog-Instance-001：实例化完整性

状态：✅ 已完成（`syntaxDiagnostics.test.ts` 覆盖 named/positional/empty connection、参数化实例、缺逗号、`.a a` 等 malformed connection；AST/workspace 测试继续覆盖实例连接语义）

目标：

- 覆盖普通实例、参数化实例、多个实例、named/positional 混用策略、空连接、缺逗号。

验收：

- `.a(a) .b(b)` 报缺逗号。
- `.a a` 报 named connection 必须括号。
- `child #(.W(4)) u (...);` 通过。
- `child u0(...), u1(...);` 按课程策略支持或给明确 unsupported 提示。

### 6.19 Verilog-Gate-001：门级 primitive

状态：✅ 已完成（gate primitive helper 已被 AST 和 syntax diagnostics 共享；`syntaxDiagnostics.test.ts`/parser 测试覆盖 primitive 多实例、端口列表缺失/不闭合、端口表达式 AST）

目标：

- 保持 `and/or/not/nand/nor/xor/xnor/buf` 等 primitive 支持。
- 端口表达式进入 expression AST 和 reference collection。

验收：

- `not (nx0, x[0]), (nx1, x[1]);` 通过。
- 缺端口列表、端口列表不闭合、端口表达式坏语法报错。

### 6.20 Verilog-TaskFunc-001：task/function 子集

状态：✅ 已完成（`taskDeclarations.test.ts`、`semanticModel.test.ts` 和 `syntaxDiagnostics.test.ts` 覆盖 task/function 声明、参数/局部符号、调用解析、`zero()` 函数调用和 block 配对）

目标：

- 支持课程常见 task/function 声明、参数/局部声明、赋值和调用表达式。
- function/task body 使用 procedural parser。

验收：

- 缺 `endfunction/endtask` 报错。
- header 缺分号报错。
- 函数调用 `zero()` 不误报。

### 6.21 Verilog-CourseOut-001：课程外合法构造分类

状态：✅ 已完成（`tri/tri0/tri1/supply0/supply1/wand/wor/triand/trior/trireg` 按 wire-like declaration 解析并报 `syntax-unsupported-construct` 信息；drive-strength assign 降级为 course-out 信息，不再混成普通 malformed assignment）

目标：

- 建立课程外 Verilog 构造清单，决定每类行为：
  - 支持解析但提示不推荐。
  - 信息级 unsupported。
  - 明确 syntax error。

候选条目：

- `tri/tri1/supply0/supply1/wand/wor`
- drive strength assign
- `specify/primitive/table`
- `defparam`
- `fork/join`
- `event`
- SystemVerilog constructs

验收：

- 合法课程外代码不再出现误导性的“unexpected token at module scope”，而是稳定的课程外提示。
- 真正错误仍保留 syntax error。

### 6.22 Shared-Diagnostic-001：错误码 catalog

状态：✅ 已完成（新增 `docs/diagnostic-catalog.md` 初版，记录新增 `mips-lex-*`、`mips-syntax-line` 及现有 MIPS/Verilog 主要 code；保留历史 code 兼容禁用配置）

目标：

- 新增诊断 catalog 文档或测试 fixture，列出 code、severity、来源层级、示例、是否可禁用。

验收：

- 每个新增错误码都能在 catalog 找到。
- 用户已有 `co.diagnostics.disabledCodes` 不被破坏。

### 6.23 Shared-Test-001：课程语法样例库

状态：✅ 已完成（新增 `src/test/fixtures/syntax/...` 与 `src/test/language/syntaxFixtures.test.ts`；valid/invalid/course-out 样例分别断言无 syntax 阻塞、具体 code/行号、course-out 不混为 syntax error）

目标：

- 建立 `src/test/fixtures/language/...` 或等价 fixture 目录。
- 分为 valid、invalid、course-out、real-project-patterns。

验收：

- valid 样例不出现 `syntax-*` 错误。
- invalid 样例断言具体 code 和行号。
- course-out 样例断言 warning/info，不混为 syntax error。

### 6.24 Shared-Perf-001：性能保护

状态：✅ 已完成（新增 `src/test/language/verilog/performance.test.ts`，生成 2000+ 行课程常见 Verilog 设计，走 `getVerilogDiagnostics` 真实入口并验证无 syntax 误报、默认 4000ms 性能预算和同版本 parse cache 复用；预算可用 `CO_VERILOG_PERF_BUDGET_MS` 覆盖）

目标：

- 为大文件、连续输入、workspace 多文件索引建立性能基线。
- 诊断不调用外部工具，保持缓存和 debounce。

验收：

- 常见 2k 行 Verilog 文件单次本地诊断在可接受范围内。
- 快速编辑时不会每次按键重复全量昂贵分析。
- workspace index 改动不阻塞编辑器响应。

## 7. 阶段计划

### 阶段 0：边界冻结和覆盖矩阵

状态：✅ 已完成（新增 `docs/syntax-coverage-matrix.md`、`docs/diagnostic-catalog.md` 和 `src/test/fixtures/syntax/...` 目录结构；后续功能项会继续扩展矩阵内容）

任务：

- [x] 写出 MIPS directive/instruction/profile 覆盖矩阵。
- [x] 写出 Verilog grammar subset 覆盖矩阵。
- [x] 建立诊断错误码 catalog 初版。
- [x] 将课程外 Verilog 构造分级。

交付：

- [x] 覆盖矩阵文档。
- [x] catalog 初版。
- [x] 首批 fixture 目录结构。

### 阶段 1：MIPS 词法和坏行兜底

状态：✅ 已完成

任务：

- [x] unknown token 诊断。
- [x] 坏 label/坏行结构诊断。
- [x] 未闭合字符串/字符诊断。
- [x] 空 data directive 续行终结检查。

交付：

- [x] MIPS lexer/line 层测试。
- [x] 修复 `@`、单独 `:`、`1bad: nop`、末尾空 `.word/.asciiz` 漏报。

### 阶段 2：MIPS 全资源格式覆盖

状态：✅ 已完成

任务：

- [x] 生成或补全 114 条 instruction 正例。
- [x] 为 operand pattern 建负例。
- [x] 补齐 20 条 directive 参数测试。
- [x] 清理坏语法派生的二次噪音。

交付：

- [x] MIPS instruction/directive 覆盖矩阵基本完成。
- [x] `npm test -- src/test/language/mips` 通过。

### 阶段 3：Verilog 语法 catalog 和回归样例

状态：✅ 已完成

任务：

- [x] 整理当前 `syntax-*` code。
- [x] 将已有 syntax diagnostics 测试扩成 fixture 矩阵。
- [x] 标注课程外合法构造的期望行为。

交付：

- [x] Verilog syntax coverage matrix。
- [x] valid/invalid/course-out 样例初版。

### 阶段 4：Verilog 表达式、assign、过程语句补强

状态：✅ 已完成

任务：

- [x] expression AST 入口补齐。
- [x] continuous/procedural assignment 统一错误处理。
- [x] `for/while/repeat/forever` 深化检查。
- [x] `if/case/default` 错误恢复补强。

交付：

- [x] 常见误写完整覆盖第一版。
- [x] `for (i = ; ...)` 等当前漏报修复。

### 阶段 5：Verilog generate、task/function、课程外分类

状态：✅ 已完成

任务：

- [x] generate-for 结构识别和诊断。
- [x] generate 内 assign/instance 收集。
- [x] task/function header/body 诊断补齐。
- [x] 课程外合法构造从 syntax error 降级到稳定提示。

交付：

- [x] 插件 snippet `generate_for` 生成代码不报 syntax error。
- [x] `tri1`、drive strength 等按策略处理。

### 阶段 6：集成、性能和用户体验

状态：✅ 已完成

任务：

- [x] 错误码 catalog 与禁用配置联动检查。
- [x] Range 精度回归。
- [x] 大文件性能测试。
- [x] README 或 docs 中补充“内置诊断覆盖边界”。

交付：

- [x] 覆盖边界文档。
- [x] 全量测试通过。
- [x] 性能基线记录。

## 8. 测试策略

### 8.1 单元测试

MIPS：

- `syntax.ts`：token、literal、comment、string/char。
- `parser.ts`：line、directive、macro、symbol、section。
- `instructionValidation.ts`：operand pattern、pseudo、profile。

Verilog：

- `lexer.ts`：token 和 lexical diagnostics。
- `exprAst.ts`：表达式 parse 和 malformed expression。
- `syntaxParser.ts`：模块项、声明、assign、实例、过程语句。
- `proceduralAst.ts`：if/case/loop/block。
- `astParser.ts`：module、ports、declarations、instances、generate。

### 8.2 Fixture 测试

建议目录：

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

每个 invalid fixture 配套期望：

```json
{
  "diagnostics": [
    { "code": "syntax-malformed-assignment", "line": 3 }
  ]
}
```

### 8.3 回归测试

每次新增一类错误：

- 至少 1 个 valid 反误报用例。
- 至少 1 个 invalid 命中用例。
- 至少 1 个错误恢复用例，确保后续语句仍被诊断。

### 8.4 性能测试

建立三类样例：

- 小文件：100 行以内。
- 中文件：500-1000 行。
- 大文件：2000-5000 行，含多个 module。

指标：

- 单文件诊断耗时。
- workspace index rebuild 耗时。
- 连续编辑时重复解析次数。

## 9. 验收标准

### 9.1 功能验收

MIPS：

- 支持范围内所有 directive 均有参数/section/类型检查。
- 资源表中所有 instruction 至少有格式正例。
- 常见坏行、坏 token、坏 literal、空 directive 不再漏报。
- 宏、`.eqv`、label/data symbol 作用域稳定。

Verilog：

- 课程常见 valid 样例无 `syntax-*` 错误。
- 常见 invalid 样例均命中稳定 code。
- generate-for、task/function、instance、assign、procedural control 达到课程可用。
- 课程外合法构造有明确分类，不再混成普通语法错误。

Shared：

- 每个新增 code 有 catalog。
- 禁用诊断配置仍有效。
- 全量测试通过。
- 不调用 ISE 完成内置诊断。

### 9.2 质量验收

- 新增逻辑遵循现有 AST/parse cache 架构。
- 不把所有规则堆在单文件里；按 lexer/parser/AST/diagnostics 分层。
- 错误恢复不制造大量重复噪音。
- 性能不明显退化。

## 10. 风险和应对

### 10.1 Verilog grammar 膨胀

风险：

- 手写 parser 很容易逐步变成半个 Verilog 编译器。

应对：

- 冻结课程子集。
- 对课程外合法构造做分类提示。
- 每次新增 grammar 前要求 fixture 证明其属于课程高频场景。

### 10.2 宏和预处理导致误报

风险：

- 不展开宏时，结构宏可能破坏 parser 判断。

应对：

- 对常见宏表达式和常量宏做保守识别。
- 对会改变结构的宏，优先降低诊断置信度，避免强报 syntax error。

### 10.3 错误恢复噪音

风险：

- 一个缺括号可能导致大量后续错误。

应对：

- 每个 parser 层维护同步点，例如 `;`、`end`、`endmodule`。
- 对同一行同一结构做 dedupe。
- 测试必须包含 cascading error 场景。

### 10.4 与现有禁用配置兼容

风险：

- 重命名 code 会破坏用户禁用规则。

应对：

- 尽量保留历史 code。
- 新 code 建 catalog。
- 如必须迁移，保留 alias 或文档说明。

## 11. 推荐提交粒度

每完成一批功能或 bug 修复后提交：

1. `docs: define built-in syntax coverage plan`
2. `fix(mips): report lexical and malformed line diagnostics`
3. `fix(mips): validate unterminated data directives`
4. `test(mips): cover instruction and directive syntax matrix`
5. `fix(verilog): tighten procedural syntax diagnostics`
6. `fix(verilog): support course generate-for diagnostics`
7. `fix(verilog): classify course-out constructs`
8. `test(verilog): add syntax fixture coverage`
9. `docs: document built-in diagnostic boundaries`

## 12. 优先级排序

最高优先级：

- MIPS unknown token/坏行/空 directive 漏报。
- Verilog `for`、assign、表达式缺 operand 漏报。
- generate-for snippet 自身不应产生 syntax error。
- 错误码 catalog 和 fixture 机制。

中优先级：

- 全 instruction/directive 矩阵。
- task/function 深化。
- 课程外合法 Verilog 构造分类。

低优先级：

- `.circ` Problems 面板增强。
- SystemVerilog 兼容提示。
- 更复杂的宏展开。

## 13. 完成后的用户体验

完成后，用户在不配置 ISE 的情况下，应能获得以下体验：

- 写 MIPS ASM 时，明显拼写、字面量、标签、directive、指令格式错误能即时定位。
- 写 CO 课程 Verilog 时，模块、端口、声明、assign、always、case、for、实例连接等常见错误能即时定位。
- 合法课程代码不会被大量“课程外标准 Verilog”误报干扰。
- 对课程外写法，插件会明确告诉用户“这是课程外/不建议/未完整支持”，而不是模糊地报 unexpected token。
- ISE 仍可作为手动或保存后外部检查增强，但内置诊断本身已经能覆盖课程子集的主要语法错误。

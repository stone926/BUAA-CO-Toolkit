# 内置语法覆盖矩阵

本矩阵描述插件本地 MIPS 与 Verilog 解析器当前覆盖的课程子集。它同时记录“已支持语法”和“课程外语法的处理方式”，用于避免后续 parser 改动把合法课程代码误报为语法错误。

## MIPS ASM

### 伪指令

| 伪指令 | 操作数 | 所属段 | 当前状态 | 主要诊断 |
| --- | --- | --- | --- | --- |
| `.data` | 可选地址 | 任意 | 支持；课程自动测试只接受地址 `0` | `directive-operand`, `co-section-address`, `section-address-range` |
| `.text` | 可选地址 | 任意 | 支持；自定义地址会按课程测试风险报错 | `directive-operand`, `co-section-address`, `section-address-range` |
| `.kdata` | 可选地址 | 任意 | 支持 | `directive-operand` |
| `.ktext` | 可选地址 | 任意 | 支持；当前不触发 `co-section-address` | `directive-operand` |
| `.word` | 整数、字符、标签、`值:重复次数` | data | 支持，支持续行 | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.half` | 整数、字符、`值:重复次数` | data | 支持，支持续行 | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.byte` | 整数、字符、`值:重复次数` | data | 支持，支持续行 | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.float` | 浮点数、字符、`值:重复次数` | data | 支持，支持续行 | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.double` | 浮点数、字符、`值:重复次数` | data | 支持，支持续行 | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.space` | 一个非负整数或字符字面量 | data | 支持；非 4 字节倍数给课程提示 | `directive-segment`, `directive-operand-count`, `directive-operand`, `space-alignment` |
| `.ascii` | 字符串列表 | data | 支持，支持续行 | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.asciiz` | 字符串列表 | data | 支持，支持续行 | `directive-segment`, `directive-operand-count`, `directive-operand` |
| `.align` | 一个非负整数或字符字面量 | data | 支持；大于 3 给课程提示 | `directive-segment`, `directive-operand-count`, `directive-operand`, `align-large` |
| `.globl` | 标签列表 | 任意 | 支持 | `directive-operand-count`, `directive-operand` |
| `.extern` | 标签、大小 | 任意 | 支持 | `directive-operand-count`, `directive-operand` |
| `.set` | 任意文本 | 任意 | 解析但效果忽略，并给警告 | `set-ignored` |
| `.eqv` | 名称、替换序列 | 任意 | 支持；检查声明顺序和保留名 | `directive-operand`, `reserved-symbol`, `eqv-forward-reference` |
| `.macro` | 名称、形式参数 | 任意 | 支持宏定义、重载和静态体分析 | `macro-header`, `macro-parameter`, `nested-macro`, `duplicate-macro` |
| `.end_macro` | 无 | 宏体 | 支持宏结束；孤立出现报错；当前不单独检查额外操作数 | `macro-end` |
| `.include` | 引号路径 | 任意 | 语法支持；实时 parser 不展开文件 | `directive-operand` |

### 指令

- 指令资源：`resources/mips/instructions.json`
- 当前资源数量：114 条指令。
- 操作数格式资源：`resources/mips/instructionMeta.json`
- 指令校验入口：`src/language/mips/instructionValidation.ts`
- 测试覆盖：`src/test/language/mips/instructionValidation.test.ts` 会从资源格式生成正例，并为每类操作数保留代表性反例。

| 操作数族 | 资源格式 | 合法示例 | 非法示例 |
| --- | --- | --- | --- |
| 通用寄存器 | `$rd`, `$rs`, `$rt`, `$base` | `add $t0, $t1, $t2` | `add 1, $t1, $t2` |
| CP0 寄存器 | `cp0` | `mfc0 $t0, $12` | `mfc0 $t0, $bad` |
| 内存操作数 | `offset($base)`, `($base)`, `simm16($base)`, `uimm16($base)`, `imm32($base)` | `lw $t0, 4($sp)` | `lw $t0, 4($bad)` |
| 标签偏移内存 | `label($base)`, `label+imm32($base)` | `lw $t0, table+4($gp)` | `lw $t0, "x"($gp)` |
| 32 位立即数 | `imm32` | `li $t0, 0x12345678` | `li $t0, label` |
| 有符号 16 位立即数 | `simm16` | `addi $t0, $t1, -1` | `addi $t0, $t1, 0x10000` |
| 无符号 16 位立即数 | `uimm16` | `ori $t0, $t1, 0xffff` | `ori $t0, $t1, -1` |
| 移位量 | `shamt` | `sll $t0, $t1, 4` | `sll $t0, $t1, 40` |
| 位位置/位宽 | `pos`, `size` | `ext $t0, $t1, 0, 8` | `ext $t0, $t1, x, 8` |
| trap 代码 | `code16` | `teqi $t0, 1` | `teqi $t0, label` |
| 标签 | `label`, `label+imm32` | `beq $t0, $t1, done` | `beq $t0, $t1, 4($sp)` |

### 词法与行语法

| 特性 | 当前状态 | 诊断 |
| --- | --- | --- |
| 未知 token，例如 `@`、反引号、孤立 `%`、孤立 `$` | 支持检测 | `mips-lex-unknown-token` |
| 未闭合字符串 | 支持检测 | `mips-lex-unclosed-string` |
| 非法字符串转义 | 支持检测 | `mips-lex-string-escape` |
| 畸形字符字面量 | 支持检测 | `mips-lex-char-literal`, `mips-lex-unclosed-char` |
| 无可执行语句的坏行，例如 `:`、`1bad: nop`、`a:: nop` | 支持检测 | `mips-syntax-line` |
| 数据伪指令续行 | 支持 `.byte/.half/.word/.float/.double/.ascii/.asciiz` | `directive-operand-count`, `directive-operand` |

## Verilog

### 课程子集

| 区域 | 支持形式 | 主要诊断 |
| --- | --- | --- |
| 模块头 | 空端口、传统端口、ANSI 端口、`#(...)` 参数列表 | `syntax-module-declaration`, `syntax-malformed-port-list` |
| 声明 | `input/output/inout/wire/reg/logic/integer/time/real/realtime/genvar/parameter/localparam`，并支持 `signed/unsigned/automatic/scalared/vectored` 等修饰符 | `syntax-malformed-declaration` |
| 连续赋值 | 普通 `assign`；驱动强度元组会被剥离后继续解析并提示课程外 | `syntax-malformed-assignment`, `syntax-missing-semicolon`, `syntax-unsupported-construct` |
| 过程赋值 | `always`/`initial` 内阻塞与非阻塞赋值 | `syntax-malformed-assignment`, `mixed-assignment`, `vc-007-*`, `vc-010-*` |
| 表达式 | 一元、二元、三元、拼接、重复拼接、函数/系统函数调用、位选、范围选择、索引式部分选择、转义标识符、基数字面量 | `syntax-malformed-assignment`, `syntax-malformed-declaration`, `syntax-malformed-instance`, `syntax-malformed-number` |
| 过程控制 | `if/else`, `case/casex/casez`, `for/while/repeat/forever`, 事件控制、延迟控制；`for` 的 init/condition/step 会结构化检查 | `syntax-malformed-if`, `syntax-malformed-case`, `syntax-malformed-for`, `syntax-malformed-while`, `syntax-malformed-repeat`, `syntax-malformed-event-control` |
| 块结构 | `begin/end`, `case/endcase`, `generate/endgenerate`, `function/endfunction`, `task/endtask` | `syntax-unclosed-*`, `syntax-unmatched-*` |
| 实例化 | 命名端口、位置端口、空连接、参数覆盖、常见门级原语 | `syntax-malformed-instance`, `syntax-malformed-gate-primitive`, `unknown-port`, `unknown-parameter` |
| 预处理 | 静态识别 ``include``、``define``、``default_nettype``；宏可用于位宽/表达式文本；不做完整条件编译展开 | `missing-include`, `implicit-net:*`, `default-nettype-none` |
| generate | 常见 generate-for；课程子集要求 `begin : name` 命名块；generate-if/generate-case 只做足够的语句边界识别 | `syntax-malformed-generate`, `syntax-unclosed-generate` |
| task/function | 常见头部、参数/局部声明和过程体；名称和局部声明进入语义作用域 | `syntax-malformed-procedural-block`, `syntax-unclosed-task`, `syntax-unclosed-function` |

### 课程外语法分类

| 构造 | 当前行为 | 原因 |
| --- | --- | --- |
| `tri`, `tri0`, `tri1`, `supply0`, `supply1`, `wand`, `wor`, `triand`, `trior`, `trireg` | 按 wire 类声明建模，同时发 `syntax-unsupported-construct` 信息提示 | 合法 Verilog，但 CO 项目很少需要 |
| 驱动强度，例如 `assign (weak1, weak0) y = a;` | 剥离强度元组后继续解析赋值，并发 `syntax-unsupported-construct` 信息提示 | 合法 Verilog，但超出课程子集 |
| `specify`, `primitive`, `defparam`, `fork`, `event` | 发 `syntax-unsupported-construct`；可恢复时继续做周边语法分析 | 仿真/库建模或高级行为构造，不属于课程常用子集 |
| SystemVerilog 特性，例如 `always_ff`、interface、package、typedef/enum/struct | 没有专门建模；根据可恢复程度表现为普通标识符、畸形声明/实例或 `syntax-unexpected-token` | 本地 parser 面向 Verilog 课程子集 |

### 性能基线

| 场景 | 覆盖要求 | 测试 |
| --- | --- | --- |
| 2000+ 行课程风格 Verilog 文件 | `getVerilogDiagnostics` 不依赖外部工具即可完成；生成的合法设计不产生 `syntax-*` 诊断；默认预算 4000ms 内完成 | `src/test/language/verilog/performance.test.ts` |
| 同一 URI/version/text 重复诊断 | 必须复用 `getCachedVerilogParse` 的解析结果，而不是重复解析 | `src/test/language/verilog/performance.test.ts` |

较慢 CI 主机可以用 `CO_VERILOG_PERF_BUDGET_MS` 覆盖性能预算。

## 测试样例布局

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

测试样例期望文件与源文件同名、扩展名为 `.json`，断言诊断 `code` 和从 1 开始计数的 `line`。

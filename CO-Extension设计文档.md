# CO-Extension VSCode 插件设计文档

## 1. 背景与目标

BUAA 计算机组成实验覆盖数字电路、MIPS 汇编、Verilog、单周期 CPU、流水线 CPU、异常中断微系统等内容。现有教程中实际使用的工具链较分散：Logisim、MARS、ISE/ISim、VCS/Verdi、Icarus Verilog、Python 测试脚本、Hazard 分析器、`co-submit` 等。学生需要在多个 GUI、命令行脚本和文件格式之间切换，容易在环境配置、导出机器码、仿真参数、输出格式和对拍流程上消耗过多时间。

本插件目标是提供一个开箱即用的一站式 VSCode 计算机组成实验开发环境，重点解决如下问题：

1. 为 MIPS ASM 和 Verilog 提供足够强的语言支持，降低编码、阅读、跳转、补全、检查和调试成本。
2. 统一管理、调度课程工具链，把 MARS、Logisim、ISE/ISim、Hazard 工具和提交脚本封装为一致的 VSCode 命令、任务和视图。
3. 无需复杂的配置，用户不需要关心应该如何配置格式化工具和语言服务器，这些应当封装到插件内部，只需配置本地ISE、MARS、Logisim安装路径

**注意事项（重要！）**：
1. 仿真工具目前只支持ISE，暂不考虑VSC和iverilog支持，但保留将来接入的可能性
2. 不考虑虚拟机

## 2. 设计原则

- 课程优先：默认规则围绕 BUAA-CO P0-P7 的实际接口、输出格式和测试方式设计。
- 渐进增强：没有完整 EDA 环境时，仍能提供语法高亮、静态检查和 Icarus/MARS 等轻量能力。
- 本地透明：所有自动命令应在输出面板展示实际执行命令、工作目录、环境变量和生成文件。
- 可配置：工具路径、Project 类型、MARS 参数、仿真时间、顶层模块、文件列表都允许用户覆盖。
- 诊断可解释：每个 warning/error 都要能说明原因、课程语境和修复建议。

## 3. 用户画像与典型场景

### 3.1 P2 MIPS 汇编

用户编写 `.asm`，希望获得 MIPS 指令补全、寄存器提示、宏展开预览、标签跳转、`.data` 变量跳转、MARS 一键运行、stdin/stdout 管理、机器码导出和 `syscall` 结束检查。

### 3.2 P4 单周期 CPU

用户编写 Verilog CPU，希望插件检查顶层 `mips(input clk, input reset)`、`$display` 输出格式、`$readmemh("code.txt", im)` 路径，自动调用 MARS 导出机器码，再用 ISim/VCS/Icarus 运行 testbench，并与 MARS 输出对拍。

### 3.3 P5/P6 流水线 CPU

用户需要覆盖转发、阻塞、字节使能、乘除模块。插件应支持批量测试、首差定位、周期统计、Hazard-Calculator 调度、`hazard.json` 可视化。

### 3.4 P7 微系统

用户需要处理异常、中断、Timer、CP0。插件应检查 P7 顶层接口，支持官方 tb、课程修改版 Mars 配置，展示 CP0/异常/宏观 PC 相关信号的调试建议。注意 P7 不应默认用普通 Mars 作为唯一黄金模型。

## 4. 总体架构

建议采用 VSCode Extension + Language Server + Toolchain Service 的三层架构。

```text
VSCode Extension Host
├── UI / Commands / StatusBar / TreeView / WebView
├── Project Manager
├── Toolchain Orchestrator
│   ├── MarsRunner
│   ├── LogisimRunner
│   ├── IcarusRunner
│   ├── HazardRunner
│   └── SubmitRunner
├── Output Parsers
│   ├── MarsTraceParser
│   ├── VerilogSimTraceParser
│   ├── FuseLogParser
│   └── HazardJsonParser
└── Language Clients
    ├── MIPS ASM Language Client
    └── Verilog Language Client

Language Server Process
├── MIPS Parser / Symbol Table / Macro Expander
├── Verilog Parser / Module Index / Net Declaration Checker
├── Completion / Hover / Definition / References
├── Diagnostics / CodeActions / Formatter
└── Workspace Index
```

### 4.1 Extension Host

负责与 VSCode API 交互：

- 注册命令、状态栏按钮、CodeLens、任务和调试入口。
- 管理配置项和工作区状态。
- 启动/连接语言服务器。
- 调用工具链并展示输出。
- 管理 Webview，如运行结果、对拍结果、hazard 可视化、环境检查页。

### 4.2 Language Server

建议使用 TypeScript 实现，基于 `vscode-languageserver/node`。语言能力保持和 VSCode UI 解耦，便于后续测试和复用。

MIPS ASM 与 Verilog 都建议先实现“课程够用”的轻量 parser，而不是一开始引入复杂完整前端：

- MIPS ASM：行级 lexer + directive/macro/label/instruction parser。
- Verilog：可先基于 tree-sitter-verilog 或 antlr grammar；若短期成本较高，可实现模块/端口/wire/reg/assign/always/instance 的浅层 parser，再逐步替换。

### 4.3 Toolchain Orchestrator

统一封装外部工具执行：

- 所有 runner 使用统一接口。
- 支持 dry-run 展示命令。
- 支持取消运行。
- 捕获 stdout/stderr。
- 记录生成物。
- 将日志解析为 Problems 和结构化结果。

接口草案：

```ts
export interface ToolRunRequest {
  cwd: string;
  env?: Record<string, string>;
  args?: string[];
  files?: string[];
  timeoutMs?: number;
  profile: ProjectProfile;
}

export interface ToolRunResult {
  ok: boolean;
  exitCode: number | null;
  commandLine: string;
  cwd: string;
  stdout: string;
  stderr: string;
  artifacts: Artifact[];
  diagnostics: Diagnostic[];
}

export interface ToolRunner {
  id: string;
  label: string;
  detect(): Promise<ToolDetectionResult>;
  run(request: ToolRunRequest, token: CancellationToken): Promise<ToolRunResult>;
}
```

## 5. Project Profile 与工作区识别

插件需要知道当前工程是 P2、P4、P5、P6 还是 P7，因为规则差异很大。建议引入 `co.projectProfile`：

```json
{
  "co.project.profile": "P5",
  "co.project.topModule": "mips",
  "co.project.testbench": "mips_tb",
  "co.project.asmEntry": "test.asm",
  "co.project.machineCode": "code.txt",
  "co.project.simTime": "200us"
}
```

识别优先级：

1. 工作区 `.vscode/settings.json` 中显式配置。
2. 工作区存在 `.co/config.json`。
3. 根据顶层模块接口自动推断：P4/P5 是 `clk/reset`，P6 是外置 IM/DM，P7 有 `interrupt/macroscopic_pc/m_int_*`。
4. 根据目录名或用户首次选择。

建议 `.co/config.json`：

```json
{
  "profile": "P5",
  "toolchain": {
    "mars": "E:/VSCode/BUAA-CO/assets/cscore-assets/Mars4_5.jar",
    "marsP7": "E:/VSCode/BUAA-CO/assets/cscore-assets/Mars_p7.zip",
    "isePath": "D:/Xilinx/14.7/ISE_DS/ISE/",
    "vcsProject": "./vcs",
    "hazardCalculator": "./tools/Hazard-Calculator.jar"
  },
  "simulation": {
    "backend": "isim",
    "top": "mips_tb",
    "time": "200us",
    "machineCode": "code.txt"
  }
}
```

## 6. MIPS ASM 语言支持设计

### 6.1 文件类型与高亮

支持扩展名：

- `.asm`
- `.s`
- `.mips`

高亮范围：

- 指令：`add/sub/ori/lw/sw/beq/jal/jr/mfc0/eret/...`
- 寄存器：`$0`、`$zero`、`$t0`、`$sp` 等。
- directive：`.data`、`.text`、`.ktext`、`.word`、`.space`、`.asciiz`、`.eqv`、`.macro`、`.end_macro`。
- 标签定义：`label:`
- 标签引用：分支/跳转目标、数据变量引用。
- 立即数：十进制、十六进制、负数。
- 宏形参：`%i`、`%end_label`。
- 注释。

TextMate grammar 负责基础着色，语言服务器负责语义 token，例如把同样的 identifier 区分成 label、macro、data symbol、macro parameter。

### 6.2 指令数据库

维护课程指令数据库 `mips-instructions.json`：

```json
{
  "ori": {
    "summary": "OR Immediate",
    "formats": ["ori $rt, $rs, imm"],
    "operands": ["regWrite", "regRead", "uimm16"],
    "pseudo": false,
    "projects": ["P2", "P3", "P4", "P5", "P6", "P7"],
    "delaySlot": false,
    "description": "rt <- rs | zero_extend(imm)"
  },
  "beq": {
    "summary": "Branch if Equal",
    "formats": ["beq $rs, $rt, label"],
    "operands": ["regRead", "regRead", "label"],
    "delaySlot": true
  }
}
```

用途：

- 补全。
- Hover。
- Signature Help。
- 参数类型诊断。
- Project 指令集限制。
- 测试生成器识别读写寄存器。

### 6.3 Hover 与补全

Hover 内容：

- 指令含义，如 `li - load immediate`。
- 指令格式，如 `sub $rd, $rs, $rt`。
- 立即数范围和符号扩展说明。
- 是否伪指令。
- 当前 Project 是否支持。
- 对分支/跳转指令提示是否存在 delay slot。

补全内容：

- 指令名。
- 寄存器名。
- 标签。
- `.data` 变量。
- directive。
- 宏名。
- 宏形参。
- 常用代码片段，如 `syscall exit`、循环模板、读入整数、二维数组寻址。

示例 snippet：

```json
{
  "mips.exit": {
    "prefix": "exit",
    "body": ["li $v0, 10", "syscall"],
    "description": "Exit program by syscall"
  }
}
```

### 6.4 宏支持

需要重点支持 `.macro` / `.end_macro`。

能力：

- `.macro` 与 `.end_macro` 闭合检查。
- 宏名补全。
- 宏参数补全。
- 宏参数跳转到定义。
- 宏调用 hover 展示展开预览。
- 宏递归或过深展开时停止并给出提示。

宏索引结构：

```ts
interface MipsMacro {
  name: string;
  params: string[];
  range: Range;
  bodyRange: Range;
  bodyText: string;
}
```

宏展开算法建议：

1. 解析宏定义，保留参数顺序。
2. 解析宏调用实参。
3. 建立 `%param -> arg` 映射。
4. 对 body 做 token 级替换，而不是纯字符串替换，避免误替换注释和字符串。
5. 展开结果用于 hover 预览和诊断，不默认改写用户代码。

示例：

```asm
.macro end
    li $v0, 10
    syscall
.end_macro
```

在 `end()` 上 hover 展示：

```asm
li $v0, 10
syscall
```

### 6.5 符号跳转与引用

Definition：

- `beq $a1, $a2, label` 中 `label` 跳转到 `label:`。
- `j loop` 跳转到 `loop:`。
- `la $a0, _str` 跳转到 `.data` 中 `_str:`。
- 宏调用实参如果是标签名，也跳转到标签定义。
- 宏体内 `%i`、`%end_label` 跳转到 `.macro` 参数定义。

References：

- 标签所有引用。
- 数据变量所有引用。
- 宏所有调用。

Rename：

- 标签重命名。
- 数据变量重命名。
- 宏名重命名。
- 宏参数重命名，仅限宏体内部。

### 6.6 静态诊断

MIPS 诊断分为语法、课程规则、可运行性三类。

语法诊断：

- 未闭合 `.macro`。
- 重复标签。
- 找不到标签。
- 指令操作数数量不匹配。
- 寄存器名非法。
- 立即数格式错误。

课程规则诊断：

- 当前 Project 不支持的指令。
- P2 默认不应开启 delay slot 语义。
- P2 程序缺少 `syscall` 退出。
- `.data` 带非课程要求的地址参数时提示可能评测错误。
- 伪指令可能展开为未支持指令。
- P5/P6 测试程序中延迟槽内跳转。
- 机器码超出 IM 范围。
- 数据访问可能超出 DM 范围，能静态判断时提示。

可运行性诊断：

- MARS jar 未配置。
- Java 不可用。
- 当前文件未保存。
- 导出路径不可写。

### 6.7 格式化

提供保守格式化：

- 标签顶格。
- 指令缩进 4 空格。
- 操作数逗号后加空格。
- 注释保持。
- `.macro` 体内缩进。
- 不重排代码。

格式化示例：

```asm
loop:
    lw $t0, 0($s0)      # load a[i]
    addi $s0, $s0, 4
    bne $s0, $s1, loop
    nop
```

## 7. Verilog 语言支持设计

### 7.1 基础语言能力

支持扩展名：

- `.v`

能力：

- 语法高亮。
- 模块、端口、信号、参数、宏的 Outline。
- 模块实例化补全。
- 信号跳转定义。
- module 跳转定义。
- `include` 文件跳转。
- 宏定义跳转。
- Hover 展示信号位宽、声明类型、驱动位置。
- 端口连接提示。

### 7.2 Verilog 索引模型

工作区级索引：

```ts
interface VerilogWorkspaceIndex {
  modules: Map<string, VerilogModule>;
  macros: Map<string, VerilogMacro>;
  includes: Map<string, string[]>;
}

interface VerilogModule {
  name: string;
  file: string;
  range: Range;
  ports: VerilogPort[];
  declarations: VerilogDecl[];
  instances: VerilogInstance[];
  parameters: VerilogParam[];
}

interface VerilogDecl {
  name: string;
  kind: "wire" | "reg" | "logic" | "integer" | "parameter" | "localparam";
  width?: BitRange;
  range: Range;
  drivers: Range[];
  reads: Range[];
}
```

### 7.3 未定义变量检查

这是插件的核心能力之一，应实现类似 `default_nettype none` 的 warning。

检查规则：

- 在表达式、assign 左右值、always 块、实例端口连接中出现的 identifier，如果不是端口、声明、parameter/localparam、genvar、宏、系统任务、层次化路径合法前缀，则报告。
- 对隐式 wire 场景给 Warning，不直接报 Error。
- 如果文件已经声明 `` `default_nettype none``，则仍可增强提示但降低重复噪声。
- 支持按文件、按变量、按工程关闭。

配置：

```json
{
  "co.verilog.implicitNet.diagnostic": "warning",
  "co.verilog.implicitNet.ignorePatterns": ["^uut\\.", "^tb\\."],
  "co.verilog.implicitNet.disabledFiles": []
}
```

CodeAction：

- “声明为 wire [N:0] name;”
- “声明为 reg [N:0] name;”
- “在文件头加入 `default_nettype none`”
- “忽略当前标识符”

### 7.4 位宽与端口检查

课程中 CPU 接口严格，位宽错误很常见。建议实现：

- 端口连接缺失。
- 命名端口不存在。
- 端口方向不匹配的可疑连接。
- 位宽不一致 warning。
- output reg/wire 使用错误提示。
- module 重复定义。
- 实例化时位置映射参数数量不一致。

### 7.5 课程规范 lint

建议内置 BUAA-CO 规则集：

- 一个信号尽量只在一个 always 块中赋值。
- 时序逻辑建议使用非阻塞赋值。
- 组合逻辑建议使用阻塞赋值。
- 不要混用阻塞/非阻塞给同一变量赋值。
- 避免内部模块使用 `inout`。
- 状态机建议用 `localparam` 定义状态。
- magic number 建议改为宏或 localparam，尤其是 opcode/funct。
- `include` 头文件建议有 include guard。
- 可选提示添加 `` `default_nettype none``。

### 7.6 Testbench 支持

能力：

- 根据当前 module 生成 testbench。
- 自动实例化 UUT，优先使用命名端口映射。
- 自动生成 `clk/reset`。
- 自动插入 `$readmemh("code.txt", im);` 模板。
- VCS 模式插入 `$fsdbDumpvars()`。
- Icarus/GTKWave 模式插入 `$dumpfile/$dumpvars`。

示例生成：

```verilog
`timescale 1ns / 1ps

module mips_tb;
    reg clk;
    reg reset;

    mips uut (
        .clk(clk),
        .reset(reset)
    );

    initial begin
        clk = 1'b0;
        forever #5 clk = ~clk;
    end

    initial begin
        reset = 1'b1;
        #20;
        reset = 1'b0;
        #200000;
        $finish;
    end
endmodule
```

## 8. 工具链统一调度设计

### 8.1 环境检测

命令：`CO: Check Toolchain`

检测项：

- Java：`java -version`
- MARS：普通 `Mars4_5.jar`
- P7 Mars：`Mars_p7.zip` 或解压后的 jar
- Logisim：`logisim.jar`
- ISE：`ISE_DS/ISE/bin/nt64/fuse.exe`
- Icarus：`iverilog`、`vvp`
- Python：`python --version`
- Hazard-Calculator.jar

输出为 Webview 表格：

| 工具 | 状态 | 版本/路径 | 建议 |
|---|---|---|---|
| Java | OK | 1.8.x | - |
| MARS | Missing | - | 配置 `co.mars.jar` |
| ISE | OK | D:/Xilinx/... | - |

### 8.2 MARS Runner

命令：

- `CO: Run MARS`
- `CO: Dump Text Segment`
- `CO: Dump Kernel Text Segment`
- `CO: Run MARS and Capture Output`

普通导出：

```bash
java -jar <mars.jar> <asm> nc mc CompactDataAtZero a dump .text HexText code.txt
```

P5/P6 对拍运行：

```bash
java -jar <mars.jar> <asm> db nc mc CompactDataAtZero > mars.out
```

P7 需要使用课程修改版 Mars，配置项单独管理。文档中应明确：P5 教程提到“需要修改 Mars 行为”，但现成下载链接只在 P7 的“官方 Mars”部分给出。

输出解析：

```text
100@00003000: $3 <= 00000000
120@00003004: *00001004 <= 00000000
@00003000: $3 <= 00000000
@00003004: *00001004 <= 00000000
```

结构化事件：

```ts
interface CpuTraceEvent {
  time?: number;
  pc: string;
  kind: "grf" | "dm";
  target: string;
  value: string;
  raw: string;
}
```

### 8.3 ISE/ISim Runner

命令：

- `CO: Generate ISE PRJ/TCL`
- `CO: Run ISim`
- `CO: Clean ISim Artifacts`

生成 `mips.prj`：

```text
Verilog work "D:/Project/mips.v"
Verilog work "D:/Project/mips_tb.v"
Verilog work "D:/Project/datapath/Datapath.v"
```

生成 `mips.tcl`：

```tcl
run 200us;
exit
```

执行：

```bash
<isePath>/bin/nt64/fuse -nodebug -prj mips.prj -o mips.exe mips_tb
mips.exe -nolog -tclbatch mips.tcl
```

日志解析：

- 编译错误 -> Problems。
- 常见 ISE 错误 -> human-readable 解释。
- 仿真输出 -> trace event。

### 8.6 Hazard Runner

命令：

- `CO: Analyze Pipeline Hazards`
- `CO: Package Testcases`
- `CO: Open Hazard Report`

执行：

```bash
java -jar Hazard-Calculator.jar --hz code.txt
python analyzer.py
```

Webview 展示：

- accepted cycle range。
- forwarding 覆盖。
- stalling 覆盖。
- warning 类别。
- 每条 hazard 对应的 D/E/M/W 指令现场。

## 9. UI/UX 设计

### 9.1 状态栏

显示当前 Project Profile 和工具链状态：

```text
CO: P5 | MARS OK | ISim OK | VCS Missing
```

点击打开环境检查页。

### 9.2 编辑器右上角按钮

ASM 文件：

- Run MARS
- Dump code.txt
- Run with input

Verilog 文件：

- Run Simulation
- Compare Trace
- Open Wave

按钮行为跟随当前 profile 和默认 backend。

### 9.3 侧边栏

建议 TreeView：

```text
BUAA CO
├── Project
│   ├── Profile: P5
│   ├── Top: mips
│   └── Backend: ISim
├── Toolchain
│   ├── MARS: OK
│   ├── ISE: OK
│   └── VCS: Missing
├── Actions
│   ├── Dump code.txt
│   ├── Run Simulation
│   ├── Compare Trace
│   └── Submit
└── Artifacts
    ├── code.txt
    ├── mars.out
    ├── sim.out
    └── hazard.json
```

### 9.4 Webview

至少三个：

1. Environment Report。
2. Trace Compare Report。
3. Hazard Report。

Trace Compare Report 示例：

| # | 状态 | MARS | SIM |
|---:|---|---|---|
| 35 | OK | `100@3000: $1 <= ...` | same |
| 36 | DIFF | `$2 <= 00000004` | `$2 <= 00000000` |

点击行号跳转到相关 PC、汇编行或波形时间。

## 10. 课程 Profile 规则

### 10.1 P2

- ASM 为主。
- 默认不启用 delay slot。
- 检查 `syscall` 退出。
- MARS 参数使用 `mc CompactDataAtZero`。

### 10.2 P4

- 顶层接口：

```verilog
module mips(input clk, input reset);
```

- GRF 输出：

```verilog
$display("@%h: $%d <= %h", WPC, Waddr, WData);
```

- DM 输出：

```verilog
$display("@%h: *%h <= %h", pc, addr, din);
```

### 10.3 P5

- 顶层同 P4。
- 输出增加 `$time`：

```verilog
$display("%d@%h: $%d <= %h", $time, WPC, Waddr, WData);
$display("%d@%h: *%h <= %h", $time, pc, addr, din);
```

- 启用 delay slot。
- 支持 hazard 覆盖率。

### 10.4 P6

- 顶层外置存储器接口。
- 禁止用户代码中出现 `$display`。
- 检查 `m_data_byteen` 位宽和写入逻辑。
- 由 testbench 监控 `w_grf_*` 与 `m_data_*`。

### 10.5 P7

- 顶层含 `interrupt`、`macroscopic_pc`、`m_int_addr`、`m_int_byteen`。
- 检查 CP0 相关信号建议。
- 支持官方 normal/interrupt tb。
- Mars runner 使用 P7 专用配置，不默认套用普通 Mars。

## 11. 配置项设计

```json
{
  "co.project.profile": "auto",
  "co.project.topModule": "mips",
  "co.project.testbench": "mips_tb",
  "co.project.machineCode": "code.txt",
  "co.project.simTime": "200us",

  "co.toolchain.java": "java",
  "co.toolchain.mars": "E:/VSCode/BUAA-CO/assets/cscore-assets/Mars4_5.jar",
  "co.toolchain.marsP7": "E:/VSCode/BUAA-CO/assets/cscore-assets/Mars_p7.zip",
  "co.toolchain.logisim": "",
  "co.toolchain.isePath": "D:/Xilinx/14.7/ISE_DS/ISE/",
  "co.toolchain.python": "python",
  "co.toolchain.hazardCalculator": "",

  "co.mips.delayedBranching": "profile",
  "co.mips.memoryConfiguration": "CompactDataAtZero",
  "co.mips.warnPseudoInstruction": true,
  "co.mips.warnMissingExitSyscall": true,

  "co.verilog.implicitNet.diagnostic": "warning",
  "co.verilog.lint.courseRules": true,
  "co.verilog.backend": "auto",

  "co.run.showCommandBeforeRun": false,
  "co.run.timeoutMs": 120000
}
```

## 12. 实现路线

### 第一阶段：可用 MVP

目标：让用户能在 VSCode 内完成 P2/P4/P5 的基本运行闭环。

- MIPS TextMate 高亮。
- MIPS 指令 hover/补全。
- 标签和 `.data` 变量跳转。
- MARS 运行与 `code.txt` 导出。
- Verilog TextMate 高亮。
- P4/P5 顶层接口和 `$display` 检查。
- Icarus 快速仿真。
- ISim/VCS 外部命令入口。

### 第二阶段：强语言服务

- MIPS 宏解析、宏展开 hover、宏参数跳转。
- MIPS formatter。
- Verilog module index。
- Verilog 未定义变量检查。
- 端口补全和实例化模板。
- 基础位宽检查。

### 第三阶段：自动化测试与对拍

- MARS/仿真输出统一事件解析。
- Trace Compare Webview。
- 自动生成 ISE `.prj/.tcl`。
- P5/P6 Hazard-Calculator 集成。

### 第四阶段：Project 深度支持

- P6 外置存储器 testbench 模板。
- P7 官方 tb 管理和 P7 Mars 配置。
- Logisim ROM 文件生成。
- `.circ`/Logging 辅助。
- `co-submit` 集成。

## 13. 测试策略

### 13.1 单元测试

- MIPS lexer/parser。
- 宏展开。
- 标签符号表。
- Verilog module parser。
- 隐式 net 检查。
- 输出 trace parser。

### 13.2 集成测试

准备 fixtures：

```text
fixtures/
├── p2-asm/
├── p4-single-cycle/
├── p5-pipeline/
├── p6-memory-extern/
└── p7-system/
```

每个 fixture 包含：

- 源文件。
- 期望 diagnostics。
- 期望 symbols。
- 期望命令行。
- 样例输出与对拍结果。

### 13.3 工具链测试

外部工具不可全部假定存在，应提供 mock runner：

- CI 中使用 mock runner 验证命令生成和日志解析。
- 本地开发者可通过真实工具跑 e2e。

## 14. 风险与边界

- VCS/Verdi 是专有软件，插件只能调用用户已有环境，不能分发。
- ISE 老旧且路径差异大，路径检测和错误提示要充分。
- Icarus 与 ISE/VCS 行为不完全一致，UI 必须明确“快速检查，不代表最终评测”。
- P7 普通 Mars 行为不等于课程评测标准，不能误导用户。
- Verilog 完整语义分析很复杂，第一版应聚焦课程常见 RTL 子集。
- 插件不应生成完整作业答案或规避课程查重，只做环境、语言、测试和调试辅助。

## 15. 推荐技术栈

- VSCode Extension：TypeScript。
- Language Server：`vscode-languageserver/node`。
- 语法高亮：TextMate grammar。
- Verilog parser：优先调研 `tree-sitter-verilog`；短期可用轻量 parser。
- Webview：普通 HTML + CSS + 少量 JS，避免过重框架。
- 测试：`@vscode/test-electron`、`vitest` 或 `mocha`。
- 打包：`vsce`。

## 16. 关键命令清单

```text
CO: Check Toolchain
CO: Select Project Profile
CO: Configure Toolchain

CO: MIPS Run Current File
CO: MIPS Dump Text Segment
CO: MIPS Dump Kernel Text Segment
CO: MIPS Preview Macro Expansion

CO: Verilog Generate Testbench
CO: Verilog Generate ISE PRJ/TCL
CO: Verilog Run Simulation
CO: Verilog Open Wave

CO: CPU Compare Trace
CO: CPU Show First Difference
CO: Pipeline Analyze Hazards
CO: Pipeline Open Hazard Report

CO: Logisim Generate ROM File
CO: Submit Current Problem
```
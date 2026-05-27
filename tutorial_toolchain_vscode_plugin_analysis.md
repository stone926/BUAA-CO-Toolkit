# tutorial 目录工具链与 VSCode 一站式插件需求分析

本文面向“开箱即用的一站式全覆盖 VSCode 计算机组成插件”的开发需求，对 `tutorial` 目录下的计算机组成实验教程进行工具链、使用方法、测评方式、测试方式和调试方式整理。

分析对象是已构建的静态教程站点，主要依据：

- `tutorial/search/search_index.json`：全站搜索索引，包含 854 条章节/标题索引，聚合为 255 个页面。
- `tutorial/index.html`：全站导航结构。
- `tutorial/vm`、`tutorial/logisim`、`tutorial/verilog`、`tutorial/mips`、`tutorial/P0` 至 `tutorial/P7`、`tutorial/CO_Simulator` 下的页面正文。

## 1. 教程结构总览

`tutorial` 下的内容按课程推进大致分为以下块：

| 目录 | 页面数 | 主题 |
|---|---:|---|
| `index` | 12 | 课程信息、提交次数、学术规范、入门测验、拓展报告 |
| `base` | 9 | Pre 知识、数制、补码、draw.io |
| `vm` | 8 | 课程虚拟机、Linux 终端、提交脚本、预装软件、显示适配 |
| `logisim` | 34 | 数字电路、Logisim 使用、仿真、自动化生成与测试 |
| `verilog` | 64 | Verilog、ISE/ISim、VCS/Verdi、Icarus、自动化测试 |
| `mips` | 48 | MIPS 汇编、MARS、测试程序设计 |
| `P0` | 7 | Logisim 电路设计、CRC、GRF、FSM |
| `P1` | 10 | Verilog 部件、时序逻辑、FSM、代码规范 |
| `P2` | 8 | MIPS 汇编课下作业 |
| `P3` | 5 | Logisim 单周期 CPU |
| `P4` | 8 | Verilog 单周期 CPU |
| `P5` | 19 | 流水线 CPU、冒险、覆盖率与自动化测试 |
| `P6` | 9 | 外置存储器、字节访存、乘除模块 |
| `P7` | 11 | 微系统、中断、异常、Timer、CP0 |
| `CO_Simulator` | 3 | Cache/TLB/Spectre 可视化模拟器 |

## 2. 工具链全景

| 工具/环境 | 教程位置 | 主要用途 | 关键输入/输出 | 插件需要覆盖的能力 |
|---|---|---|---|---|
| Logisim 2.7.1 | `tutorial/logisim`、`tutorial/P0/P3` | 数字电路与单周期 CPU GUI 设计 | `.circ`、ROM/Memory 数据 | `.circ` 识别、ROM 数据生成、Logging 解析、测试导入辅助 |
| MARS | `tutorial/mips`、`tutorial/verilog/verilog-6-8` | MIPS 汇编编写、运行、机器码导出、黄金模型 | `.asm` -> `code.txt`/运行输出 | MARS CLI 封装、机器码导出、延迟槽/内存配置一致性检查、输出对拍 |
| Java | MARS/Logisim/Hazard 工具 | 运行 jar 工具 | `.jar` | JRE 检测、jar 路径配置 |
| ISE | `tutorial/verilog/verilog-2` | Verilog 工程创建、综合、GUI 仿真入口 | `.v` 工程 | 工程/顶层接口检查、ISE 路径检测 |
| ISim/fuse | `tutorial/verilog/verilog-5`、`verilog-6-6`、`P5-4-7` | Verilog 功能仿真、命令行自动化 | `.prj`、`.tcl`、`.exe`、仿真输出 | 自动生成 `.prj/.tcl`、调用 `fuse`、采集日志、对拍 |
| VCS | `tutorial/verilog/vcs` | 高性能 Verilog/SystemVerilog 命令行仿真 | `src/*.v`、`src/*.sv`、`sim/simv` | 模板工程、编译/运行任务、日志解析 |
| Verdi | `tutorial/verilog/vcs/verdi` | FSDB 波形查看、信号追踪 | `.fsdb` | 外部打开 Verdi、波形文件定位、信号列表管理提示 |
| Icarus Verilog | `tutorial/verilog/verilog-6-7` | 轻量级命令行仿真 | `.v` -> `.vvp` | 快速语法/功能仿真 fallback，但提示以 ISE/VCS 为准 |
| GTKWave/Scansio | `tutorial/verilog/verilog-6-7` | 轻量波形查看 | `.vcd` 等 | 可选波形查看器集成 |
| Python | `tutorial/logisim/logisim-6-4`、`P5/testcases` | 生成 `.circ` XML、运行分析器 | 脚本、测试集 zip | 测试生成器脚手架、分析器运行 |
| Hazard-Calculator.jar | `tutorial/P5/testcases/P5-4-6` | P5/P6 流水线 hazard 覆盖率分析 | `code.txt` | 覆盖率视图、hazard.json 可视化 |
| CO-Simulator | `tutorial/CO_Simulator` | Cache/TLB/Spectre 可视化模拟 | `.trace`、地址序列 | trace 文件预览、Cache 测试点可视化入口 |

## 3. 工具链使用方式

### 3.1 Logisim

主要使用方式：

- GUI 搭建门电路、组合逻辑、时序逻辑、FSM、单周期 CPU。
- `Simulate -> Simulation Enable` 启用仿真。
- `Simulate -> Ticks Enable` 自动时钟运行。
- `Tick Frequency` 调整时钟频率。
- `Step Simulation` 关闭 `Simulation Enable` 后进行最小粒度步进，用于观察振荡、门延迟和状态传播。
- `Logging` 记录元件/端口状态；建议给元件设置 label，否则日志不可读。
- `.circ` 本质是 XML，可通过脚本半自动生成重复结构。
- 测试 ROM 导入时，MARS 导出的十六进制机器码用于 Logisim ROM 前需要添加 `v2.0 raw` 首行。

插件启示：

- `.circ` 文件解析：识别 circuit、wire、comp、ROM/Memory、label。
- Logisim ROM 文件生成器：从 MARS `HexText` 输出生成带 `v2.0 raw` 的文件。
- Logging 文本解析器：转成表格、CSV、对拍输入。
- `.circ` XML 生成辅助：面向 ROM 矩阵、GRF、重复 Tunnel 等结构生成代码片段。
- Step/Logging 教程无法完全在 VSCode 内复刻，但可以提供调试 checklist 和日志处理。

### 3.2 MARS

GUI 关键设置：

- `Settings -> Memory Configuration`：课程要求常用 `Compact, Data at Address 0`，命令行为 `mc CompactDataAtZero`。
- `Settings -> Delayed branching`：P5 之后常用延迟槽；P2 默认不考虑延迟槽。
- Run 工具栏支持编译、运行、单步、回退、暂停、停止、重置。
- Bkpt 列设置断点。
- 寄存器/内存窗口可查看并手动修改值。
- `Help -> MARS -> Command` 查看命令行参数。

常用 CLI：

```bash
java -jar <mars.jar> <asm> db nc mc CompactDataAtZero a dump .text HexText code.txt
java -jar <mars.jar> <asm> db nc mc CompactDataAtZero > ans.txt
java -jar mars.jar mc CompactDataAtZero a dump .text HexText hexcode.txt fibonacci.asm
java -jar mars.jar db mc CompactDataAtZero nc fibonacci.asm
```

导出异常处理程序示例：

```bash
java -jar E:\Mars4_5.jar a db mc CompactDataAtZero dump 0x00004180-0x00004ffc HexText E:\code_handler.txt E:\source.txt
```

课程自动化对拍要求中，MARS 作为黄金模型时需要注意：

- 开启延迟槽：`db`。
- 禁止版权输出：`nc`。
- 内存配置：`mc CompactDataAtZero`。
- P5 对拍中需要课程修改版 MARS：`$gp`、`$sp` 初始化为 `0x00000000`，写寄存器输出 `@PC: $Reg <= Data`，写内存输出 `@PC: *Addr <= Data`，加减溢出不产生异常。
- P7 明确说明测试标准以《See MIPS Run Linux》与课程规范为准，不以普通 MARS 行为为准；教程提供课程修改版 MARS 支持 P7 异常与定时器中断。

插件启示：

- MARS 路径配置与 Java 检测。
- 一键 `asm -> code.txt`、`asm -> ans.txt`。
- 自动设置/检查 `CompactDataAtZero` 和 delay slot。
- 输出解析为 PC/GRF/DM 事件流。
- 与 Verilog 仿真输出做对拍，定位首个不同事件。

### 3.3 ISE/ISim/fuse

GUI 流程：

- ISE 创建 Verilog 工程，添加源文件。
- 生成 Testbench：`New Source -> Verilog Test Fixture`。
- Simulation 视图下选中 testbench。
- `Behavioral Check Syntax` 做语法检查。
- `Simulate Behavioral Model` 启动 ISim。
- ISim 中查看波形、调整 radix、添加内部信号、查看 Memory。
- 工具栏支持缩放、跳转到信号变化、标记、运行指定时间、单步、断点、重启。

命令行自动化：

`.prj` 说明工程文件，格式：

```text
Verilog work "D:/PipelineCPU/mips.v"
Verilog work "D:/PipelineCPU/mips_tb.v"
Verilog work "D:/PipelineCPU/datapath/Datapath.v"
Verilog work "D:/PipelineCPU/controller/Controller.v"
```

`.tcl` 说明运行时间：

```tcl
run 200us;
exit
```

编译运行：

```bash
<ISE安装路径>/bin/nt64/fuse -nodebug -prj mips.prj -o mips.exe mips_tb
mips.exe -nolog -tclbatch mips.tcl
```

Python 调用示意：

```python
import os
os.chdir(projectPath)
os.environ["XILINX"] = xilinxPath
os.system(xilinxPath + "bin/nt64/fuse -nodebug -prj mips.prj -o mips.exe mips_tb > mips.log")
os.system("mips.exe -nolog -tclbatch mips.tcl > res.txt")
```

插件启示：

- 自动扫描工程 `.v` 文件并生成 `.prj`。
- 根据 Project 生成标准 testbench/tcl 模板。
- 统一封装 `fuse` 运行，日志写入 VSCode Problems。
- 内置常见 ISE/Verilog 错误字典：`Failed to link the design`、`Unable to remove previous simulation`、wire/reg 错误、阻塞/非阻塞混用、重复 module、多驱动、隐式 wire 等。

### 3.4 P5/P6 覆盖率与 hazard 分析工具

`P5/testcases/P5-4-6` 给出两个工具：

Shell - Analyzer：

```bash
python analyzer.py
```

目录约束：

```text
analysis
├── analyzer.py
├── Hazard-Calculator.jar
└── work
    └── P5_LX_example.zip
```

测试集 zip 约束：

```text
P5_LX_example.zip
├── P5_LX_TestCase0.zip
│   └── code.txt
└── P5_LX_TestCase1.zip
    └── code.txt
```

Kernel - Pipeline：

```bash
java -jar <jar-name> --help
```

重要参数：

- `--im-base <value>`：默认 `0x3000`。
- `--dm-base <value>`：默认 `0x0000`。
- `--im-size <value>`：默认 `4096 Word * 4 Byte/Word`。
- `--dm-size <value>`：默认 `3072 Word * 4 Byte/Word`。
- `--hz`：输出 hazard 信息。
- `--ov`：启用溢出检测。

输出包括：

- `hazard_statistic.json`
- `hazard.json`
- `standard pipeline-cycle`
- `slow pipeline-cycle`
- `accepted cycle range`

插件启示：

- 一键打包测试集。
- 自动运行 analyzer 和 Hazard-Calculator。
- `hazard.json` 可视化：转发、阻塞、D/E/M/W 现场、有效性。
- 将覆盖率 warning/details 转成 VSCode Webview 表格。

## 4. 各章节测评、测试与调试方式

### 4.1 课程通用测评机制

教程首页说明课程测试以自动测试为主、人工检查为辅。课程信息中还说明：

- 自动测试系统记录课下和课上提交，多次提交以最后一次为准。
- 课上测试通过后还会有设计提问，不能合理解释则 Project 不能通过。
- Project 后会人工检查代码是否符合开发规范和设计要求。
- 所有提交会保存并用于查重。
- 部分题目有提交次数上限。

插件启示：

- 插件应保存本地提交历史和评测反馈，帮助复盘，但不能提供规避查重或作弊功能。
- 在“通过自动测试”后仍应提醒用户补齐设计文档、思考题、测试说明和可解释性材料。

### 4.2 Pre/base/vm

测评方式：

- 入门测验、基础知识与趣味小测。
- 数制、原码/反码/补码学习偏理论。

测试/调试方式：

- 主要是环境检查：终端、MARS、Logisim、ISE 是否可用

插件需求：

- 首次启动向导：检测 Java、MARS、Logisim、ISE、Python。
- 提供“课程环境体检”命令。
- 提供基础换算小工具：进制、补码、符号扩展、指令字段拆分。

### 4.3 Logisim 章节

测评方式：

- 学习 Logisim 门电路、组合电路、时序电路、FSM。
- 具体练习如 swap、排序电路、`2^n mod 5`、斐波那契数列包含提交要求并进入自动评测。

测试方式：

- 手动设置输入 pin，观察输出。
- `Simulation Enable` + `Ticks Enable` 运行时序电路。
- `Step Simulation` 进行最小粒度步进。
- `Logging` 记录端口/元件变化。
- 对有限输入可穷举；复杂输入要选代表性样例。
- FSM 测试建议拆分为输出电路测试与状态转移电路测试，不直接做大规模黑箱序列穷举。

调试方式：

- 观察线路颜色、振荡错误、未定义值。
- 进入子电路查看局部状态。
- 使用 label 提升 Logging 可读性。
- 对 `.circ` XML 做半自动生成时，应先通过 GUI 找最小单元和坐标规律。

插件需求：

- Logisim 测试样例管理器。
- `.circ` 静态结构检查，例如未命名端口、ROM/Memory 容量、Tunnel 命名。
- Logging 转换器和比对器。
- FSM 测试模板生成。

### 4.4 Verilog 基础与 P1

测评方式：

- P1 包含 Verilog 部件设计、时序逻辑、FSM、表达式状态机和附加题。
- P1 课下题目评测中启用了提示功能。
- Verilog 章节强调自动评测机，同时支持 ISE 与 VCS 两种评测环境。

测试方式：

- 编写 Testbench 驱动 UUT。
- ISE 自动生成 `Verilog Test Fixture`，也可按 VCS 模板手写 testbench。
- 使用 `$display`、`$monitor`、`$readmemh`、`$fsdbDumpvars`。
- 组合逻辑、时序逻辑分别构造输入变化和时钟周期。

调试方式：

- ISim/Verdi 波形观察。
- radix 调整、内部信号加入波形。
- 单步、断点、重启仿真。
- 常见 bug：`x` 未初始化、`z` 未连接、wire/reg 错误、多驱动、阻塞/非阻塞混用、隐式 wire。
- 代码规范建议：信号命名、低有效 `_n`、状态使用 `localparam`、状态名通过 `state_string` 在波形中显示。

插件需求：

- Verilog 代码模板、testbench 生成器。
- 课程代码规范 lint。
- 自动插入 `default_nettype none` 检查建议。
- 波形调试 checklist。
- ISE/VCS 错误日志解释。

### 4.5 MIPS 章节与 P2

测评方式：

- P2 要求用 MARS 编写矩阵乘法、回文串判断、卷积运算、全排列；高精度阶乘、01 迷宫为挑战题。
- P2 默认不考虑延迟槽。
- 所有程序初始地址设置必须为 `Compact, Data at Address 0`，评测命令使用 `CompactDataAtZero`。
- 程序运行结束必须使用 `syscall`，否则可能被判超时。
- 每题有提交间隔限制。

测试方式：

- MARS GUI 编译运行、单步、断点、查看寄存器/内存。
- MARS CLI 导出机器码和标准输出。
- 对数组、矩阵等内存操作建议用 macro 减少重复地址计算。

调试方式：

- Mars Message 点击错误定位代码。
- Run I/O 观察输入输出。
- 断点 + 单步检查寄存器和内存变化。
- 双击寄存器/内存手动改值以构造调试初态。

插件需求：

- `.asm` 任务模板，自动提示 `syscall` 结束。
- MARS 内存配置检查。
- 禁用/启用延迟槽的章节感知提示。
- 一键运行样例、批量运行测试数据、stdin/stdout 管理。

### 4.6 P3：Logisim 单周期 CPU

测评方式：

- 使用 Logisim 开发简单 MIPS 单周期处理器。
- 课上问答检查设计草稿、测试方案、思考题。
- 通过课下测试不代表设计完全正确，鼓励自测并写入设计文档。

测试方式：

- 用 MARS 编写测试程序并导出机器码。
- Logisim ROM 导入前给机器码文件加 `v2.0 raw`。
- 运行 CPU 后比较 GPR 和 DM。
- 测试建议覆盖：
  - 计算类：0 附近、32 位边界、随机数、目标寄存器 `$0`。
  - 存取类：offset 正/零/负、base 正/零/负、地址范围、word 每 byte 非零。
  - 跳转类：跳转/不跳转，目标在前/当前/后。
- Mars 对拍时要保持 Memory Configuration 为 `Compact, Data at Address 0`。

调试方式：

- 直接观察 Logisim 子电路、寄存器、DM。
- 将直接产生结果的指令结果存入内存，最后比较内存。
- 对不直接产生结果的跳转指令，通过存入不同值或不同数量的值体现行为差异。
- 可借鉴 Logisim 自动化测试思想。

插件需求：

- MARS `code.txt` -> Logisim ROM 文件。
- P3 指令覆盖 checklist。
- DM 导出比对工具。
- CPU 数据通路图模板。

### 4.7 P4：Verilog 单周期 CPU

测评方式：

- Verilog 实现单周期 CPU。
- 顶层模块必须严格为：

```verilog
module mips(
    input clk,
    input reset
);
```

- IM 容量 `16KiB`，DM 容量 `12KiB`。
- 复位后 PC 指向 `0x00003000`，GRF 和 DM 清零。
- 复位期间不要输出存储操作信息。
- 加减法按无符号处理，不考虑溢出。

评测输出要求：

GRF 写入：

```verilog
$display("@%h: $%d <= %h", WPC, Waddr, WData);
```

DM 写入：

```verilog
$display("@%h: *%h <= %h", pc, addr, din);
```

测试方式：

- MARS 导出 `code.txt`。
- Verilog IM 用 `$readmemh("code.txt", im);`。
- ISim/VCS 运行 testbench。
- 输出与 MARS 标准行为对拍。

调试方式：

- ISim 查看 Memory/GPR/DM/IM。
- 波形定位 PC、控制信号、ALU、GRF、DM。
- 编译预处理宏定义可减少 magic number。

插件需求：

- 顶层接口静态检查。
- `$display` 格式检查。
- `code.txt` 自动放置和 `$readmemh` 路径检查。
- 输出事件流对拍。

### 4.8 P5：流水线 CPU

测评方式：

- P5 设计流水线 CPU，重点是数据冒险、控制冒险、转发、阻塞。
- 顶层模块仍为 `mips(input clk, input reset)`。
- 输出格式相较 P4 增加 `$time`：

```verilog
$display("%d@%h: $%d <= %h", $time, WPC, Waddr, WData);
$display("%d@%h: *%h <= %h", $time, pc, addr, din);
```

- 评测不仅看结果，还看周期范围；常见可转发冲突应尽量转发，不应全部用暂停。
- 课上重点提问冲突解决方案，成绩与周期数、问答情况相关。

测试方式：

- 单指令功能测试与流水线功能测试分离。
- 构造以指令块为单位的测试，覆盖转发/暂停。
- 推荐覆盖性测试而不是盲目长随机：
  - 选择指令类。
  - 枚举特定指令或随机指令。
  - 枚举两条相关指令并插入 0 到 2 条无关指令。
  - 或枚举五级流水中除 IF 外最多四条连续指令。
- 使用 P5 覆盖率分析工具检查转发四元组、阻塞三元组和有效性。
- 自动化测试链：MARS 标准输出/机器码 + ISim/VCS 输出 + 对拍。

调试方式：

- 先复现 bug。
- 对可复现 bug，打印所有指令执行情况、GRF 写入、DM 写入并与 MARS 对拍。
- 首个不同事件若 PC 错误，优先查跳转执行流；若 GRF/DM 错误，查对应指令附近波形。
- 再查看出错时刻附近的 PC、流水线寄存器、转发选择、stall/flush、控制信号。

插件需求：

- P5/P6 流水线事件表：按周期显示 F/D/E/M/W。
- 转发/阻塞信号自动标注。
- hazard 覆盖率图。
- 生成测试块脚手架。
- 首差定位：MARS event vs simulation event。

### 4.9 P6：外置存储器、字节访存、乘除模块

测评方式：

- 顶层接口改为外置 IM/DM 与写回监控信号，不允许包含 `display` 语句：

```verilog
module mips(
    input clk,
    input reset,
    input [31:0] i_inst_rdata,
    input [31:0] m_data_rdata,
    output [31:0] i_inst_addr,
    output [31:0] m_data_addr,
    output [31:0] m_data_wdata,
    output [3:0] m_data_byteen,
    output [31:0] m_inst_addr,
    output w_grf_we,
    output [4:0] w_grf_addr,
    output [31:0] w_grf_wdata,
    output [31:0] w_inst_addr
);
```

- 复位后 PC 指向 `0x00003000`，GRF 清零。
- 继续关注周期范围、转发/暂停方案。
- 字节访存通过 `m_data_byteen` 实现。

测试方式：

- P5 测试方法继续适用，并增加：
  - `lb/lh/lw/sb/sh/sw` 的对齐、符号扩展、字节使能覆盖。
  - 乘除模块 `mult/multu/div/divu/mfhi/mflo/mthi/mtlo`，包括忙周期、HI/LO、除零规避。
  - 外置 IM/DM 接口时序。
- P5 覆盖率工具支持 P5/P6 测试集分析。

调试方式：

- 重点检查外部存储接口：地址、写数据、字节使能、M 级 PC。
- 乘除模块调试需关注 busy/start、HI/LO 写回时机、流水线阻塞。
- 禁止 display 后，应依赖 testbench 监控顶层输出。

插件需求：

- P6 顶层接口检查与 `display` 禁用检查。
- byte-enable 可视化。
- 外置 memory testbench 生成。
- MDU 状态视图和测试模板。

### 4.10 P7：微系统、中断与异常

测评方式：

- MIPS 处理器须为流水线，微系统须支持中断和异常。
- 标准以《See MIPS Run Linux》和课程规范为准，测试时不以普通 MARS 为准。
- 顶层接口在 P6 基础上新增外部中断、宏观 PC、中断发生器接口：

```verilog
module mips(
    input clk,
    input reset,
    input interrupt,
    output [31:0] macroscopic_pc,
    output [31:0] i_inst_addr,
    input [31:0] i_inst_rdata,
    output [31:0] m_data_addr,
    input [31:0] m_data_rdata,
    output [31:0] m_data_wdata,
    output [3:0] m_data_byteen,
    output [31:0] m_int_addr,
    output [3:0] m_int_byteen,
    output [31:0] m_inst_addr,
    output w_grf_we,
    output [4:0] w_grf_addr,
    output [31:0] w_grf_wdata,
    output [31:0] w_inst_addr
);
```

- 顶层至少包含 CPU、Bridge、Timer0、Timer1。
- Bridge 必须独立于 CPU，访问外设均通过系统桥。
- CP0 必须实现 SR、CAUSE、EPC。
- 支持新增 `mfc0`、`mtc0`、`eret`、`syscall`。
- `eret` 没有延迟槽，后续指令不应执行。
- 异常入口为 `0x4180`。
- 中断优先级高于异常。
- 支持精确异常，教程列出 MDU 状态例外。
- 支持异常码 Int、AdEL、AdES、Syscall、RI、Ov。

官方测试说明：

- 测试允许从 `0x417C` 直接前进到 `0x4180`，此时行为与 P6 一致。
- 测试不会跳转到未加载指令位置。
- `eret` 只出现在中断处理程序中。
- 测试可能写 SR/EPC，不写 Cause。
- 中断发生器通过 `sb $0, 0x7f20($0)` 响应。
- 中断处理程序会读写寄存器和内存验证正确性。
- 教程提供官方 tb 示例和课程修改版 Mars。

测试方式：

- 使用官方 tb 正常/中断样例。
- 用课程修改版 Mars 辅助本地测试。
- 构造异常/中断场景：取指/访存地址错误、RI、syscall、Ov、BD、eret、Timer、中断发生器。

调试方式：

- 观察 macroscopic_pc、EPC、BD、EXL、Cause.IP、HWInt。
- 确认 Bridge 地址译码和 Timer 中断接线。
- 检查异常提交级、流水线清空、受害指令 PC。
- 对 P7 不可简单套用普通 MARS 对拍。

插件需求：

- P7 接口与地址空间静态检查。
- CP0/异常现场可视化。
- 官方 tb 模板管理。
- 中断触发脚本：按 macroscopic_pc 产生 interrupt。
- 支持 P7 课程 Mars 路径单独配置。

## 5. 一站式 VSCode 插件功能设计建议

### 5.1 插件核心模块

| 模块 | 必要能力 | 对应教程需求 |
|---|---|---|
| 环境管理 | 检测 Java、MARS、Logisim、ISE、Python、Hazard jar | `mips`、`verilog`、`P5` |
| 课程项目向导 | 创建 P0-P7 工程模板、目录结构、示例 tb、脚本 | 全 Project |
| MARS 集成 | 运行、导出机器码、导出异常处理程序、标准输出、延迟槽/内存配置 | `mips`、`P2-P7` |
| Verilog 仿真 | ISE/fuse | `verilog`、`P1/P4-P7` |
| 波形与调试 | 打开 ISim，提示信号添加和 radix | `verilog-5` |
| CPU 对拍 | 解析 MARS 输出与仿真输出，首差定位 | `P4-P6` |
| 流水线分析 | hazard 覆盖率、周期范围、转发/阻塞可视化 | `P5/P6` |
| Logisim 辅助 | ROM 文件生成、`.circ` XML 识别、Logging 解析 | `logisim`、`P0/P3` |

### 5.2 建议命令清单

```text
CO: Check Toolchain
CO: Create Project
CO: Configure MARS
CO: Assemble with MARS
CO: Dump Text Segment
CO: Run MARS and Capture Output
CO: Generate Logisim ROM File
CO: Generate ISE PRJ/TCL
CO: Run ISim
CO: Compare CPU Trace
CO: Analyze Pipeline Hazards
CO: Package Testcases
```

### 5.3 配置项建议

```json
{
  "co.mars.jar": "path/to/Mars.jar",
  "co.mars.p7Jar": "path/to/course-p7-mars.jar",
  "co.logisim.jar": "path/to/logisim.jar",
  "co.xilinx.isePath": "path/to/ISE_DS/ISE/",
  "co.vcs.enabled": true,
  "co.verdi.enabled": true,
  "co.iverilog.path": "iverilog",
  "co.python.path": "python",
  "co.hazardCalculator.jar": "path/to/Hazard-Calculator.jar",
  "co.submit.command": "co-submit",
  "co.defaultProject": "P5"
}
```

### 5.4 章节感知规则

插件应该根据工程类型启用不同规则：

| 工程 | 自动规则 |
|---|---|
| P0/P3 Logisim | 支持 `.circ`、ROM `v2.0 raw`、Logging |
| P1 | Verilog testbench、ISE/VCS runner、代码规范 |
| P2 | MARS no-delay-slot、`syscall` 结束、`CompactDataAtZero` |
| P4 | 顶层 `mips(clk, reset)`、`$display("@%h...")` |
| P5 | 顶层同 P4、`$display("%d@%h...")`、流水线 hazard |
| P6 | 外置存储接口、禁止 `display`、byte-enable |
| P7 | P7 微系统接口、CP0/异常/中断、课程 Mars |

### 5.5 最小可行版本路线

第一阶段：本地运行闭环

- MARS 配置、运行、导出 `code.txt`。
- P4/P5/P6 工程模板。
- Icarus 快速仿真 + ISE/VCS 外部任务入口。
- 输出日志解析和简单对拍。

第二阶段：课程专用检查

- P4/P5/P6/P7 顶层接口检查。
- `$display` 格式检查和 P6 禁用检查。
- `readmemh` 路径、IM/DM 容量、PC 起始地址提示。
- 常见 ISE/Verilog 错误解释。

第三阶段：流水线与调试增强

- P5/P6 hazard 分析器集成。
- `hazard.json` Webview。
- 波形打开、信号清单建议、首差定位到 PC/周期。

第四阶段：Logisim 与提交集成

- Logisim ROM 文件生成、Logging 解析。
- `.circ` 结构辅助。
- `co-submit` 封装、提交包预览、提交间隔/次数提示。

## 6. 风险与边界

- VCS/Verdi 是专有软件，插件不能内置分发，只能调用用户已有安装或课程虚拟机环境。
- Icarus Verilog 结果不能作为最终评测标准，只适合作为快速检查。
- P7 不能简单使用普通 MARS 作为黄金模型，必须使用课程修改版 Mars 或官方 tb。
- 自动测试通过不等于 Project 完成，课程还有人工检查、问答、设计规范和查重。
- 插件不应生成可直接规避课程考核的答案，只应提供工程化、测试和调试工具。

## 7. 关键源码/页面索引

- `tutorial/vm/intro/index.html`：虚拟机环境与 VCS/Verdi 说明。
- `tutorial/vm/terminal/index.html`：Linux 终端与脚本。
- `tutorial/vm/submission-script/index.html`：`co-submit`。
- `tutorial/logisim/logisim-5/logisim-5-1/index.html`：Logisim 仿真。
- `tutorial/logisim/logisim-5/logisim-5-2/index.html`：Step Simulation。
- `tutorial/logisim/logisim-6/logisim-6-1/index.html`：Logging。
- `tutorial/logisim/logisim-6/logisim-6-4/index.html`：`.circ` XML 自动生成。
- `tutorial/logisim/logisim-6/logisim-6-5/index.html`：Logisim 自动化测试。
- `tutorial/mips/mips-3/mips3-5/index.html`：MARS 编写、运行与调试。
- `tutorial/mips/mips-3/mips3-7/index.html`：MARS 代码与数据导出。
- `tutorial/mips/mips-6/mips6-1/index.html`：CPU 测试程序设计。
- `tutorial/mips/mips-6/mips6-2/index.html`：测试程序在 Logisim/Verilog CPU 中使用。
- `tutorial/verilog/vcs/project-structure/index.html`：VCS 示例工程结构。
- `tutorial/verilog/vcs/compile/index.html`：VCS 编译。
- `tutorial/verilog/vcs/run/index.html`：VCS 运行与 FSDB。
- `tutorial/verilog/vcs/verdi/index.html`：Verdi 波形调试。
- `tutorial/verilog/verilog-5/verilog-5-7/index.html`：生成 Testbench。
- `tutorial/verilog/verilog-5/verilog-5-8/index.html`：ISim 仿真调试。
- `tutorial/verilog/verilog-5/verilog-5-9/index.html`：ISE 报错与调试样例。
- `tutorial/verilog/verilog-6/verilog-6-6/index.html`：ISE/VCS 自动化测试。
- `tutorial/verilog/verilog-6/verilog-6-7/index.html`：Icarus Verilog。
- `tutorial/verilog/verilog-6/verilog-6-8/index.html`：MARS 自动化测试。
- `tutorial/P3/P3-4/index.html`：Logisim CPU 测试。
- `tutorial/P4/P4-7/index.html`：P4 在线测试与输出格式。
- `tutorial/P5/methodology/P5-1-3/index.html`：P5 调试建议。
- `tutorial/P5/testcases/P5-4-1/index.html`：流水线测试构造。
- `tutorial/P5/testcases/P5-4-5/index.html`：覆盖率分析。
- `tutorial/P5/testcases/P5-4-6/index.html`：分析工具使用。
- `tutorial/P5/testcases/P5-4-7/index.html`：自动化测试命令。
- `tutorial/P5/project/P5-5-2/index.html`：P5 在线测试与输出格式。
- `tutorial/P6/P6-6/index.html`：P6 顶层接口与评测说明。
- `tutorial/P7/implement/P7-2-6/index.html`：P7 提交要求与官方测试说明。
- `tutorial/CO_Simulator/Simulator-1/index.html`：CO-Simulator 与 trace。
- `tutorial/CO_Simulator/Cache/Cache-Simulator/index.html`：Cache 模拟器使用。

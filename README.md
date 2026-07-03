# BUAA CO 工具箱（VSCode 插件）

面向北航计算机组成（CO）实验的开箱即用 VSCode 插件，覆盖 **MIPS 汇编、Verilog、Logisim** 三套工作流，并为 P3–P7 的 CPU 提供**一键随机对拍测试**（生成测试点 → MARS 黄金模型 → Logisim/ISim 仿真 → 自动对拍 → 报告，循环进行）。

---

## 平台支持

| 功能 | Windows | Linux | macOS |
|---|---|---|---|
| 语言特性（高亮 / 补全 / 诊断 / 格式化 / 大纲 / 折叠） | ✅ | ✅ | ✅ |
| Logisim（打开 / ROM 生成 / 注入 / 日志转 CSV） | ✅ | ✅ | ✅ |
| MARS 运行 / dump 机器码（Java） | ✅ | ✅ | ✅ |
| 流水线冲突分析（Java + Python） | ✅ | ✅ | ✅ |
| **ISim 仿真（依赖 Xilinx ISE）** | ✅ | ⚠️ | ❌ |
| **一键随机对拍（P3 依赖 Logisim；P4–P7 依赖 ISim）** | ✅ | ⚠️ | P3 ✅ / P4–P7 ❌ |

- **ISim 仿真与 P4–P7 Verilog 自动对拍依赖 Xilinx ISE**，而 ISE 只发布过 Windows 与 Linux 版本：**macOS 无法运行 Verilog 仿真**，P1 / P4 / P5 / P6 / P7 的仿真与自动对拍均不可用；P3 Logisim 对拍不依赖 ISE（语言特性、Logisim、MARS、冲突分析仍可正常使用）。
- Linux（⚠️）：ISE 14.7 可用，但在现代 64 位发行版上通常需按照指导书自行处理兼容性问题
- 其余功能为 TS / Java / Python 实现，三平台通用。`co.toolchain.python` 留空时会自动检测（macOS / Linux 优先 `python3`，Windows 优先 `python` / `py`）。

---

## 1. 快速开始

### 第一步：装好外部工具并填路径

先下载 [`MARS P7` 魔改版](https://github.com/stone926/Mars-with-BUAA-CO-extension/releases)

打开 VSCode 设置（`Ctrl+,`），搜索 `co.toolchain`，按你的 Profile 需要填写：

```jsonc
{
  // MIPS / 对拍黄金模型（建议用修改版 Mars，支持 coL1 对拍输出）
  "co.toolchain.mars": "修改版 Mars 的路径",
  // P7 专用 Mars（需支持 efc / p7irq / coL1）；不填则回退到上面的 mars
  "co.toolchain.marsP7": "修改版 Mars P7 的路径",
  // Verilog 仿真（Xilinx ISE/ISim 的安装目录，注意指到 .../ISE_DS/ISE）
  "co.toolchain.isePath": "ISE 的路径，此路径下应包含名为 bin 等文件夹",
  // Logisim（P0/P3）
  "co.toolchain.logisim": "Logisim 的路径",
  // Java（保持默认即可）；Python 留空自动检测（macOS/Linux 优先 python3）
  "co.toolchain.java": "java",
  "co.toolchain.python": ""
}
```

> 填完后执行命令 **`CO: 检查工具链`**（侧边栏也有按钮），逐项确认 Java / MARS / ISE / Logisim 是否就绪。

### 第二步：告诉插件当前是哪个 Profile

- 用命令 **`CO: 选择项目 Profile`**（P0–P7），或在 VS Code 用户/工作区设置中设置 `co.project.profile`。
- `auto` 会根据项目文件、Verilog 顶层接口和 trace 格式推断具体 P 并保存；无法唯一推断时会要求手动选择并保存。

### 第三步：一键跑测试

打开侧边栏「**BUAA CO Toolkit**」面板 →「操作」区，点：

- **持续生成测试**（P3–P7）
  → 插件自动循环执行：**生成随机测试点 → MARS dump 机器码 → Logisim/ISim 跑你的 CPU → MARS 跑黄金 trace → 对拍 → 出报告**，发现不一致会停下并定位首个差异。

低频入口（单次/批量对拍、生成器、VCD、Logisim CSV、Hazard 分析等）统一放在侧边栏 **更多工具...** 或命令面板 **`CO: 更多工具`**。

P7 的默认模式仍是精确 trace 对拍（`co.test.p7.stressMode: "anchor"`）。如果切到 `probe`，流程会变成 **MARS 只负责 dump 机器码 → ISim 跑 CPU → 检查 probe 性质**，不再运行 MARS trace oracle；见下文 P7 专项说明。

就这么简单。下面是细节。

---

## 2. 核心功能：一键随机对拍测试（P3–P7）

这是本插件最重要的能力。它把课程对拍流程全自动化：

```
随机生成器  →  ASM 测试点  →  MARS dump 机器码 ──┐
                                               ├─→ 对拍 GRF/DM 写  →  报告（首个差异定位）
                          MARS 黄金 trace ──────┘
                          你的 CPU（ISim/Logisim 仿真）┘
```

### 怎么触发（侧边栏 / 更多工具）

| 我想…… | 入口 |
|---|---|
| **一直循环跑，直到出错或我手动停**（推荐） | 侧边栏「操作」→「持续生成测试」，命令面板也保留同名入口 |
| 停止持续测试 | 侧边栏「操作」→「停止持续测试」，命令面板也保留同名入口 |
| 查看历史 ASM case | 侧边栏「操作」→「查看 ASM 用例记录」，命令面板也保留同名入口 |
| 单次/批量/生成后对拍 | 侧边栏「操作」→「更多工具...」 |
| 只生成测试点或只 dump 机器码 | 侧边栏「操作」→「更多工具...」 |
| 手动比较 trace 输出 / 打开批量报告 | 侧边栏「操作」→「更多工具...」 |

持续测试会打开一个**实时监控面板**，并把每轮结果写到 `.co/out/continuous-trace-report.json`（即使关掉 VSCode 也能看）。默认遇到第一个失败/异常就停（可用 `co.test.continuousStopOnFailure: false` 关闭）。为了避免 `.co` 越跑越乱，持续测试的 trace 输出会直接写入对应 `.co/cases/<caseId>/`，通过 case 默认只保留最近 20 个；失败和异常 case 始终保留用于复现。

### 内置随机生成器

插件自带随机 ASM 生成器（默认启用，`co.test.builtinGenerator.enabled`），无需自己写脚本。它会：

- 按 Profile 选用合适的默认指令集（也可用 `co.test.builtinGenerator.instructions` 自定义，逗号或空格分隔，只接受真实指令）；
- 在内部**建模 CPU 状态**（寄存器、HI/LO、内存、CP0），从而生成**合法、确定**的测试点：避免除零、避免非预期的地址错/溢出、正确处理延迟槽与乘除部件占用窗口、在跳转后插入“毒化”指令检验控制流；
- 生成数量由 `co.test.builtinGenerator.instructionCount`（P3–P6）/ `co.test.builtinGenerator.p7InstructionCount`（P7，默认/上限 1118）控制。

默认指令集：

| Profile | 默认指令 |
|---|---|
| P3 | `add, sub, ori, lw, sw, beq, lui, nop` |
| P4 | `add, sub, ori, lw, sw, beq, lui, jal, jr, nop` |
| P5 | `add, sub, ori, lw, sw, beq, lui, jal, jr, nop` |
| P6 | `add, sub, and, or, slt, sltu, lui, addi, andi, ori, lb, lh, lw, sb, sh, sw, mult, multu, div, divu, mfhi, mflo, mthi, mtlo, beq, bne, jal, jr` |
| P7 | `nop, add, sub, and, or, slt, sltu, lui, addi, andi, ori, lb, lh, lw, sb, sh, sw, mult, multu, div, divu, mfhi, mflo, mthi, mtlo, beq, bne, jal, jr, mfc0, mtc0, eret, syscall` |

> 也可以用**外部生成器**：打开你的 `.py/.js/.jar/.bat/.cmd/.exe/.ps1` 生成器文件再触发测试，或关掉 `co.test.builtinGenerator.enabled`。用 `co.test.generatorArgs` 传种子/数量等参数。

### P7 专项说明（异常 + 外部中断 + Timer）

P7 在普通流水线 CPU 基础上加了 CP0、异常、外部中断、Timer。本插件的 P7 对拍：

- **`anchor` 模式（默认）**：运行 MARS 黄金 trace + ISim trace，精确比较 GRF/DM 写事件。外部中断由生成器选定的安全 anchor PC 驱动，MARS 与 testbench 在同一架构点注入。此模式适合对拍。
- **`probe` 模式**：生成黑盒 probe ASM，MARS 只 dump 机器码。CPU 运行时由软件 handler 在 DM `0x2800` 起写 probe log，checker 检查异常码、IP 位、EPC 窗口、外部中断响应、Timer CTRL 清零等课程可观察性质。此模式适合高强度测外部中断/Timer，但不是逐指令黄金模型对拍。
- **`hybrid` 模式**：同一轮生成一个 `anchor` 精确对拍用例和一个 `probe` 性质检查用例。
- **`off` 模式**：关闭 P7 外部中断/Timer 压测；仍可按 `co.test.p7.exceptionRate`/`exceptionTypes` 生成普通 P7 异常与指令对拍。
- **内部异常覆盖**：默认覆盖课程要求的 AdEL、AdES、Syscall、RI、Ov。`exceptionRate` 只影响 anchor/random body；probe 内部异常覆盖由 `co.test.p7.exceptionTypes` 控制。
- **外部中断**（`co.test.p7.interrupt`，默认开）：anchor 使用安全 PC 注入；probe 使用“软件 arm 标记 `0x27d0` + wait PC”双条件触发，避免内部异常 flush 后宏观 PC 不确定导致误拉高中断。
- **Timer**：anchor 不做 Timer 中断精确对拍，因为 MARS 与 Verilog 的计时基准不同。probe 可在 `co.test.p7.timerInterrupt: true` 时测试 Timer0/Timer1 中断性质，但只检查课程可观察语义，不检查精确触发周期。
- **内存布局**：P7 固定用 `CompactLargeText`（异常入口 0x4180），机器码 dump 会自动合并用户段 + 0x4180 内核段。
- **必须使用修改版 Mars**（支持 `efc`/`p7irq`/`coL1`，RI 还需要 `cl _co_internal_unknown_instruction.class`），配在 `co.toolchain.marsP7`。

Probe handler 只读取课程要求的 CP0 `SR($12)`、`Cause($13)`、`EPC($14)`，不读取、不检查 `BadVAddr($8)`。外部中断响应使用 `sb $0, 0x7f20($0)`；Timer 只通过 `lw/sw` 访问 CTRL/PRESET/COUNT，不写 Count，不用 byte/half 访问 Timer。

### 输出/对拍约定

- 两端 trace 格式一致：`@PC: $寄存器 <= 值`（寄存器写）、`@PC: *地址 <= 值`（内存写）。
- 对拍**默认忽略周期/时间**，只比较 PC、目标、值（可在手动对拍时切换严格模式）。
- 标准输入自动配对：`foo.asm` 旁的 `foo.in / foo.input / foo.stdin / foo.dat`（及 `foo.xxx.in`、`input/tests/data` 等子目录）会自动作为 stdin。
- 报告与中间产物都在工程下的 `.co/` 目录（见第 6 节）。

### 如何理解测试结果

- `anchor`/普通 trace 对拍失败通常表示 CPU 与 Mars 在某个**可见写事件**上不一致；首个差异不一定就是根因，流水线错误常会在若干周期后才表现为 GRF/DM 写错。
- `probe` 失败表示某个 P7 性质不满足，报告会给出 scenario、Cause、EPC、期望 IP/ExcCode、缺失的 ack/clear 等信息；它不是 Mars trace mismatch。
- 通过不等于“完全正确”：随机测试只覆盖已生成样例，trace 只观察 GRF/DM 写，probe 只观察课程规定端口与软件日志。CP0 内部位、未被后续读取的数据、纯时序性能问题、未启用的异常类型都可能需要补充定向测试。
- 需要复现时优先保留失败/异常报告中指向的 `.co/cases/<caseId>/` 和 `.co/out/continuous-trace-report.json`；case 目录包含 ASM 快照、机器码、trace 输出、seed、mode、中断/probe 元数据和首个差异。

---

## 3. 其他功能

### MIPS 汇编
语法高亮、补全、悬浮提示、标签/定义跳转、诊断、格式化；以及：
- 侧边栏「操作」只放常用的 ASM 运行和文本段导出；
- 带标准输入运行、终端运行和 P7 内核段导出放在「更多工具...」，编辑器标题栏仍保留终端运行和文本段导出的快捷按钮。

### Verilog
高亮、模块/信号大纲、悬浮、定义跳转、隐式连线诊断、课程 Lint、可综合性检查、格式化；以及：
- 侧边栏「操作」保留 ISim 运行、波形查看和信号连线；
- 生成 Testbench、ISE 语法检查、信号连线在 Verilog 右键菜单；ISE 工程生成和 VCD 导出放在「更多工具...」。
- **信号连线面板**：把光标放在任一信号上，自动列出它的**声明**、**驱动/写**（`assign`、`always` 赋值、子模块 output 端口）、**读取/使用**（RHS、子模块 input 端口），点击条目跳转到源码。该面板默认只在 Verilog 上下文或执行“查看信号连线”后出现。

### 语义着色与主题适配
插件默认对 MIPS ASM 和 Verilog 开启 semantic highlighting，并根据当前 VS Code 主题明暗自动应用 CO 自定义 token 配色。MIPS 指令类型、CP0 寄存器、Verilog 模块/端口等语义分类仍会输出；若你手动改过某个 token 颜色，插件不会覆盖该 token。

可用 `co.semanticColors.preset` 选择 `auto` / `dark` / `light` / `off`，详见 [语义着色配色预设](docs/semantic-colors.md)。

### Logisim（P0 / P3）
`.circ` 识别、电路/组件大纲、标签诊断；以及：
- 侧边栏「操作」在当前 `.circ` 文件上提供打开电路和注入 ROM；
- 生成 ROM、日志转 CSV、P3 trace 电路诊断、批量准备电路用例放在「更多工具...」；
- P3 Trace 对拍读取顶层 `main`（可用 `co.test.logisim.mainCircuit` 改）中的 `Instr, pc, RegWrite, RegAddr, RegData, MemWrite, MemAddr, MemData`。Logisim CLI 的 stdout 列序按 Logisim 2.7.1 源码规则解析：先收集 appearance ports，再按实际 Pin 坐标从上到下、从左到右输出；插件优先用标准 label 映射，label 不完整时按教程外观/Pin 顺序推断，也可用 `co.test.logisim.traceColumns` 显式指定 stdout 列号；
- P3 Logisim 对拍不要求电路提供 `halt` pin。插件会给 ROM 末尾追加停机自环，并在 `pc` 到达注入的 halt PC 时结束仿真；若暴露 `Instr`，插件会额外检查 `Instr` 与当前 PC 对应机器码是否一致；
- P3 trace 电路诊断可在运行前输出 circuit、ROM、output pin、位宽、坐标、appearance 顺序和最终语义映射；P3 电路应当只有一个 32 位 ROM；
- 批量准备会把机器码注入 `.circ` 副本，并写到 `.co/cases/<caseId>/logisim/`。

### 流水线冲突分析（P5/P6/P7）
- 在「更多工具...」中提供冲突分析和打开报告（需配置 `co.toolchain.hazardCalculator`）。

### 项目辅助
- 命令面板只保留 `CO: 项目向导`、`CO: 选择项目 Profile`、`CO: 检查工具链`、`CO: 打开课程教程`、持续测试启动/停止、ASM 用例记录和 `CO: 更多工具`。其余命令仅通过侧边栏或编辑器上下文菜单触发，不出现在命令面板中。

---

## 4. 配置项（按 Settings UI 分组）

> 优先级：VS Code 用户/工作区设置 `co.*` → 默认值。工作区设置可写在 `.vscode/settings.json`。
> 设置 UI 保留完整细项，但只分成四组：`项目基本情况`、`工具链`、`运行与测试`、`编辑器与诊断`。

### 项目基础 / 工具链

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.project.profile` | `auto` | 当前 Profile（P0–P7 / auto；auto 会推断具体 P 并保存，无法推断时要求选择） |
| `co.toolchain.mars` | — | Mars jar（非 P7 对拍） |
| `co.toolchain.marsP7` | — | P7 专用 Mars（需 efc/p7irq/coL1） |
| `co.toolchain.isePath` | — | ISE 安装目录（`.../ISE_DS/ISE`） |
| `co.toolchain.logisim` | — | Logisim jar |
| `co.project.simTime` | `200us` | ISim 运行时长（写入 TCL `run <值>; exit`） |

其余基础/工具链项：`co.project.topModule`(`mips`)、`co.project.testbench`(`mips_tb`)、`co.project.machineCode`(`code.txt`)、`co.project.simBackend`(`isim`)、`co.toolchain.java`、`co.toolchain.python`、`co.toolchain.hazardCalculator`、`co.course.tutorialRoot`。

### 运行与测试

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.test.builtinGenerator.enabled` | `true` | 使用内置随机生成器 |
| `co.test.builtinGenerator.instructionCount` | `4000` | P3–P6 主程序指令数 |
| `co.test.builtinGenerator.p7InstructionCount` | `1118` | P7 主程序指令数（上限 1118，0x4180 之前） |
| `co.test.builtinGenerator.instructions` | `""` | 自定义指令集（空=用当前 Profile 默认；默认集见“内置随机生成器”） |
| `co.test.p7.stressMode` | `"anchor"` | P7 压测模式：`anchor` 精确对拍、`probe` 黑盒性质检查、`hybrid` 两者都跑、`off` 关闭中断/Timer 压测 |
| `co.test.p7.interrupt` | `true` | P7 是否生成外部中断场景；关掉后 anchor/probe 都不会注入外部中断 |
| `co.test.p7.timerInterrupt` | `false` | probe/hybrid 的 probe 用例是否生成 Timer0/Timer1 中断场景 |
| `co.test.p7.externalInterruptIntensity` | `0.25` | probe 外部中断场景随机补齐强度（0–1） |
| `co.test.p7.timerIntensity` | `0.20` | probe Timer 场景随机补齐强度（0–1） |
| `co.test.p7.probeScenarioCount` | `32` | 每个 probe ASM 的场景数，最大 64 |
| `co.test.p7.exceptionRate` | `0.08` | P7 anchor/random body 主动制造内部异常的比例（0–1） |
| `co.test.p7.exceptionTypes` | `["AdEL","AdES","Syscall","RI","Ov"]` | P7 主动覆盖的异常类型；probe 内部异常覆盖按此配置生成 |
| `co.test.continuousIntervalMs` | `1000` | 持续测试两轮间隔（毫秒） |
| `co.test.continuousMaxIterations` | `0` | 持续测试最大轮数（0=不限） |
| `co.test.continuousStopOnFailure` | `true` | 失败/非法即停 |
| `co.test.continuousRetainedPassingCases` | `20` | 持续测试保留的最近通过 case 数；失败/异常 case 始终保留 |
| `co.test.continuousReportRetainedIterations` | `200` | 持续测试 JSON 报告保留的最近轮数；失败/异常轮始终保留 |
| `co.test.generatorArgs` | `[]` | 传给内置/外部生成器的额外参数（如种子、数量） |
| `co.test.generatedAsmLimit` | `100` | 一轮拾取的新建/修改 ASM 上限 |
| `co.test.logisim.mainCircuit` | `"main"` | P3 Logisim Trace 顶层 circuit 名称 |
| `co.test.logisim.traceColumns` | `{}` | P3 Logisim Trace stdout 显式列映射，零基列号 |

运行细项也在本组：`co.run.showCommandBeforeRun`(`false`，运行前打印完整命令)、`co.run.revealOutput`(`false`，运行外部工具时是否自动弹出「输出」面板；默认不弹，仅静默写入)、`co.run.timeoutMs`(`120000`)。

### 编辑器与诊断

MIPS / MARS 行为：

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.mips.memoryConfiguration` | `auto` | 内存模式（auto：P3–P6=FixedCompactLargeText，P7=CompactLargeText） |
| `co.mips.delayedBranching` | `profile` | 延迟槽（profile：P5/P6/P7 启用） |
| `co.mips.extraArgs` | `[]` | 追加 MARS 命令行参数 |
| `co.mips.warnPseudoInstruction` | `true` | 使用伪指令时告警 |
| `co.mips.warnMissingExitSyscall` | `true` | P2 缺少退出 syscall 时告警 |
| `co.mips.instructionColorMode` | `realVsPseudo` | 指令着色方式 |

同组还包含：`co.semanticColors.preset`、`co.verilog.implicitNet.*`（隐式连线）、`co.verilog.syntax.ise.*`（保存时 ISE 语法检查）、`co.verilog.lint.*`（课程 Lint、可综合性、禁用规则）、`co.verilog.format.*`（风格、续行缩进、位宽间距等）、`co.diagnostics.disabledCodes` / `disabledFileCodes`。

Verilog 格式化的纵向对齐细项：`co.verilog.format.parameterAlignment` 默认 `equals`，会对齐连续 `parameter` / `localparam` 声明中的等号；`co.verilog.format.modulePortAlignment` 默认 `name`，会对齐多行 `module` 声明中的端口名。紧凑风格 `compact` 会将这两项预设为 `none`，自定义风格可单独覆盖。

---

## 5. ⚠️ 特别注意事项

1. **P7 必须用修改版 Mars**：普通 Mars 不支持 `efc`/`p7irq`/`coL1`，不输出寄存器和内存写入日志，**不能**当 P7 黄金模型。请把 `co.toolchain.marsP7` 指向支持这些参数的 `Mars.jar`。插件会在检测到不支持时给出明确提示。
2. **RI 异常依赖 Mars 额外指令加载**：插件用 `_co_internal_unknown_instruction` 作为 MARS 可识别、CPU 不应识别的未知指令，并通过 `cl _co_internal_unknown_instruction.class` 加载。该 class 打包在此插件中，若 Mars 不支持 `cl`，RI 测试会失败或无法 dump。
3. **ISE 路径要指到 `.../ISE_DS/ISE`**，此目录下有 `bin`。例如 `D:/ISE/14.7/ISE_DS/ISE`。`fuse` 会编译工作区里**所有** `.v`；P7 自动测试会生成一个**专用 testbench**（不会覆盖你自己的 `mips_tb.v`）。
4. **anchor 外部中断对拍仍依赖宏观 PC 约定**：testbench 只能从官方 `mips` 顶层端口看到宏观写回/访存信息，无法读取学生内部流水级。若你的实现对异常 flush 后的宏观 PC 暴露方式不同，anchor 外部中断可能出现假阳性；可切到 `probe` 或关闭 `co.test.p7.interrupt`。
5. **probe 不是完整黄金模型**：probe 只检查课程可观察性质，不比较每条普通指令的 MARS trace，也不判断 Timer 精确触发周期。probe 通过只能说明这些性质通过，不等价于 CPU 全部行为正确。
6. **probe 会占用部分 DM 地址**：log 固定从 `0x2800` 开始，每条 8 word；`0x27d0` 用作 external arm 标记，`0x27e0..0x27ec` 用作 handler 状态。随机 DM 扰动会避开 `0x27d0..0x2fff` 和 `0x7f00..0x7f2f`。手写 probe 用例或外部生成器不要覆盖这些区域。
7. **BadVAddr 不测试**：课程不要求实现 BadVAddr，本插件的 P7 handler/probe 不读取、不记录、不检查 CP0 `$8`。如果你实现了 BadVAddr，需要另写专门测试。
8. **延迟槽**：P5/P6/P7 默认开启延迟槽（MARS 加 `db`）。
9. **对拍默认忽略周期**，只比较 PC/目标/值——这与课程评测一致；它**抓不到**“不体现在 GRF/DM 写上的错误”（如从不被读取的寄存器/CP0 位算错、纯时序问题）。
10. 不要把机器码 `.txt` 误当 stdin：stdin 仅按 `.in/.input/.stdin/.dat` 后缀且与 ASM 同名时自动配对。

---

## 6. 目录约定（工程下 `.co/`）

| 路径 | 内容 |
|---|---|
| `.vscode/settings.json` | 可选的工作区级 VS Code 设置（`co.*` 配置项） |
| `.co/cases/<caseId>/` | ASM case 记录：`program.asm`、`code.txt`、`case.json`、MARS/ISim/Logisim trace 与复现元数据 |
| `.co/out/*.mars.out` / `*.sim.out` | 手动单次/批量测试的 MARS / ISim 输出；持续测试默认把输出写入对应 case 目录 |
| `.co/out/trace-batch-report.json` | 批量测试报告（含命令、生成文件、首个差异） |
| `.co/out/continuous-trace-report.json` | 持续测试报告；旧通过轮会按留存策略压缩，失败/异常轮保留 |
| `.co/isim/` | ISE `.prj/.tcl`、生成的 testbench、`code.txt` |
| `.co/logisim/` | 注入机器码后的 `.circ` 副本与报告 |

---

## 7. 发布流程

发布由一条本地命令触发：

```bash
npm run publish -- patch
```

可用版本参数：

- `patch`：`0.2.0 -> 0.2.1`（默认）
- `minor`：`0.2.0 -> 0.3.0`
- `major`：`0.2.0 -> 1.0.0`
- 显式版本号：例如 `npm run publish -- 0.3.1`

本地脚本会要求工作树干净，然后执行：

1. `npm run sync:manifest-config`，生成并检查 `package.json` 中的 VS Code 配置清单；若生成文件有未提交变化会停止发布
2. `npm test` 和 `npm run compile`
3. 更新 `package.json` / `package-lock.json` 的 version
4. 根据最近一个 `v*` tag 之后的提交更新 `CHANGELOG.md`
5. 创建 `chore: release vX.Y.Z` 提交和 `vX.Y.Z` annotated tag
6. `git push origin HEAD --follow-tags`

tag 推送后，GitHub Actions 会在 Ubuntu runner 上自动执行：

1. `npm ci`
2. `npm run sync:manifest-config`，并确认生成文件已经提交
3. `npm test`
4. `npm run compile`
5. `vsce package` 生成 VSIX
6. `vsce publish --packagePath <vsix>` 发布到 VS Code Marketplace
7. 用同一个 VSIX 创建 GitHub Release

首次使用前，需要在 GitHub 仓库的 Actions secrets 中添加 `VSCE_PAT`，该 token 需要有 VS Code Marketplace 的 Manage 权限。GitHub Release 使用仓库自带的 `GITHUB_TOKEN`，不需要额外配置。

辅助命令：

- `npm run publish:dry-run`：预览下一次 release notes 和步骤，不改文件
- `npm run publish -- minor --no-push`：只在本地创建 release commit/tag，不推送
- `npm run publish -- patch --skip-tests`：跳过本地测试；manifest 配置生成和检查仍会执行，GitHub Actions 仍会测试

配置清单维护命令：

- `npm run generate:manifest-config`：从 `resources/co/configManifest.json`、`resources/co/configDefaults.json` 和课程资源生成 `package.json` 的 `contributes.configuration`
- `npm run check:manifest-config`：只检查生成结果是否已同步，不写文件
- `npm run sync:manifest-config`：先生成再检查；`compile`、`watch`、`test`、`test:coverage`、`test:watch`、`package:vsix`、`deploy` 和发布流程都会自动运行

---

如需扩展（如 Timer 模块单元测试、显式校验 CP0 寄存器值、其他后端），欢迎提 issue / 反馈。

---

## 附录

## 与 MARS 在 P7 对拍中协作

Mars 的 `coL1` 输出被本插件自动解析和对拍。`anchor` 精确对拍流程：

1. **插件** 调用修改版 Mars（普通路径为 `java -jar Mars.jar ...`；RI 路径为 `java -cp <Mars.jar;resources/mars> Mars ... cl _co_internal_unknown_instruction.class`），捕获 stdout 为 `.mars.out`
2. **插件** 生成 Verilog testbench 并运行 ISim 仿真，捕获 `$display` 输出为 `.sim.out`
3. **插件** 用同一正则解析两路输出，逐事件比对 PC、目标寄存器/地址、写入值

`probe` 流程不同：Mars 只用于 `dump .text`/内核段机器码；不会运行 `coL1` trace，也不会用 MARS 判断 Timer 或外部中断发生在哪个周期。判定来自 ISim trace 中重建出的 probe log 和 `CO_P7_PROBE ...` 诊断行。

### 对拍约定（插件依赖的 Mars 行为）

| 行为 | 说明 |
|------|------|
| 输出目标 | `coL1` → stdout，`coERR` → stderr。插件默认解析 stdout |
| 事件格式 | `@<8位hex>: <$|*><target> <= <8位hex>`（每行一个事件） |
| 事件顺序 | 按指令执行顺序输出；同一指令的多笔写操作在同一 PC 下分行输出 |
| $0 写入 | **不输出**（与 testbench `$0` 过滤一致） |
| hi/lo 写入 | **不输出**（MDU 内部寄存器，testbench 不追踪） |
| CP0 写入 | **不输出**（`mtc0` 不可见于 `$display` trace） |
| MMIO 写入 | **不输出**（Timer0 `0x7F00~0x7F08`、Timer1 `0x7F10~0x7F18`、中断响应 `0x7F20`，与 testbench 一致） |
| 内存地址 | 字对齐（`addr & ~0x3`），与 testbench `fixed_addr = m_data_addr & 32'hfffffffc` 一致 |

### 插件端参数映射

插件根据用户配置自动拼接 Mars 参数，用户无需手动操作：

| 插件配置 | 映射的 Mars 参数 |
|----------|-----------------|
| Profile `P7` | `mc CompactLargeText efc` |
| Profile `P4/P5/P6` | `mc FixedCompactLargeText` |
| `mips.delayedBranching` = `on` / `profile:P5+` | `db` |
| `test.p7.interrupt` = `true` 且 `stressMode=anchor` | `p7irq=<target_pc-4>` |
| `mips.extraArgs` | 直接附加到命令行 |

# BUAA CO 工具箱（VSCode 插件）

面向北航计算机组成（CO）实验的开箱即用 VSCode 插件，覆盖 **MIPS 汇编、Verilog、Logisim** 三套工作流，并为 P3–P7 的 CPU 提供**一键随机对拍测试**（生成测试点 → MARS 黄金模型 → 仿真 → 自动对拍 → 报告，循环进行）。

---

## 平台支持

| 功能 | Windows | Linux | macOS |
|---|---|---|---|
| 语言特性（高亮 / 补全 / 诊断 / 格式化 / 大纲 / 折叠） | ✅ | ✅ | ✅ |
| Logisim（打开 / ROM 生成 / 注入 / 日志转 CSV） | ✅ | ✅ | ✅ |
| MARS 运行 / dump 机器码（Java） | ✅ | ✅ | ✅ |
| 流水线冲突分析（Java + Python） | ✅ | ✅ | ✅ |
| **ISim 仿真（依赖 Xilinx ISE）** | ✅ | ⚠️ | ❌ |
| **一键随机对拍（P3–P7，依赖 ISim）** | ✅ | ⚠️ | ❌ |

- **ISim 仿真与一键对拍依赖 Xilinx ISE**，而 ISE 只发布过 Windows 与 Linux 版本：**macOS 无法运行 Verilog 仿真**，P1 / P4 / P5 / P6 / P7 的仿真与自动对拍均不可用（语言特性、Logisim、MARS、冲突分析仍可正常使用）。
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

- 用命令 **`CO: 选择项目 Profile`**（P0–P7），或在工程根目录建 `.co/config.json` 写 `{"profile": "P7"}`。
- 也可设 `co.project.profile`。`auto` 会尽量根据顶层模块接口推断。

### 第三步：一键跑测试

打开侧边栏「**BUAA CO**」面板 →「操作」区，点：

- **P7 一键测试**（P7 专属按钮）/ **持续生成测试**（P4–P6）
  → 插件自动循环执行：**生成随机测试点 → MARS dump 机器码 → ISim 跑你的 CPU → MARS 跑黄金 trace → 对拍 → 出报告**，发现不一致会停下并定位首个差异。

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

### 怎么触发（侧边栏按钮 / 命令面板均可）

| 我想…… | 按钮 / 命令 |
|---|---|
| **一直循环跑，直到出错或我手动停**（推荐） | `CO: 启动持续生成的课程 Trace 测试`（侧栏：持续生成测试 / **P7 一键测试**） |
| 生成一批测试点并各跑一次对拍 | `CO: 运行生成的课程 Trace 测试`（侧栏：生成并批量测试） |
| 只测当前打开 / 选定的单个 ASM | `CO: 运行完整课程 Trace 测试`（侧栏：单 ASM 测试） |
| 批量测多个手选 ASM | `CO: 运行批量课程 Trace 测试` |
| 停止持续测试 | `CO: 停止持续课程测试` |
| 只生成测试点（不对拍） | `CO: 生成 ASM 测试点` / `CO: 生成并导出机器码` |
| 手动选两个输出文件对拍 / 对拍最近一次输出 | `CO: 比较 Trace 输出文件` / `CO: 比较最近的 MARS/ISim 输出` |
| 打开上次批量测试报告 | `CO: 打开批量 Trace 报告` |

持续测试会打开一个**实时监控面板**，并把每轮结果写到 `.co/out/continuous-trace-report.json`（即使关掉 VSCode 也能看）。默认遇到第一个失败/异常就停（可用 `co.test.continuousStopOnFailure: false` 关闭）。

### 内置随机生成器

插件自带随机 ASM 生成器（默认启用，`co.test.builtinGenerator.enabled`），无需自己写脚本。它会：

- 按 Profile 选用合适的默认指令集（也可用 `co.test.builtinGenerator.instructions` 自定义，逗号或空格分隔，只接受真实指令）；
- 在内部**建模 CPU 状态**（寄存器、HI/LO、内存、CP0），从而生成**合法、确定**的测试点：避免除零、避免非预期的地址错/溢出、正确处理延迟槽与乘除部件占用窗口、在跳转后插入“毒化”指令检验控制流；
- 生成数量由 `co.test.builtinGenerator.instructionCount`（P3–P6）/ `co.test.builtinGenerator.p7InstructionCount`（P7，默认/上限 1118）控制。

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
- 需要复现时优先保留 `.co/generated/*.asm`、对应 `*.co-meta.json`、`.co/out/*.mars.out`/`*.sim.out` 和报告 JSON；这些文件包含 seed、mode、中断/probe 元数据和首个差异。

---

## 3. 其他功能

### MIPS 汇编
语法高亮、补全、悬浮提示、标签/定义跳转、诊断、格式化；以及：
- `CO: MARS 运行当前文件`、`CO: MARS 带标准输入运行`、`CO: MARS 在终端中运行`（交互输入）、`CO: ASM 导出文本段`、`CO: ASM 导出内核文本段`。

### Verilog
高亮、模块/信号大纲、悬浮、定义跳转、隐式连线诊断、课程 Lint、可综合性检查、格式化；以及：
- `CO: Verilog 生成 Testbench`（P7 自动生成官方接口 testbench）、`CO: Verilog 生成 ISE 工程`、`CO: Verilog 运行 ISim`。
- **信号连线面板**（侧边栏「信号连线」）：把光标放在任一信号上，自动列出它的**声明**、**驱动/写**（`assign`、`always` 赋值、子模块 output 端口）、**读取/使用**（RHS、子模块 input 端口），点击条目跳转到源码。也可用命令 `CO: 查看 Verilog 信号连线` 或右键触发。

### Logisim（P0 / P3）
`.circ` 识别、电路/组件大纲、标签诊断；以及：
- `CO: Logisim 生成 ROM 文件`、`CO: Logisim 注入 ROM 到电路`、`CO: Logisim 日志转 CSV`、`CO: Logisim 打开当前电路`；
- 批量：`CO: 准备 Logisim 电路用例` / `CO: 准备生成的 Logisim 电路用例`（把机器码注入 `.circ` 副本，写到 `.co/logisim/`）。

### 流水线冲突分析（P5/P6/P7）
- `CO: 分析流水线冲突`、`CO: 打开冲突报告`（需配置 `co.toolchain.hazardCalculator`）。

### 项目辅助
- `CO: 项目向导`、`CO: 选择项目 Profile`、`CO: 检查工具链`、`CO: 刷新侧边栏`、`CO: 打开课程教程` / `CO: 打开当前 Profile 教程`。

---

## 4. 配置项（按常用程度排序）

> 优先级：VSCode 设置 `co.*` → 工程内 `.co/config.json` → 默认值。

### 最常用

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.project.profile` | `auto` | 当前 Profile（P0–P7 / auto） |
| `co.toolchain.mars` | — | Mars jar（非 P7 对拍） |
| `co.toolchain.marsP7` | — | P7 专用 Mars（需 efc/p7irq/coL1） |
| `co.toolchain.isePath` | — | ISE 安装目录（`.../ISE_DS/ISE`） |
| `co.toolchain.logisim` | — | Logisim jar |
| `co.project.simTime` | `200us` | ISim 运行时长（写入 TCL `run <值>; exit`） |

### 测试 / 对拍

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.test.builtinGenerator.enabled` | `true` | 使用内置随机生成器 |
| `co.test.builtinGenerator.instructionCount` | `4000` | P3–P6 主程序指令数 |
| `co.test.builtinGenerator.p7InstructionCount` | `1118` | P7 主程序指令数（上限 1118，0x4180 之前） |
| `co.test.builtinGenerator.instructions` | `""` | 自定义指令集（空=用 Profile 默认） |
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
| `co.test.generatorArgs` | `[]` | 传给外部生成器的额外参数 |
| `co.test.generatedAsmLimit` | `100` | 一轮拾取的新建/修改 ASM 上限 |

### MIPS / MARS 行为

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.mips.memoryConfiguration` | `auto` | 内存模式（auto：P3–P6=FixedCompactLargeText，P7=CompactLargeText） |
| `co.mips.delayedBranching` | `profile` | 延迟槽（profile：P5/P6/P7 启用） |
| `co.mips.extraArgs` | `[]` | 追加 MARS 命令行参数 |
| `co.mips.warnPseudoInstruction` | `true` | 使用伪指令时告警 |
| `co.mips.warnMissingExitSyscall` | `true` | P2 缺少退出 syscall 时告警 |
| `co.mips.instructionColorMode` | `realVsPseudo` | 指令着色方式 |

### 工程 / 工具链（其余）

`co.project.topModule`(`mips`)、`co.project.testbench`(`mips_tb`)、`co.project.machineCode`(`code.txt`)、`co.toolchain.java`、`co.toolchain.python`、`co.toolchain.hazardCalculator`、`co.course.tutorialRoot`。

### Verilog 诊断 / 格式化（细项，按需调整）

`co.verilog.implicitNet.*`（隐式连线）、`co.verilog.lint.*`（课程 Lint、可综合性、禁用规则）、`co.verilog.format.*`（风格、续行缩进、位宽间距等）、`co.diagnostics.disabledCodes` / `disabledFileCodes`。

### 运行细项

`co.run.showCommandBeforeRun`(`false`，运行前打印完整命令)、`co.run.revealOutput`(`false`，运行外部工具时是否自动弹出「输出」面板；默认不弹，仅静默写入)、`co.run.timeoutMs`(`120000`)。

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
| `.co/config.json` | 工程级配置（profile、toolchain、simulation、mips、test） |
| `.co/generated/*.asm` + `*.co-meta.json` | 内置生成器产出的测试点及其元数据（含中断调度 / probe 场景） |
| `.co/out/*.mars.out` / `*.sim.out` | MARS / ISim 输出 |
| `.co/out/trace-batch-report.json` | 批量测试报告（含命令、生成文件、首个差异） |
| `.co/out/continuous-trace-report.json` | 持续测试报告 |
| `.co/isim/` | ISE `.prj/.tcl`、生成的 testbench、`code.txt` |
| `.co/logisim/` | 注入机器码后的 `.circ` 副本与报告 |

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
| MMIO 写入 | **不输出**（Timer `0x7F00~0x7F1B`、中断响应 `0x7F20`，与 testbench 一致） |
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
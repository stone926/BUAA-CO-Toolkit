# BUAA CO 工具箱

面向北航计算机组成（CO）实验的 VS Code 插件。它把 MIPS 汇编、Verilog、Logisim 和 P3–P7 CPU 对拍测试整合到同一个工作流中：少装工具、少配参数，先让项目跑起来。

[在 VS Code Marketplace 安装](https://marketplace.visualstudio.com/items?itemName=stone926.buaa-co-toolkit) · [GitHub 仓库](https://github.com/stone926/BUAA-CO-Toolkit) · [发布版本与 VSIX](https://github.com/stone926/BUAA-CO-Toolkit/releases)

## 快速开始

### 1. 安装并确认运行环境

可在扩展市场搜索 **BUAA CO Toolkit** 安装；离线安装时，从发布页下载与本机匹配的 VSIX，再在扩展视图的“从 VSIX 安装…”中打开它。

插件需要 VS Code 1.90 或更高版本，并在以下本地扩展宿主上发布：

| 本地 VS Code 宿主 | 支持情况 | 手动安装的 VSIX |
|---|---|---|
| Windows 10/11 x64 | 支持 | `win32-x64` |
| macOS 14+，Apple Silicon | 支持 | `darwin-arm64` |
| macOS 14+，Intel | 支持 | `darwin-x64` |
| Windows ARM64、Linux、WSL、Remote SSH | 不支持 | — |

### 2. 打开项目并选择 Profile

新项目：先在 VS Code 中打开一个文件夹或工作区，然后在命令面板（`Ctrl+Shift+P`）运行 **`CO: 项目向导`**。向导可以创建课程目录、模板文件，并写入 Profile。

已有项目：运行 **`CO: 选择项目 Profile`**，选择 P0–P7；也可以把 `co.project.profile` 设为 `auto`，插件会根据项目文件、顶层接口和 trace 格式推断。不能唯一推断时，插件会提示你选择。

### 3. 只配置当前工作流需要的外部工具

打开 VS Code 设置，搜索 `co.toolchain`。P1 和 P4–P7 的常规 Verilog 检查、手动仿真和自动测试都使用插件随包提供的 Icarus，无需安装 ISE、Homebrew 或 MARS。

| 课程阶段或功能 | 需要配置 | 对应设置 |
|---|---|---|
| P0 / P3 Logisim | Logisim JAR；Java 不在 PATH 时再指定 Java | `co.toolchain.logisim`、`co.toolchain.java` |
| P2 ASM 运行 | MARS JAR；Java 不在 PATH 时再指定 Java | `co.toolchain.mars`、`co.toolchain.java` |
| P1、P4–P7 标准 Verilog 工作流 | 无 | — |
| P5–P7 流水线冲突分析（可选） | 课程 `hazard_analysis` 目录；必要时指定 Python | `co.toolchain.hazardCalculator`、`co.toolchain.python` |
| ISim GUI 波形 / 集成 VCD（可选） | Windows x64 上的 ISE 安装目录 | `co.toolchain.isePath` |

工具路径是本机配置；不要把个人绝对路径提交到项目的 `.vscode/settings.json`。配置后运行 **`CO: 检查工具链`**，它只检查当前 Profile 和操作实际需要的工具。

### 4. 开始使用

从左侧活动栏打开 **BUAA CO Toolkit**，在“操作”区按需要执行：

| 目标 | 最快入口 |
|---|---|
| P3–P7 测试 CPU | **启动持续测试**；首个失败或错误会停止，并保留可复现用例 |
| 停止或查看测试结果 | **停止持续测试**、**测试历史 / 失败用例** |
| P2 运行 MIPS 程序 | 在 MIPS 文件的“操作”中运行 MARS |
| P1 / P4–P7 检查或运行 Verilog | 保存 `.v` 文件触发默认检查；在编辑器右键菜单或侧边栏运行仿真 |
| P0 / P3 打开电路、生成或注入 ROM | 打开 `.circ` 文件后使用“操作”区 |
| VCD、Hazard、日志转 CSV 等低频功能 | **`CO: 更多工具`** |

P3 自动测试需要 Logisim 和 Java；P4–P7 自动测试不需要 MARS 或 ISE。

## 插件如何工作

插件把“编辑体验”和“课程工具链”分开处理。MIPS、Verilog 与 Logisim 文件先获得高亮、诊断、导航和格式化；涉及课程执行时，再根据 Profile 选择对应的运行流程。

P3–P7 的自动测试链路如下：

```text
内置测试生成器
  → 内置 TypeScript 汇编器
  → 内置课程 oracle
  → Logisim（P3）或随包 Icarus（P4–P7）运行你的 CPU
  → 比较课程可观察写事件，生成报告和可复现用例
```

默认引擎边界如下：

| 场景 | 默认实现 |
|---|---|
| P3–P7 自动测试、ROM/机器码准备、课程文本段导出 | 内置 TypeScript 汇编器和课程执行器 |
| P2，以及普通 MIPS 运行、标准输入和终端交互 | MARS + Java |
| P3 电路运行与对拍 | Logisim + Java |
| P1、P4–P7 Verilog 检查与仿真 | 随包 Icarus + VVP |
| ISim GUI 波形与集成 VCD | 仅 Windows x64 的可选 ISE 功能 |

内置汇编器面向 P3–P7 课程硬件，支持课程指令集、常用伪指令、`.text`、`.ktext`、`.data`、宏、`.eqv` 和有界 `.include`。它不是完整的 MARS 替代品：不提供 P2 syscall 控制台、标准输入或交互终端，也不承诺支持所有 MARS 扩展。CPU 测试中，数据存储器按课程约定从全零开始，因此含非零 `.data` 初值的用例会被拒绝；请在程序运行时用 store 初始化数据。

“启动持续测试”固定采用当前 Profile 的强测试策略，而不是让用户选择生成器、批量大小或对拍后端。`co.test.instructions` 是唯一的测试侧重点设置：留空会覆盖该阶段完整课程指令集，填写真实指令可让生成器优先覆盖它们。P7 还会覆盖 CP0、异常、外部中断和 Timer；对拍关注课程定义的可观察行为，不把某一种流水线周期数当作正确性的唯一标准。

## 功能一览

| 范围 | 提供的能力 |
|---|---|
| MIPS（`.asm` / `.s` / `.mips`） | 高亮、补全、悬浮、定义/引用跳转、诊断、格式化、重命名、MARS trace 解析与对比 |
| Verilog（`.v` / `.vh`） | 高亮、模块/信号大纲、跨文件导航、课程 Lint、隐式连线/位宽/连接诊断、格式化、信号连线视图、随包 Icarus 检查与仿真 |
| SystemVerilog（`.sv` / `.svh`） | 仅词法高亮；不进入 Verilog LSP、编译器检查或仿真 |
| Logisim（`.circ`） | 电路与组件大纲、标签诊断、打开电路、ROM 生成/注入、日志转 CSV，以及 P3 trace 对拍 |
| P5–P7 | 可选的流水线冲突分析与报告 |

## 常用设置与生成文件

除工具路径外，大多数项目只需要下面几项设置：

| 设置 | 用途 |
|---|---|
| `co.project.profile` | 当前课程阶段；默认 `auto` |
| `co.test.instructions` | 自动测试要重点覆盖的真实指令；留空使用默认全集 |
| `co.verilog.syntax.external.mode` | 内置 Icarus 检查的触发时机；默认保存时检查 |
| `co.project.topModule`、`co.project.testbench`、`co.project.machineCode`、`co.project.simTime` | 非标准工程或手动仿真的高级覆盖项；自动测试不读取这些手动参数 |

插件会在工作区的 `.co/` 下保存生成物：

| 位置 | 内容 |
|---|---|
| `.co/cases/<caseId>/` | 测试程序、机器码、报告、trace 和复现元数据；失败与错误用例会保留 |
| `.co/out/` | 手动运行或批量运行的输出与摘要 |
| `.co/isim/`、`.co/logisim/`、`.co/hazard/` | 仿真、电路与冲突分析的工作文件 |

这些文件是本地工作产物，不是学生源代码；建议在自己的课程项目中把 `.co/` 加入 `.gitignore`。

## 兼容性与边界

- Icarus 是常规 Verilog 后端。`co.toolchain.isePath` 不会切换保存时检查、手动仿真或自动测试到 ISE。
- 插件不覆盖 Xilinx vendor IP、综合、实现、时序仿真或 bitstream 工作流；这些请在相应 Xilinx 工具中完成。
- P3 trace 对拍要求课程标准的单个 32 位 ROM 和 trace 接口；无法可靠识别时，插件会给出缺失或冲突端口的诊断。
- 随机和定向测试能有效发现很多问题，但“通过”不等于所有场景都正确；课程最终结果仍以课程测评环境为准。

## 开发与维护

维护者可从仓库根目录运行：

```powershell
npm ci
npm run compile
npm test
npm run check:generated
npm run package:vsix
```

发布使用 `npm run publish -- patch`（也可替换为 `minor`、`major` 或显式版本号）。完整架构、模块边界和验证说明见[架构索引](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/docs/INDEX.md)；变更记录见 [CHANGELOG](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/CHANGELOG.md)。随包 Icarus 的许可证、校验信息和对应源码说明见 [Windows x64](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/vendor/iverilog/win32-x64/THIRD_PARTY_NOTICES.md)、[macOS Apple Silicon](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/vendor/iverilog/darwin-arm64/THIRD_PARTY_NOTICES.md) 和 [macOS Intel](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/vendor/iverilog/darwin-x64/THIRD_PARTY_NOTICES.md)。

遇到问题或希望补充课程场景，请到 [GitHub Issues](https://github.com/stone926/BUAA-CO-Toolkit/issues) 反馈。

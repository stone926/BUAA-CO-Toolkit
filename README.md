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
| Linux x64（Ubuntu 22.04 / 24.04） | 支持 | `linux-x64` |
| Linux ARM64（Ubuntu 22.04 / 24.04） | 支持 | `linux-arm64` |
| Windows ARM64、Linux ARM32、Alpine / musl | 不支持 | — |

每个平台包只携带对应平台和架构的 Icarus 运行时。Linux 使用系统标准 glibc、libstdc++ 和 libgcc；其他 glibc 发行版不做白名单拦截，但尚未承诺兼容。WSL、Remote SSH 和 Dev Containers 的完整工作流尚未验收。

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
| P5–P7 流水线冲突分析 | 无，使用插件内置分析器 | — |

工具路径是本机配置；不要把个人绝对路径提交到项目的 `.vscode/settings.json`。配置后运行 **`CO: 检查工具链`**，它只检查当前 Profile 和操作实际需要的工具。

### 4. 开始使用

从左侧活动栏打开 **BUAA CO Toolkit**，在“操作”区按需要执行：

| 目标 | 最快入口 |
|---|---|
| P3–P7 测试 CPU | **启动持续测试**；首个失败或错误会停止，并保留可复现用例 |
| 停止或查看测试结果 | **停止持续测试**、**测试历史 / 失败用例** |
| P2 运行 MIPS 程序 | 在 MIPS 文件的“操作”中运行 MARS |
| P1 / P4–P7 检查或运行 Verilog | 保存 `.v` 文件触发默认检查；点击编辑器右上角的运行按钮或在侧边栏运行仿真 |
| 在 VS Code 里看波形 | 编辑器右上角的波形按钮或侧边栏 **仿真并查看波形**；也可直接打开任意 `.vcd` 文件 |
| P0 / P3 打开电路、生成或注入 ROM | 打开 `.circ` 文件后使用“操作”区 |
| VCD、Hazard、日志转 CSV 等低频功能 | **`CO: 更多工具`** |

P3 自动测试需要 Logisim 和 Java；P4–P7 自动测试不需要 MARS 或 ISE。

P1 在模块文件中点击运行时，如果工作区里还没有 `<模块>_tb`，插件会在 `.co/tb/<模块>_tb.v` 生成激励模板并打开，本次不仿真；在“在此编写激励”处写好输入后再次点击运行（在模块文件或 testbench 中均可），`$monitor` 的输出会显示在“输出”面板，并保存到 `.co/out/<模块>_tb.sim.out`。右键菜单的“生成 Testbench”同样写入 `.co/tb`；插件不会覆盖 `.co/tb` 中已有的文件。

### 内置波形查看器

**仿真并查看波形** 用随包 Icarus 运行与“运行仿真”相同的 testbench，并自动记录全部信号，无需在 testbench 里手写 `$dumpfile`。GRF 这类不超过 64 个字的存储器会逐个字记录，寄存器行旁边显示 `$sp`、`$ra` 等别名；IM/DM 这类大存储器不记录，写入情况看 trace。

查看器以编辑器页签打开，左侧可搜索信号树（双击、`+` 或拖入即可添加，模块和存储器可整组添加），右侧用画布绘制波形：

- 0/1/x/z 四态分开绘制：x 为红色块，z 为黄色中线，部分位未知的总线值显示为 `X`
- 游标所在时刻的值直接列在信号名旁；单击放置游标会吸附到附近的跳变，按住 Alt 可取消吸附
- `Ctrl` + 滚轮以指针为中心缩放，拖动框选区间放大，`Shift` + 滚轮或中键拖动平移，底部缩略条显示全程和当前视窗
- `←`/`→` 跳到所选信号的上一次/下一次跳变，`Shift` + `←`/`→` 按时钟周期步进；标尺上会标出周期序号
- `M` 添加标记，工具栏和标尺显示游标到标记的 Δt 与周期数，适合核对 MDU busy、握手延迟等
- 显示进制可选十六进制、二进制、无符号/有符号十进制、ASCII 和 MIPS 指令；`D_ins`、`IR_E`、`i_inst_rdata` 等指令信号默认显示为汇编
- testbench 用 `$display` 打印的 GRF/DM 写入会出现在 Trace 页和标尺上，点击即跳到对应时刻并选中寄存器行
- 双击信号名跳转到 Verilog 声明；信号列表、分组、进制与视图会在重新仿真或重新打开后保留

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
| P2 汇编、P2–P6 普通 MIPS 运行、标准输入和终端交互 | 原版 MARS 4.5 + Java |
| P3 电路运行与对拍 | Logisim + Java |
| P1、P4–P7 Verilog 检查与仿真 | 随包 Icarus + VVP |
| 波形查看 | 内置查看器（任意仿真器生成的 VCD） |

内置汇编器面向 P3–P7 课程硬件，支持课程指令集、常用伪指令、`.text`、`.ktext`、`.data`、宏、`.eqv` 和有界 `.include`。它不是完整的 MARS 替代品：不提供 P2 syscall 控制台、标准输入或交互终端，也不承诺支持所有 MARS 扩展。CPU 测试中，数据存储器按课程约定从全零开始，因此含非零 `.data` 初值的用例会被拒绝；请在程序运行时用 store 初始化数据。

插件不再依赖魔改 MARS。可选控制台流程只需在 `co.toolchain.mars` 配置原版 `Mars4_5.jar`，默认采用原版 `Default` 内存布局。P3–P7 的手动和自动 CPU 测试均使用内置引擎；旧 `mars`、`verify-both` 设置自动迁移为 `auto`，旧大内存配置迁移为 `Default`，`marsP7` 不再读取。原版 MARS 不支持课程写回 Trace、P7 的 0x4180 异常入口、Timer 或外部中断；P7 使用内置汇编导出和 CPU 测试。课程组提供的 `Mars_p7` 也不是原版 MARS 4.5。旧测试记录仍保留原引擎标识；需要重新执行时请作为新用例使用内置引擎，不能把新结果冒充旧引擎的精确复现。

“启动持续测试”固定采用当前 Profile 的强测试策略，而不是让用户选择生成器、批量大小或对拍后端。`co.test.instructions` 是唯一的测试侧重点设置：留空会覆盖该阶段完整课程指令集，填写真实指令可让生成器优先覆盖它们。P7 还会覆盖 CP0、异常、外部中断和 Timer；对拍关注课程定义的可观察行为，不把某一种流水线周期数当作正确性的唯一标准。

## 功能一览

| 范围 | 提供的能力 |
|---|---|
| MIPS（`.asm` / `.s` / `.mips`） | 高亮、补全、悬浮、定义/引用跳转、诊断、格式化、重命名、MARS trace 解析与对比 |
| Verilog（`.v` / `.vh`） | 高亮、模块/信号大纲、跨文件导航、课程 Lint、隐式连线/位宽/连接诊断、格式化、信号连线视图、随包 Icarus 检查与仿真 |
| 波形（`.vcd`） | 内置查看器：四态波形、游标取值、缩放导航、周期计数、标记测量、多进制与 MIPS 反汇编、GRF 逐寄存器、trace 联动、跳转源码 |
| SystemVerilog（`.sv` / `.svh`） | 仅词法高亮；不进入 Verilog LSP、编译器检查或仿真 |
| Logisim（`.circ`） | 电路与组件大纲、标签诊断、打开电路、ROM 生成/注入、日志转 CSV，以及 P3 trace 对拍 |
| P5–P7 | 内置流水线冲突分析：转发/阻塞覆盖、有效率、类别评分与可筛选事件报告 |

### 流水线冲突分析

在 P5–P7 项目的侧边栏点击 **分析流水线冲突**，通过系统文件对话框选择汇编或机器码；也可运行 **`CO: 分析流水线冲突`** 或从 **`CO: 更多工具`** 进入。支持 `.asm` / `.s` / `.mips`、逐行十六进制机器码、Logisim v2 raw 和 COE。汇编由插件内置引擎处理，无需安装 Hazard-Calculator、Java 或 Python；汇编失败会直接提示原因。

报告展示转发与阻塞覆盖率、转发有效率、课程参考分和类别缺口，可按类型、有效性、指令、寄存器或 PC 筛选事件。页面上可以重新分析、打开输入或查看 JSON；历史报告用 **`CO: 打开冲突报告`** 重开。报告保存在 `.co/hazard/`，不同输入分别保留，同一输入重新分析会更新其报告。

分析默认最多执行 100000 步，可以在进度通知中取消。达到上限或遇到未定义行为时，报告明确标出部分结果。P7 使用 P6 的覆盖表；周期数是课程参考流水线模型的估算，不是实际 CPU 的测量结果。旧外部工具的 JSON 请使用原始程序重新生成。

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
| `.co/tb/` | 你的 testbench：插件只在缺失时生成一次激励模板，之后由你编辑，插件不会覆盖 |
| `.co/cases/<caseId>/` | 测试程序、机器码、报告、trace 和复现元数据；失败与错误用例会保留 |
| `.co/out/` | 手动运行或批量运行的输出与摘要 |
| `.co/wave/` | “仿真并查看波形”生成的 `<testbench>.vcd` 与配对的 `<testbench>.sim.out` |
| `.co/iverilog/`、`.co/logisim/`、`.co/hazard/` | 仿真、电路与冲突分析的工作文件 |

Testbench 只有三种来源：自动测试在 `.co/iverilog/` 使用私有内部 TB；插件面向用户生成的 TB 统一放在 `.co/tb/`，需要你编写输入和激励；你自己创建的 `_tb.v` 或 `_testbench.v` 文件也可直接运行，插件不会管理或改写它们。普通模块手动仿真缺少 TB 时会创建并打开激励模板，填写后再次运行。

P4–P7 的 CPU 顶层模板保留课程时钟、复位和存储器接线。点击运行或“仿真并查看波形”后直接选择 ASM，由内置汇编器自动准备并加载机器码；若缺少 CPU TB，会在选择后生成并继续仿真，无需再次点击。取消选择会停止本次操作。P6/P7 的 `$readmemh` 已包含在模板中，P4/P5 则沿用课程 CPU 内部 IM 读取 `code.txt` 的约定。已有用户 TB 保持原样，普通模块和自建 TB 不会询问 ASM。

除 `.co/tb/` 外，这些文件都是本地工作产物，不是学生源代码；建议在自己的课程项目的 `.gitignore` 中写入 `.co/*` 和 `!.co/tb/`，忽略生成物但保留 testbench。

## 兼容性与边界

- Verilog 语法检查、手动仿真、自动测试和波形统一使用随包 Icarus。
- Linux 内置 Icarus 保留文本 trace、`$readmemh` 和基础 VCD，不提供 FST / LXT / LXT2 压缩波形或 readline 行编辑。
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

`npm run package:vsix` 默认生成 Windows x64 包。其他平台在对应系统上运行 `node scripts/package-vsix.mjs --target <target> --out dist/<name>.vsix`；支持上表的五个 target，统一按目标裁剪运行时，macOS / Linux 在原生系统打包以保留可执行权限。

`Extension platforms` CI 在 PR、主分支提交和手动触发时验证五个平台的最终 VSIX：检查包内容与 Icarus，再启动真实 VS Code 稳定版，验证扩展激活、LSP 保存诊断与修复、仿真命令和一个固定 P4 课程用例的 Worker / 对拍报告。发布复用同一验证步骤；全量单元测试仍由原有 CI 执行。维护者无需准备其他系统的电脑。

本地可在对应平台解包 VSIX 后运行 `npm run verify:extension-host -- <解包后的 extension 目录>`；无显示器的 Linux 使用 `xvfb-run -a npm run verify:extension-host -- <目录>`。VS Code 自动下载至 `.vscode-test/`，测试工作区和日志保留在 `.vscode-test/extension-host-smoke/`；排查指定版本时可设置 `CO_VSCODE_VERSION`。

Linux 二进制由手动触发的 `Build bundled Linux Icarus` workflow 在两个原生架构的 Ubuntu 22.04 容器中生成；下载 tar artifact 后，将完整安装目录放入 `vendor/iverilog/<target>/` 并提交。构建配方 `vendor/iverilog/build-linux.sh` 随 VSIX 分发；日常发布使用仓库内固定产物，无需重新编译 Icarus。

发布使用 `npm run publish -- patch`（也可替换为 `minor`、`major` 或显式版本号），release matrix 从五个平台的最终 VSIX 解包运行 smoke。完整架构、模块边界和验证说明见[架构索引](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/docs/INDEX.md)；变更记录见 [CHANGELOG](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/CHANGELOG.md)。随包 Icarus 的许可证、校验信息和对应源码说明见 [Windows x64](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/vendor/iverilog/win32-x64/THIRD_PARTY_NOTICES.md)、[macOS Apple Silicon](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/vendor/iverilog/darwin-arm64/THIRD_PARTY_NOTICES.md)、[macOS Intel](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/vendor/iverilog/darwin-x64/THIRD_PARTY_NOTICES.md)、[Linux x64](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/vendor/iverilog/linux-x64/THIRD_PARTY_NOTICES.md) 和 [Linux ARM64](https://github.com/stone926/BUAA-CO-Toolkit/blob/main/vendor/iverilog/linux-arm64/THIRD_PARTY_NOTICES.md)。

遇到问题或希望补充课程场景，请到 [GitHub Issues](https://github.com/stone926/BUAA-CO-Toolkit/issues) 反馈。

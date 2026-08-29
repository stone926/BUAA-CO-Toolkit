# BUAA CO 工具箱（VSCode 插件）

面向北航计算机组成（CO）实验的开箱即用 VSCode 插件，覆盖 **MIPS 汇编、Verilog、Logisim** 三套工作流，并为 P3–P7 的 CPU 提供**一键随机对拍测试**（生成测试点 → 内置 TypeScript 课程引擎 → Logisim/ISim 仿真 → 自动对拍 → 报告，循环进行）。固定 MARS 已降级为可选回滚与开发/CI 兼容参考。

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

- **ISim 仿真与 P4–P7 Verilog 自动对拍依赖 Xilinx ISE**，而 ISE 只发布过 Windows 与 Linux 版本：**macOS 无法运行 Verilog 仿真**，P1 / P4 / P5 / P6 / P7 的仿真与自动对拍均不可用；P3 Logisim 对拍不依赖 ISE（语言特性、内置 TS 引擎、Logisim、可选 MARS、冲突分析仍可正常使用）。
- Linux（⚠️）：ISE 14.7 可用，但在现代 64 位发行版上通常需按照指导书自行处理兼容性问题
- 其余功能为 TS / Java / Python 实现，三平台通用。`co.toolchain.python` 留空时会自动检测（macOS / Linux 优先 `python3`，Windows 优先 `python` / `py`）。

---

## 1. 快速开始

### 第一步：装好外部工具并填路径

P3–P7 自动测试不要求安装 MARS：P3 填写 Logisim，P4–P7 填写 ISE 即可。只有 P2，或手动测试/历史复现显式使用 MARS 回滚与验证时，才需要额外配置 MARS。

打开 VSCode 设置（`Ctrl+,`），搜索 `co.toolchain`，按你的 Profile 需要填写：

```jsonc
{
  // Verilog 仿真（Xilinx ISE/ISim 的安装目录，注意指到 .../ISE_DS/ISE）
  "co.toolchain.isePath": "ISE 的路径，此路径下应包含名为 bin 等文件夹",
  // Logisim（P0/P3）
  "co.toolchain.logisim": "Logisim 的路径",
  // Java（保持默认即可）；Python 留空自动检测（macOS/Linux 优先 python3）
  "co.toolchain.java": "java",
  "co.toolchain.python": ""
}
```

> 填完后执行命令 **`CO: 检查工具链`**（侧边栏也有按钮）。手动检查项会随 Profile 和 `co.mips.engine` 变化；自动测试独立检查自身固定需要的最小工具链。

### 第二步：告诉插件当前是哪个 Profile

- 用命令 **`CO: 选择项目 Profile`**（P0–P7），或在 VS Code 用户/工作区设置中设置 `co.project.profile`。
- `auto` 会根据项目文件、Verilog 顶层接口和 trace 格式推断具体 P 并保存；无法唯一推断时会要求手动选择并保存。

### 第三步：一键跑测试

打开侧边栏「**BUAA CO Toolkit**」面板 →「操作」区，点：

- **持续自动测试**（P3–P7）
  → 插件会持续生成高强度测试点、运行你的 CPU 并核验结果；发现问题后自动停下并保存可复现用例。

VCD、Logisim CSV、Hazard 分析等非测试工具统一放在侧边栏 **更多工具...** 或命令面板 **`CO: 更多工具`**。自动测试不再要求用户选择单次/批量、生成器、dump 或对拍方式。

就这么简单。下面是细节。

---

## 2. 核心功能：一键随机对拍测试（P3–P7）

这是本插件最重要的能力。它把课程对拍流程全自动化：

```text
生成高强度测试点  →  运行你的 CPU  →  课程规则核验  →  简洁报告 / 失败复现
```

### 怎么触发（侧边栏 / 更多工具）

| 我想…… | 入口 |
|---|---|
| **跑一轮最强自动测试** | 侧边栏「操作」→「运行自动测试」 |
| **一直循环跑，直到出错或我手动停**（推荐） | 侧边栏「操作」→「持续自动测试」 |
| 停止当前自动测试 | 侧边栏「操作」→「停止自动测试」 |
| 查看测试历史或复现失败 | 侧边栏「操作」→「测试历史 / 失败用例」 |

持续测试会打开一个简洁的**实时监控面板**。它会一直运行，遇到第一个失败/异常就停止；通过产物自动有界清理，失败和异常用例始终保留用于复现。这些策略由插件管理，不需要用户配置。

### 内置随机生成器

插件自带随机 ASM 生成器，自动测试入口始终使用它，无需自己写脚本。它会：

- 按 Profile 覆盖完整课程指令集；也可用唯一的测试配置 `co.test.instructions` 指定重点 payload 指令（逗号或空格分隔，只接受真实指令），固定测试脚手架不需要手工加入；
- 在内部**建模 CPU 状态**（寄存器、HI/LO、内存、CP0），从而生成**合法、确定**的测试点：避免除零、避免非预期的地址错/溢出、正确处理延迟槽与乘除部件占用窗口、在跳转后插入“毒化”指令检验控制流；
- 自动使用当前课程阶段允许的最大安全规模；空间边界、异常入口和兼容性差异都由插件处理。

默认指令集：

| Profile | 默认指令 |
|---|---|
| P3 | `add, sub, ori, lw, sw, beq, lui, nop` |
| P4 | `add, sub, ori, lw, sw, beq, lui, jal, jr, nop` |
| P5 | `add, sub, ori, lw, sw, beq, lui, jal, jr, nop` |
| P6 | `add, sub, and, or, slt, sltu, lui, addi, andi, ori, lb, lh, lw, sb, sh, sw, mult, multu, div, divu, mfhi, mflo, mthi, mtlo, beq, bne, jal, jr, nop` |
| P7 | `add, sub, and, or, slt, sltu, lui, addi, andi, ori, lb, lh, lw, sb, sh, sw, mult, multu, div, divu, mfhi, mflo, mthi, mtlo, beq, bne, jal, jr, mfc0, mtc0, eret, syscall, nop` |

### P7 专项说明（异常 + 外部中断 + Timer）

P7 自动测试会同时覆盖普通指令、CP0、精确异常、外部中断和 Timer 的课程可观察行为。插件会自行组合定向场景与随机测试，无需选择模式、概率、场景数量或中断参数。

- 固定覆盖 AdEL、AdES、Syscall、RI、Ov，以及延迟槽、异常/中断优先级、屏蔽与恢复、`eret` 返回等边界；
- RI 统一通过 `.word` 注入 raw word，覆盖 unknown opcode 与 unknown funct，不再由私有助记符生成；
- Timer 自动覆盖单次/周期模式、停止后重启、重装与寄存器写优先级，只检查课程定义的行为，不要求某一种学生流水线周期数；
- 自动测试固定使用内置参考栈，不读取 `co.mips.engine`，因此无需 MARS；`mars` / `verify-both` 仅用于手动测试和历史用例复现。

### 输出/对拍约定

- 两端 trace 格式一致：`@PC: $寄存器 <= 值`（寄存器写）、`@PC: *地址 <= 值`（内存写）。
- 对拍**默认忽略周期/时间**，只比较 PC、目标、值（可在手动对拍时切换严格模式）。
- 标准输入自动配对：`foo.asm` 旁的 `foo.in / foo.input / foo.stdin / foo.dat`（及 `foo.xxx.in`、`input/tests/data` 等子目录）会自动作为 stdin。
- 报告与中间产物都在工程下的 `.co/` 目录（见第 6 节）。

### 如何理解测试结果

- 结果不一致通常表示 CPU 的可见写事件或 P7 课程性质不满足；报告会给出首个可操作差异，不会展示内部测试强度或调度参数。
- 通过不等于“完全正确”：随机测试只能覆盖实际生成的样例，纯性能问题和课程未要求的扩展行为仍需另行验证。
- 失败与异常用例会自动保留；在“测试历史 / 失败用例”中使用复现编号即可定位，不需要理解内部文件布局。

---

## 3. 其他功能

### MIPS 汇编
语法高亮、补全、悬浮提示、标签/定义跳转、诊断、格式化；以及：
- 侧边栏「操作」只放常用的 ASM 运行和文本段导出；
- 带标准输入运行、终端运行和 P7 内核段导出放在「更多工具...」，编辑器标题栏仍保留终端运行和文本段导出的快捷按钮。

### Verilog
高亮、模块/信号大纲、悬浮、定义跳转、隐式连线诊断、课程 Lint、可综合性检查、格式化；以及：
- `.v` / `.vh` 提供完整 Verilog LSP；课程使用的 `.sv` / `.svh` 以独立 SystemVerilog 语言提供词法高亮，避免尚未支持的 SystemVerilog 结构被 Verilog parser 误诊断；
- 侧边栏「操作」保留 ISim 运行、波形查看和信号连线；
- 生成 Testbench、ISE 语法检查、信号连线在 Verilog 右键菜单；ISE 工程生成和 VCD 导出放在「更多工具...」。
- **信号连线面板**：把光标放在任一信号上，自动列出它的**声明**、**驱动/写**（`assign`、`always` 赋值、子模块 output 端口）、**读取/使用**（RHS、子模块 input 端口），点击条目跳转到源码。该面板默认只在 Verilog 上下文或执行“查看信号连线”后出现。

### 语义高亮与主题适配
TextMate 始终负责注释、字符串、数字、关键字、编译指令和操作符；semantic highlighting 只叠加 MIPS 指令类型/CP0 寄存器、Verilog 模块/端口/task/function 等上下文角色。插件不提供颜色、不监听主题，运行期也不改写编辑器配色；最终显示完全由 VS Code 当前主题和用户设置决定。升级时只会一次性清理旧版本曾自动注入且仍未被用户修改的规则。关闭语义高亮时仍保留完整词法底色，详见 [语法高亮与语义分类](docs/semantic-colors.md)。

### Logisim（P0 / P3）
`.circ` 识别、电路/组件大纲、标签诊断；以及：
- 侧边栏「操作」在当前 `.circ` 文件上提供打开电路和注入 ROM；
- 生成 ROM、日志转 CSV 放在「更多工具...」；P3 自动测试会在需要时自行完成 trace 电路识别与用例准备；
- P3 Trace 对拍自动识别教程顶层电路中的 `Instr, pc, RegWrite, RegAddr, RegData, MemWrite, MemAddr, MemData`。Logisim CLI 的 stdout 列序按 Logisim 2.7.1 源码规则解析：先收集 appearance ports，再按实际 Pin 坐标从上到下、从左到右输出；插件优先用标准 label 映射，label 不完整时按教程外观/Pin 顺序推断，并在无法可靠识别时给出具体诊断；
- P3 Logisim 对拍不要求电路提供 `halt` pin。插件会给 ROM 末尾追加停机自环，并在 `pc` 到达注入的 halt PC 时结束仿真；若暴露 `Instr`，插件会额外检查 `Instr` 与当前 PC 对应机器码是否一致；
- 自动识别失败时，诊断会说明缺少或冲突的端口；P3 电路应当只有一个 32 位 ROM。

### 流水线冲突分析（P5/P6/P7）
- 在「更多工具...」中提供冲突分析和打开报告（需配置 `co.toolchain.hazardCalculator`）。

### 项目辅助
- 命令面板的测试入口只保留 `CO: 运行自动测试`、`CO: 持续自动测试`、`CO: 停止自动测试`、`CO: 测试历史 / 失败用例`；项目向导、Profile、工具链、教程和更多工具仍按原入口提供。

---

## 4. 配置项（按 Settings UI 分组）

> 优先级：VS Code 用户/工作区设置 `co.*` → 默认值。工作区设置可写在 `.vscode/settings.json`。
> 设置 UI 分成五组：`项目基本情况`、`工具链`、`运行与测试`、`编辑器与诊断`、`格式化`。自动测试内部只公开一个指令集选择，其他强度参数由插件管理。

### 项目基础

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.project.profile` | `auto` | 当前 Profile（P0–P7 / auto；auto 会推断具体 P 并保存，无法推断时要求选择） |
| `co.project.simTime` | `200us` | 手动 ISim 运行时长；自动测试使用内部执行预算并忽略此项 |

其余项目项：`co.project.topModule`(`mips`)、`co.project.testbench`(`mips_tb`)、`co.project.machineCode`(`code.txt`)、`co.project.simBackend`(`isim`)、`co.course.tutorialRoot`。

### 工具链

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.mips.engine` | `auto` | 手动测试/历史复现的 P3–P7 课程引擎；自动测试固定使用内置 TS，不读取此项 |
| `co.toolchain.mars` | — | 仅 P2、手动 `mars` / `verify-both` 或历史复现使用；P3–P7 自动测试无需配置 |
| `co.toolchain.marsP7` | — | P7 专用的显式 MARS 回滚/验证路径；不填时回退到 `co.toolchain.mars` |
| `co.mips.delayedBranching` | `profile` | MARS 延迟槽开关；`profile` 会按课程阶段自动处理 |
| `co.mips.memoryConfiguration` | `auto` | MARS 内存模式（auto：P3–P6=FixedCompactLargeText，P7=CompactLargeText） |
| `co.toolchain.isePath` | — | ISE 安装目录（`.../ISE_DS/ISE`） |
| `co.toolchain.logisim` | — | Logisim jar |

其余工具链项：`co.toolchain.java`、`co.toolchain.python`、`co.toolchain.hazardCalculator`。

### 运行与测试

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.test.instructions` | `""` | 唯一公开的自动测试参数：指定重点 payload 真实指令；空值覆盖当前 Profile 完整课程指令集 |
| `co.mips.extraArgs` | `[]` | 仅普通 MARS 命令使用；自动测试会忽略，避免改变测评语义 |

运行细项也在本组：`co.run.showCommandBeforeRun`(`false`，手动运行外部工具前显示完整命令)、`co.run.revealOutput`(`false`，手动运行外部工具时是否自动弹出「输出」面板)、`co.run.timeoutMs`(`120000`，手动外部工具超时)。自动测试始终非交互、静默执行，并使用内部超时预算，不受这些设置影响。

测试规模、P7 模式/概率/场景、中断/Timer、持续轮数/间隔/停止与留存均为内部策略，不再出现在 Settings 中，也不会被旧工作区设置静默削弱。旧版的指令集选择会自动迁移；其余旧测试参数只保留在历史 case 的复现信息中。

### 编辑器与诊断

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.mips.warnPseudoInstruction` | `true` | 使用伪指令时告警 |
| `co.mips.warnMissingExitSyscall` | `true` | P2 缺少退出 syscall 时告警 |
| `co.mips.instructionTokenMode` | `realVsPseudo` | MIPS 指令 semantic token 分类粒度；颜色由 VS Code 决定 |

同组还包含：`co.verilog.implicitNet.*`（隐式连线）、`co.verilog.syntax.ise.*`（保存时 ISE 语法检查）、`co.verilog.lint.*`（课程 Lint、可综合性、禁用规则）、`co.diagnostics.disabledCodes` / `disabledFileCodes`。

### 格式化

格式化组包含 `co.verilog.format.*`（续行缩进、位宽间距、声明范围间距、`else` 换行、最大连续空行等）。纵向对齐细项集中于 `co.verilog.format.alignment.*`：`parameter` 默认 `equals`，会对齐连续 `parameter` / `localparam` 声明中的等号；`modulePort` 默认 `name`，会对齐多行 `module` 声明中的位宽和端口名；`ternary` 默认 `question`，会对齐多行三目运算符链中的问号。

---

## 5. ⚠️ 特别注意事项

1. **自动测试不需要 MARS**：P3–P7 自动生成用例固定使用内置参考栈；`co.mips.engine` 的 `mars` / `verify-both` 只影响手动测试和历史复现。
2. **新的 RI 测试统一使用 raw word**：自动生成源码用 `.word` 覆盖 unknown opcode 与 unknown funct；旧用例仍可回放，但新测试点不再生成私有 RI 助记符。
3. **ISE 路径要指到 `.../ISE_DS/ISE`**，此目录下有 `bin`。例如 `D:/ISE/14.7/ISE_DS/ISE`。自动测试使用独立 testbench，不会覆盖你自己的文件。
4. **测试不绑定某一种流水线周期数**：默认按课程可见写事件和定义行为核验，因此纯性能问题或不可见内部状态仍可能需要额外定向测试。
5. **BadVAddr 不测试**：课程不要求实现 BadVAddr；如果你实现了它，需要另写专门测试。
6. **延迟槽按 Profile 自动处理**：P5/P6/P7 开启一条课程延迟槽，无需另调自动测试参数。
7. 不要把机器码 `.txt` 误当 stdin：stdin 仅按 `.in/.input/.stdin/.dat` 后缀且与 ASM 同名时自动配对。

---

## 6. 目录约定（工程下 `.co/`）

| 路径 | 内容 |
|---|---|
| `.vscode/settings.json` | 可选的工作区级 VS Code 设置（`co.*` 配置项） |
| `.co/cases/<caseId>/` | ASM case 记录：`program.asm`、`code.txt`、`case.json`、MARS/ISim/Logisim trace 与复现元数据 |
| `.co/out/*.oracle.out` / `*.sim.out` | 手动单次/批量测试的 provider-neutral oracle / ISim 输出；持续测试默认把输出写入对应 case 目录（旧 `.mars.out` 仍可读取） |
| `.co/out/trace-batch-report.json` | 批量测试摘要；自动测试报告不暴露内部命令或强度参数，失败用例仍可从历史中精确回放 |
| `.co/out/continuous-trace-report.json` | 持续测试摘要；自动留存通过样本并完整保留失败/异常轮，不暴露内部调度参数 |
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

每次 main push / pull request 还会永久运行 `npm run verify:phase6`：Ubuntu 24.04 与 Windows 2025 各自执行阶段 6 定向测试、固定 `mars-assembler-v0.6.3` 的 assembly differential，以及固定 `legacy-course-executor` v0.6.3-course1 对 250 个生成用例 + 5 个手写边界用例的真实 execution differential。CI 要求 assembly lane 无未解释差异，并要求 execution lane 每个 profile 50+1、总计 255/255 通过且 0 unexplained/inconclusive/out-of-domain/error；结果以 machine-readable evidence 上传。

tag 推送后，GitHub Actions 会先在 Ubuntu 24.04 与 Windows 2025 上分别完成同一套 `verify:phase6`；Marketplace 发布 job 通过 `needs` 等待两个 matrix 结果，因此单独推 tag 或使用本地 `--skip-tests` 都不能绕过默认切换门。随后发布 job 在 Ubuntu runner 上执行：

1. `npm ci`
2. `npm run sync:manifest-config`，并确认生成文件已经提交
3. `npm test`
4. `npm run compile`
5. `vsce package` 生成 VSIX
6. `vsce publish --packagePath <vsix>` 发布到 VS Code Marketplace
7. 用同一个 VSIX 创建 GitHub Release

首次使用前，需要在 GitHub 仓库的 Actions secrets 中添加 `VSCE_PAT`，该 token 需要有 VS Code Marketplace 的 Manage 权限。GitHub Release 使用仓库自带的 `GITHUB_TOKEN`，不需要额外配置。

辅助命令：

- `npm run publish -- --dry-run`：预览下一次 release notes 和步骤，不改文件
- `npm run publish -- minor --no-push`：只在本地创建 release commit/tag，不推送
- `npm run publish -- patch --skip-tests`：只跳过本地 `npm test`；manifest 配置生成/检查和 tag workflow 的双平台 `verify:phase6` 仍强制执行

配置清单维护命令：

- `npm run generate:manifest-config`：从 `resources/co/configManifest.json`、`resources/co/configDefaults.json` 和课程资源生成 `package.json` 的 `contributes.configuration`
- `npm run check:manifest-config`：只检查生成结果是否已同步，不写文件
- `npm run sync:manifest-config`：先生成再检查；`compile`、`watch`、`test`、`test:coverage`、`package:vsix` 和发布流程都会自动运行

---

如需扩展（如 Timer 模块单元测试、显式校验 CP0 寄存器值、其他后端），欢迎提 issue / 反馈。

---

## 附录

## 与 MARS 在 P7 验证/回滚中协作

自动测试始终使用内置参考栈，不进入 MARS 支路，也不读取 `co.mips.engine`。手动测试中，`mars` 用于回滚到用户配置的兼容引擎，`verify-both` 用于受信任版本的独立验证；`co.mips.extraArgs` 只影响普通手动 MARS 命令。

历史用例若使用旧的私有 RI 助记符仍可精确回放；新生成的 RI 测试只使用标准 `.word` raw word。

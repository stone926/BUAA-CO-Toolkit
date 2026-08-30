# BUAA CO 工具箱（VSCode 插件）

面向北航计算机组成（CO）实验的开箱即用 VSCode 插件，覆盖 **MIPS 汇编、Verilog、Logisim** 三套工作流，并为 P3–P7 的 CPU 提供**一键随机对拍测试**（生成测试点 → 内置 TypeScript 课程引擎 → Logisim/Verilog 仿真 → 自动对拍 → 报告，循环进行）。Windows x64 版本已内置 Icarus Verilog 13.0；固定 MARS 已降级为可选回滚与开发/CI 兼容参考。

---

## 平台支持

本版本只发布 `win32-x64` 定向 VSIX，支持在 Windows x64 的本地 VS Code 扩展宿主中运行。

| 环境 | 本版本 |
|---|---|
| Windows 10/11 x64，本地 VS Code | ✅ |
| Windows ARM64 | ❌ |
| WSL / Remote SSH 扩展宿主 | ❌ |
| Linux / macOS 本地扩展宿主 | ❌ |

- 未配置 `co.toolchain.isePath` 时，插件直接启动随包附带的 `iverilog.exe`、`vvp.exe` 和依赖 DLL；不要求安装 Icarus、MSYS2 或修改 `PATH`。
- 配置非空且有效的 `co.toolchain.isePath` 后，通用语法检查与 Verilog 仿真入口改用已有的 ISE fuse / ISim。配置非空但无效时会明确报错，不会静默回退到 Icarus。
- 课程最终结果仍以课程测评环境为准；Icarus 与 ISE 对少量非标准或时序敏感写法可能有差异，出现分歧时可配置 ISE/ISim 复核。
- 生成 ISE 工程、打开 ISim 波形和现有 ISim VCD 导出仍必须配置 ISE；未配置时这些 ISE 专属入口不可用。
- Bundled runtime 的组件版本、二进制校验值、许可证和对应源码见 [第三方声明](vendor/iverilog/win32-x64/THIRD_PARTY_NOTICES.md)。

---

## 1. 快速开始

### 第一步：按需填写外部工具路径

P1 / P4–P7 的 Verilog 仿真默认直接使用内置 Icarus，无需安装 ISE。P3 需要填写 Logisim。只有希望显式使用 ISE/ISim，或需要 ISE 工程、ISim 波形与 VCD 功能时，才填写 `co.toolchain.isePath`。P3–P7 自动测试不要求安装 MARS；只有 P2，或手动测试/历史复现显式使用 MARS 回滚与验证时，才需要额外配置 MARS。

打开 VSCode 设置（`Ctrl+,`），搜索 `co.toolchain`，按你的 Profile 需要填写：

```jsonc
{
  // 可选：显式使用 Xilinx ISE/ISim；留空即使用内置 Icarus 13.0
  "co.toolchain.isePath": "",
  // Logisim（P0/P3）
  "co.toolchain.logisim": "Logisim 的路径",
  // Java（保持默认即可）；Python 留空时自动检测
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

- **启动持续测试**（P3–P7）
  → 插件会以当前 Profile 的最强配置持续生成测试点、运行你的 CPU 并核验结果；遇到第一个失败或错误后立即停下并保存可复现用例。

VCD、Logisim CSV、Hazard 分析等非测试工具统一放在侧边栏 **更多工具...** 或命令面板 **`CO: 更多工具`**；“更多工具”不再重复提供测试入口。自动测试也不再要求用户选择单次/批量、生成器、dump 或对拍方式。

就这么简单。下面是细节。

---

## 2. 核心功能：一键随机对拍测试（P3–P7）

这是本插件最重要的能力。它把课程对拍流程全自动化：

```text
生成高强度测试点  →  运行你的 CPU  →  课程规则核验  →  简洁报告 / 失败复现
```

### 怎么触发（侧边栏 / 命令面板）

| 我想…… | 入口 |
|---|---|
| **以最强配置一直测试，直到首个失败/错误或我手动停** | 侧边栏「操作」→「启动持续测试」（命令面板：`CO: 启动持续测试`） |
| 停止当前测试 | 侧边栏「操作」→「停止持续测试」 |
| 查看测试历史或复现失败 | 侧边栏「操作」→「测试历史 / 失败用例」 |

“启动持续测试”是唯一的测试启动入口，会打开一个简洁的**实时监控面板**。测试默认使用当前 Profile 允许的最强配置并持续运行，遇到第一个失败或错误就立即停止；通过产物自动有界清理，失败和错误用例始终保留用于复现。这些策略由插件管理，不需要用户配置。

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
- 侧边栏「操作」提供 backend-neutral 的 Verilog 仿真和信号连线；未配置 ISE 时使用 bundled Icarus，配置有效 ISE 后使用 ISim；
- 生成 Testbench、外部编译器语法检查和信号连线在 Verilog 右键菜单；ISE 工程生成、ISim 波形和 VCD 导出属于 ISE 专属功能，配置 ISE 后才开放。
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
- 测试启动入口只保留 `CO: 启动持续测试`；另保留 `CO: 停止持续测试` 和 `CO: 测试历史 / 失败用例` 作为控制与诊断入口。“更多工具”不再包含测试入口，侧边栏“资料”及教程入口已删除。

---

## 4. 配置项（按 Settings UI 分组）

> 优先级：VS Code 用户/工作区设置 `co.*` → 默认值。工作区设置可写在 `.vscode/settings.json`。
> 设置 UI 分成五组：`项目基本情况`、`工具链`、`运行与测试`、`编辑器与诊断`、`格式化`。自动测试内部只公开一个指令集选择，其他强度参数由插件管理。

### 项目基础

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.project.profile` | `auto` | 当前 Profile（P0–P7 / auto；auto 会推断具体 P 并保存，无法推断时要求选择） |
| `co.project.simTime` | `200us` | 手动 Verilog 仿真运行时长；自动测试使用内部执行预算并忽略此项 |

其余项目项：`co.project.topModule`(`mips`)、`co.project.testbench`(`mips_tb`)、`co.project.machineCode`(`code.txt`)。旧工作区中残留的 `co.project.simBackend` 不再参与后端选择。

### 工具链

| 配置 | 默认 | 说明 |
|---|---|---|
| `co.mips.engine` | `auto` | 手动测试/历史复现的 P3–P7 课程引擎；自动测试固定使用内置 TS，不读取此项 |
| `co.toolchain.mars` | — | 仅 P2、手动 `mars` / `verify-both` 或历史复现使用；P3–P7 自动测试无需配置 |
| `co.toolchain.marsP7` | — | P7 专用的显式 MARS 回滚/验证路径；不填时回退到 `co.toolchain.mars` |
| `co.mips.delayedBranching` | `profile` | MARS 延迟槽开关；`profile` 会按课程阶段自动处理 |
| `co.mips.memoryConfiguration` | `auto` | MARS 内存模式（auto：P3–P6=FixedCompactLargeText，P7=CompactLargeText） |
| `co.toolchain.isePath` | — | 留空使用内置 Icarus 13.0；填写 `.../ISE_DS/ISE` 后显式使用 fuse/ISim |
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

同组还包含：`co.verilog.implicitNet.*`（隐式连线）、`co.verilog.syntax.external.mode` / `timeoutMs`（保存或命令触发的外部编译器检查）、`co.verilog.syntax.ise.suppressedWarnings`（仅 ISE 分支）、`co.verilog.lint.*`（课程 Lint、可综合性、禁用规则）、`co.diagnostics.disabledCodes` / `disabledFileCodes`。旧的 `co.verilog.syntax.ise.enabled/mode/timeoutMs` 已移除。

### 格式化

格式化组包含 `co.verilog.format.*`（续行缩进、位宽间距、声明范围间距、`else` 换行、最大连续空行等）。纵向对齐细项集中于 `co.verilog.format.alignment.*`：`parameter` 默认 `equals`，会对齐连续 `parameter` / `localparam` 声明中的等号；`modulePort` 默认 `name`，会对齐多行 `module` 声明中的位宽和端口名；`ternary` 默认 `question`，会对齐多行三目运算符链中的问号。

---

## 5. ⚠️ 特别注意事项

1. **自动测试不需要 MARS**：P3–P7 自动生成用例固定使用内置参考栈；`co.mips.engine` 的 `mars` / `verify-both` 只影响手动测试和历史复现。
2. **新的 RI 测试统一使用 raw word**：自动生成源码用 `.word` 覆盖 unknown opcode 与 unknown funct；旧用例仍可回放，但新测试点不再生成私有 RI 助记符。
3. **ISE 是显式 opt-in**：留空 `co.toolchain.isePath` 使用 bundled Icarus；如填写，路径要指到含 `bin` 的 `.../ISE_DS/ISE`，例如 `D:/ISE/14.7/ISE_DS/ISE`。无效的非空路径会失败而不会回退。自动测试使用独立 testbench，不会覆盖你自己的文件。
4. **测试不绑定某一种流水线周期数**：默认按课程可见写事件和定义行为核验，因此纯性能问题或不可见内部状态仍可能需要额外定向测试。
5. **BadVAddr 不测试**：课程不要求实现 BadVAddr；如果你实现了它，需要另写专门测试。
6. **延迟槽按 Profile 自动处理**：P5/P6/P7 开启一条课程延迟槽，无需另调自动测试参数。
7. 不要把机器码 `.txt` 误当 stdin：stdin 仅按 `.in/.input/.stdin/.dat` 后缀且与 ASM 同名时自动配对。

---

## 6. 目录约定（工程下 `.co/`）

| 路径 | 内容 |
|---|---|
| `.vscode/settings.json` | 可选的工作区级 VS Code 设置（`co.*` 配置项） |
| `.co/cases/<caseId>/` | ASM case 记录：`program.asm`、`code.txt`、`case.json`、oracle/Verilog/Logisim trace 与复现元数据 |
| `.co/out/*.oracle.out` / `*.sim.out` | 手动单次/批量测试的 provider-neutral oracle / Verilog 仿真输出；持续测试默认把输出写入对应 case 目录（旧 `.mars.out` 仍可读取） |
| `.co/out/trace-batch-report.json` | 批量测试摘要；自动测试报告不暴露内部命令或强度参数，失败用例仍可从历史中精确回放 |
| `.co/out/continuous-trace-report.json` | 持续测试摘要；自动留存通过样本并完整保留失败/异常轮，不暴露内部调度参数 |
| `.co/isim/` | Verilog 仿真工作目录：生成的 testbench、`code.txt`、Icarus `.vvp`/watchdog，或 ISE `.prj/.tcl` |
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

1. `npm run sync:generated`，生成并检查 manifest、语法与 ISA 派生产物；若生成文件有未提交变化会停止发布
2. `npm test` 和 `npm run compile`
3. 更新 `package.json` / `package-lock.json` 的 version
4. 根据最近一个 `v*` tag 之后的提交更新 `CHANGELOG.md`
5. 创建 `chore: release vX.Y.Z` 提交和 `vX.Y.Z` annotated tag
6. `git push origin HEAD --follow-tags`

每次 main push / pull request 还会永久运行 `npm run verify:phase6`：Ubuntu 24.04 与 Windows 2025 各自执行阶段 6 定向测试、固定 `mars-assembler-v0.6.3` 的 assembly differential，以及固定 `legacy-course-executor` v0.6.3-course1 对 250 个生成用例 + 5 个手写边界用例的真实 execution differential。CI 要求 assembly lane 无未解释差异，并要求 execution lane 每个 profile 50+1、总计 255/255 通过且 0 unexplained/inconclusive/out-of-domain/error；结果以 machine-readable evidence 上传。

tag 推送后，GitHub Actions 会先在 Ubuntu 24.04 与 Windows 2025 上分别完成同一套 `verify:phase6`；Windows package job 通过 `needs` 等待两个 matrix 结果，因此单独推 tag 或使用本地 `--skip-tests` 都不能绕过默认切换门。随后发布链只打包一次：

1. Windows 2025 job 执行 `npm ci`、生成物同步检查、`npm test` 和 `npm run compile`
2. `vsce package --target win32-x64` 生成唯一的 `buaa-co-toolkit-<version>-win32-x64.vsix`
3. 解包 VSIX，确认平台 metadata、bundled executable/DLL、`lib/ivl`、许可证与第三方声明均在包内
4. 从解包后的扩展安装布局、在隔离 `PATH` 下运行 `iverilog -V` 和含 `$readmemh` / `$display` 的 tiny compile+run
5. 上传通过验收的 VSIX artifact；Ubuntu publish job 只下载该 artifact，并核对 SHA-256，不重新打包
6. publish job 按固定 manifest 下载并校验 7 个对应源码包，`vsce publish --skip-duplicate --packagePath <同一 VSIX>` 幂等发布到 Marketplace
7. GitHub Release 同时保存该 VSIX、对应源码包和 `SHA256SUMS`，不把约 162 MiB 源码塞入 VSIX

本地 `npm run package:vsix` 同样固定生成 `win32-x64` 定向包；`npm run verify:bundled-iverilog` 可直接检查源码树中的运行时。此版本不发布无 `--target` 的 generic fallback。

首次使用前，需要在 GitHub 仓库的 Actions secrets 中添加 `VSCE_PAT`，该 token 需要有 VS Code Marketplace 的 Manage 权限。GitHub Release 使用仓库自带的 `GITHUB_TOKEN`，不需要额外配置。

辅助命令：

- `npm run publish -- --dry-run`：预览下一次 release notes 和步骤，不改文件
- `npm run publish -- minor --no-push`：只在本地创建 release commit/tag，不推送
- `npm run publish -- patch --skip-tests`：只跳过本地 `npm test`；生成物检查和 tag workflow 的双平台 `verify:phase6` 仍强制执行

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

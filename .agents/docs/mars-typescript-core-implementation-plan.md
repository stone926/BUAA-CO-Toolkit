# MARS 核心 TypeScript 集成实施方案

> 状态：Executing（阶段 0–5 已完成；下一步是阶段 6 按 profile 默认切换）
>
> 制定日期：2026-08-25
>
> 最近更新：2026-08-28（阶段 5 正式落地：纯 TS P3–P7 课程汇编器、assembly differential 10/10、TS/TS full-stack gate）
>
> 插件基线：`ca679f7c231927e63f3fb8ba3e91f232c89a24c7`（package `1.0.2`）
>
> 汇编兼容参考：`Mars-with-BUAA-CO-extension v0.6.3 / 8b53a492dddc4fe1c62a7a02c55bea6fc4fb49d8`；执行参考由阶段 0 单独冻结
>
> 目标：将课程所需的 MIPS 汇编、架构执行和自动测试 oracle 建成插件内的纯 TypeScript 核心；MARS 从用户运行时依赖降级为开发/CI 中的固定参考实现。
>
> 本版的取舍：初版按多人/受监管环境设计了 approval envelope、candidate-vs-formal
> 双层 gate、CODEOWNERS 与 branch-protection 强制等治理。阶段 0/1 过门证明真正发现
> 缺陷的是 directed 测试与两平台 CI，而单人维护下 approval 信封在 review 本身之外
> 不提供额外独立性，治理已按单人维护规模放宽（见第 0 节与第 7 节）。本文档保留
> 全部规范契约、架构决策与已验证的实现记录，只改写已过时的治理与门槛描述。

## 0. 实施检查点（2026-08-27）

### 已完成

- **阶段 0/1（2026-08-27 正式过门）**：课程 contract/decision/divergence ledger、
  角色化固定 MARS reference（hash 校验下载）、独立 conformance harness、candidate
  expected data、provider-neutral contracts、manifest v2、唯一 ISA catalog 与
  versioned JSONL CLI、懒启动 Worker 与严格 ACK/backpressure、进程树取消、
  replay closure 与 exact replay、新旧 legacy 等价。
- **阶段 2（2026-08-27 实现落地）**：P3–P6 机器执行核心 —— GPR/PC/HI/LO、显式小端
  byte lane、transactional effect→commit、P3/P4 无延迟槽（link=PC+4）、P5/P6 一条
  延迟槽（link=PC+8）、byte/half 与 MDU、lwl/lwr/swl/swr、halt 检测要求完整
  自分支+delay-slot nop 序列、步数预算与 PC/word 级诊断、可比较域 fail closed。
- **阶段 3（2026-08-27 实现落地）**：P7 CP0（SR/Cause/EPC 掩码、EXL/BD/EPC）、
  `F>D>E>M` 最早阶段仲裁、Int 覆盖同一 victim 的异常、victim 零副作用（含设备
  事务 abort）、eret 无延迟槽、AdEL/AdES/Syscall/RI/Ov 全类、外部 IRQ 采用
  “宏观 victim PC + occurrence” 计划；官方 Timer 按 P7_standard_timer_2019.v 重建
  （WE 抑制状态机、IRQ=ctrl[3]&_IRQ、Mode 0/1 与 restart 时序）；MachineSession 与
  DeviceSession 严格分离，不存在“每指令 tick”伪时间映射。
- 版本化 JSONL CLI 新增 `machine.execute` 与 `device.cycleVector`，conformance 的
  execution/device 证据可经该进程边界复现。核心现位于 `src/mips/core`（assembler + machine/devices/events/isa/profiles），
  directed 套件 250+ 断言引自教程/官方 Verilog/contract ledger。
- **阶段 5（2026-08-28 实现落地）**：纯 TS P3–P7 课程汇编器。source/include
  graph、`.eqv`、`.macro`、严格 parser、text/ktext/data layout、relocation、
  sourceMap origin chain、课程常用 pseudo 与生成器 RI cell；`BuiltinTsAssemblerProvider`
  注册在 legacy 之后并写入课程 HexText/kernel dump；`assembler.assemble` 进入
  JSONL CLI/Worker；assembly-diff lane 对固定 MARS v0.6.3 在全部 10 个 corpus
  用例 text/ktext/data 零差异；TS/TS full-stack 测试进入 verify:phase5 双平台 gate。
  额外对 stone-cpu/alh-cpu/gyc-co/hlc-cpu/kimi-cpu/ds-cpu 中 603 个 P3–P7 ASM
  做兼容审计：全部成功汇编；对可比较部分做 pinned MARS 批量差分，text/ktext 无
  差异（仅 5 个旧 P5 自动测试出现 MARS `.data` 稀疏块 dump 与其模拟器真实内存
  不一致的已知限制）。按 `COURSE-COMMON-ASM-RAW-WORD-001` 支持 `.text/.ktext`
  中的原始 `.word` 注入，为后续 RI 未知指令测试点生成保留汇编器能力。
- **阶段 4（2026-08-27 实现落地）**：生产 oracle 与自动测试能力接入。
  `BuiltinTsExecutionProvider` 注册在 legacy 之后且默认解析仍为 MARS，仅供显式
  shadow/verify-both；`CourseTracePipeline` 在 P3 Logisim 与 P4–P7 traceRunner
  全分支注入 createCase/prepareProgram/runOracle/runDut(或 runLogisimDut)/
  compareTraces/recordOracle/updateArtifacts/copyArtifact；builtin 产出 raw trace、
  canonical CommitEvent、event digest、coverage、checkpoint 与原子 event artifact；
  Worker lane 按 128 条/slice 流式回传 CommitEvent 并在 ACK/backpressure 下由
  provider 重建；executor shadow 保存 source/image/raw traces/input/schedule/
  engines/contracts 复现 bundle，未登记差异固定 inconclusive；batch/continuous
  使用会话 AbortController，batch stop 命令可用；builtin replay adapter 进入默认
  registry；CI 的 ubuntu/windows 双平台 `verify:phase4` gate 已配置，并在 e38d508 的 GitHub Actions 远端运行全部 success（Test and compile、ubuntu/windows Phase 1 portability、独立 TS CLI conformance）。

### 治理模型（2026-08-27 起，单人维护规模）

- **测试即证据**：全部 directed 测试、RTL 决策向量、250 固定 seeds、frozen
  regression、TS-CLI 交叉核对在每次 push 自动运行（CI 与 Phase 1 portability 两个
  workflow，覆盖 ubuntu-24.04 与 windows-2025）。
- **expected data 更新**：用 `manage-*.mjs --refresh-integrity` 重新生成派生 hash
  （强制 candidate 形态），在 diff 中审阅后正常提交；没有单独批准步骤。
- **benchmark**：手动 dispatch `ci.yml`（`run_fixed_benchmark=true`）在固定双 runner
  采集 candidate，`bench/validate-fixed-benchmark.mjs` 校验后替换 baseline。
- **branch protection**：直推 main；禁止 force-push 与删除分支。
- **有意保留的红灯**：`verify:decisions --require-rtl` 只在装有 Icarus 的环境（CI）
  通过；本机无 Icarus 时该步失败是设计行为，不是回归。
- 历史 approval 信封与审阅记录归档在 `conformance/mips/governance/reviews/`，仅作
  provenance，不再被任何检查读取。

### 尚未开始

- 阶段 6（按 profile 默认切换）、阶段 7（P2 与常见 MARS 用户体验）。

## 1. 决策摘要

本项目不机械翻译 MARS 的 Java 类，也不以“完整复制 MARS”为目标。长期目标是实现一个 **BUAA CO 课程专用 MIPS 引擎**：

1. 默认执行语义以课程教程和官方硬件契约为准，尤其 P7 明确不以 MARS 为最终标准。
2. 汇编语法兼容性在声明的范围内以固定 MARS v0.6.3 为参考；不追求 GUI、浮点、工具插件和全部 syscall。
3. 汇编器与执行器彻底分离，以不可变 `ProgramImage` 连接，从而能够独立验证二者。
4. 核心直接产生结构化 `CommitEvent`，文本 `coL1/coL2` 仅作为 legacy 输入/输出适配层。
5. 执行核心无全局状态、无 VS Code/LSP/文件系统依赖；批量运行放入懒启动 Worker，支持取消、限额和流式事件。
6. 固定 MARS 永久保留在 CI/nightly、`marsGolden` 重生成、历史问题复现和可选验证命令中，但成熟后不再随普通用户工作流运行。
7. 正确性切换采用角色化固定 reference、独立 assembly/execution/full-stack 验证 lane、规范向量、属性/变形测试、mutation testing 和长期 shadow，而不是依靠代码覆盖率或“随机测试跑得多”。

本方案中最重要的边界是：

- **course-correct**：课程硬件应当表现出的语义，是产品默认。
- **mars-compatible**：固定 MARS 的汇编或运行行为，只用于兼容、迁移和解释差异。

二者发生冲突时不得静默选择；必须通过带规范依据的差异记录明确裁决。

## 2. 目标、成功标准与非目标

### 2.1 产品目标

- P3–P7 的机器码生成和架构 oracle 不再要求用户配置 MARS/JAR；P4–P7 因此不再因 MIPS 工具链要求 Java。
- P2 逐步迁移到内置汇编器和确定性 console syscall host；在覆盖不足期间允许显式使用 legacy MARS。
- 同一核心服务于：机器码导出、课程黄金执行、随机生成器安全状态、机器码验证、LSP 精确诊断和测试报告。
- 测试失败能给出第一处分歧前后的完整架构状态，而不只是一行 GRF/DM 文本差异。
- 支持确定性 replay、断点/watchpoint、覆盖率、外部事件计划、状态快照和失败自动缩减。
- 扩展激活不加载模拟器；所有昂贵操作惰性发生，且不会阻塞 extension host 或 LSP 主循环。

### 2.2 最终成功标准

- P3–P7 默认路径在不安装 MARS 的环境中完成汇编、oracle 执行和 DUT 对拍。
- 声明支持的课程汇编语法对固定语料达到 text/kernel/data image 零未解释差异。
- P3–P7 指令、访存边界、延迟槽、HI/LO、P7 CP0/异常/中断/Timer 契约均有独立规范用例和关键 mutation。
- 生产路径不再解析 MARS 文本来修正 `$gp/$sp`、REGIMM、SWL/SWR、异常 victim 或内存上界差异。
- 旧 case/report 能读取，新 case 可在无原工作区绝对路径的情况下 replay。
- 固定 MARS reference、对应源码、构建环境、hash 和差异账本可永久重现。

### 2.3 非目标

首期明确不做：

- MARS Swing GUI、编辑器、Mars Tools、BackStepper UI。
- CP1/浮点指令、音频/对话框/图形 syscall、动态 class loader。
- 所有 MARS 伪指令、directive、错误消息的逐字兼容。
- 周期精确的五级流水线参考 CPU；该核心是架构/提交级 oracle。
- 用 ISA 解释器替代 Verilog/Logisim 对 hazard、stall、flush、MDU busy 周期和 RTL 协议的验证。
- 把有限差分/随机测试描述成形式证明。

## 3. 规范来源与优先级

### 3.1 规范优先级

遇到行为冲突时按以下顺序裁决：

1. 当前课程教程中的提交要求、地址/异常契约和明确评测约束。
2. 教程明确引用的 MIPS-C/SMRL 规则及 Timer 规范 PDF。
3. 官方下发组件源码中未被上层契约覆盖的内部行为，例如 Timer 的状态转移。
4. 官方 demo/TB 只作为测试场景和波形依据，不得反向定义容量、地址或异常语义。
5. 仓库中经校验的课程资源，例如 `courseConfig.json`、`generatorProfiles.json`、`p7Hardware.json`。
6. 固定 MARS v0.6.3，仅用于教程未规定的汇编器行为和 legacy 兼容。
7. 当前插件实现只能作为迁移输入，不能反向定义规范。

例如 P7 demo TB 的 DM 实现细节不能覆盖教程规定的 `0x0000..0x2fff`；官方 Timer 源码能够在内部接收 COUNT 写，也不能覆盖 CPU 契约要求该访问产生 AdES 并抑制设备写的规定。

P7 教程明确说明 MARS 与 SMRL/课程规范存在差异，正式测试不以 MARS 为准，见 [P7-2-6](../../../cscore/markdown/P7/implement/P7-2-6.md) 7–10 行。因此 P7 的规范向量优先于 MARS differential。

### 3.2 课程 profile 契约

| Profile | 基本指令 | 延迟槽 | 溢出 | 初态/地址 | 额外契约 |
| --- | --- | --- | --- | --- | --- |
| P3 | 8 条：`add sub ori lw sw beq lui nop` | 产品契约冻结为无 | 32 位环绕，不异常 | PC=`0x3000`；GPR/DM 全零；IM `0x3000..0x6fff`；DM `0..0x2fff` | P3 reset 为异步；核心只建模 reset 后架构态 |
| P4 | P3 + `jal jr` | 无 | 32 位环绕，不异常 | 同上 | GRF/DM commit 文本无时间前缀 |
| P5 | 与 P4 最低集相同 | b/j 一条，link=`PC+8` | 32 位环绕，不异常 | 同上 | 五级流水线；trace 有时间前缀，比较忽略周期 |
| P6 | 教程列出的 28 条 + `nop=0`，加入逻辑、byte/half、MDU、`bne` | 一条 | 所有运算暂不产生异常 | 同上；小端 byte lane | MDU 乘 5/除 10 周期属于 DUT 时序检查，不属于纯 ISA 结果 |
| P7 | P6 + `mfc0 mtc0 eret syscall` | 一条；`eret` 无延迟槽 | `add/addi/sub` 可触发 Ov | 加 CP0、Timer、IG、异常入口 `0x4180` | 中断高于当前异常；精确异常；`syscall` 只触发异常 |

指令集事实以 [generatorProfiles.json](../../resources/mips/generatorProfiles.json) 为当前机器可读入口；其内容必须在阶段 1 收敛到统一 ISA/profile catalog。

#### P5/P6 可比较域与停止契约

`COURSE-P56-DOMAIN-001` 同时约束 generator、shrinker、preflight 和 differential 计数：

- macro/pseudo 展开后的每条真实指令必须属于对应 profile，IM/DM 分别限制在 `0x3000..0x6fff` 和 `0..0x2fff`。
- 生成语料不得产生 AdEL/AdES/RI；这些输入属于非法/专项拒绝测试，不计普通执行 differential。
- `div/divu` 除零、`jalr` 的两个寄存器相同、delay slot 内再次执行 branch/jump 均属于 undefined 域；执行器可以确定化以便诊断，但不得把结果作为严格 expected。
- 标准 completion 为末尾自环 `beq` 加 delay-slot `nop`；halt detector 识别 profile 指定的完整二指令序列并在 nop 成功提交后停止，不能仅看到 branch PC 就提前结束。

真实学生程序若超出该可比较域，必须由 capability/preflight 明确分类；不能悄悄进入 strict differential 或依靠 step limit 假装通过。

### 3.3 P7 必须冻结的契约

#### 地址空间

- DM：`0x0000_0000..0x0000_2fff`
- IM：`0x0000_3000..0x0000_6fff`，有效字地址末端 `0x6ffc`
- 初始 PC：`0x3000`
- handler：`0x4180`
- Timer0：`0x7f00..0x7f0b`
- Timer1：`0x7f10..0x7f1b`
- 外部中断应答：`0x7f20..0x7f23`

来源：[P7-2-2](../../../cscore/markdown/P7/implement/P7-2-2.md) 和 [p7Hardware.json](../../resources/co/p7Hardware.json)。

#### CP0 与异常

- 必做 CP0 为 SR(12)、Cause(13)、EPC(14)，复位为 0，未实现位恒零。
- SR.IM=`15:10`、EXL=`1`、IE=`0`；Cause.BD=`31`、IP=`15:10`、ExcCode=`6:2`。
- 进入异常/中断置 EXL，`eret` 清 EXL 并跳 EPC；Cause.IP 每周期反映 HWInt。
- Int=0、AdEL=4、AdES=5、Syscall=8、RI=10、Ov=12。
- 每次接受 Req 都覆盖 Cause.BD 与 ExcCode：非延迟槽必须把 BD 清 0，中断必须把 ExcCode 写 0，不能保留上一次事件的字段。
- 中断请求成立条件必须同时满足 `IE=1`、`EXL=0` 和 `(IM & HWInt) != 0`；为三者组合建立独立真值表。
- Timer0、Timer1、IG 分别连接 `HWInt[0]`、`HWInt[1]`、`HWInt[2]`。课程不要求嵌套异常/中断。
- 中断和当前指令异常同时存在时，中断优先；返回后重执行受害指令。
- 中断 victim 是宏观 PC 对应、原本将要提交的指令；非延迟槽时 EPC 保存该宏观 PC。
- 延迟槽受害指令置 BD，EPC=`victimPC-4`，无论分支是否 taken。
- 跳到未对齐 PC 时，EPC 保存错误的新 PC。

来源：[P7-2-3](../../../cscore/markdown/P7/implement/P7-2-3.md)、[P7-2-4](../../../cscore/markdown/P7/implement/P7-2-4.md)、[P7-2-6](../../../cscore/markdown/P7/implement/P7-2-6.md)。

#### 异常触发矩阵

- IF PC 未 4-byte 对齐或不在 `0x3000..0x6ffc`：AdEL。
- `lw/sw` 未 4-byte 对齐，`lh/sh` 未 2-byte 对齐：load 产生 AdEL，store 产生 AdES。
- `lb/lh/sb/sh` 访问 Timer、load/store 有效地址加法溢出、地址不属于 DM/Timer0/Timer1/IG：按访问方向产生 AdEL/AdES。
- 任意 store 写 Timer COUNT：AdES，并且必须在设备 commit 前抑制事务；课程不规定该检查必须位于 Bridge 还是 CPU 内部。
- `add/addi/sub` 有符号溢出：Ov；`syscall`：Syscall。
- 未实现 opcode 或 R-type funct：RI。课程官方非法向量只保证组合不属于 MARS 基本指令，因此 decoder 必须按 profile 判断，不能按“宿主 MARS 是否认识”判断。
- assembler/机器码 validator 可以诊断非 canonical 保留位，但 P7 runtime recognition 只按 opcode 和 R-type funct；其他保留字段异常不得额外触发 RI。
- IF-AdEL 与 RI 的 victim 作为无副作用 `nop` 流到统一 CP0 仲裁点，保证异常前没有部分提交。

这些条件应覆盖所有**可达且有语义区分度**的 directed cells，而不是机械构造全笛卡尔积：RI 与 Syscall、Ov 与访存异常属于互斥指令类；同一受害指令按 `F:AdEL > D:RI/Syscall > E:Ov > M:AdEL/AdES` 保留最早阶段的非零异常码，不同受害指令先按程序年龄仲裁，已使能中断在提交点覆盖异常并令 victim 重试。

必须区分四个边界：运行期 PC 超出合法 IM 是架构 AdEL，运行期访存超出合法 region 是架构 AdEL/AdES，assembler 试图放置越界 segment 才是汇编诊断；合法 IM 范围内但 `ProgramImage` 未提供该 word 时，strict lane 以 `unloaded-instruction` 标记 out-of-domain（不是 AdEL，也不合成 nop）。仅显式 exploratory policy 可 synthetic zero-fill，且不得成为 strict golden。

#### Timer 与外部事件

- CTRL `+0`、PRESET `+4` 可读写；COUNT `+8` 只读。非法 COUNT 写必须产生 AdES，并在到达 Timer commit 前被抑制。
- CTRL bit3 为 IM，bits2:1 为 Mode，bit0 为 Enable；Mode 0/1 分别为单次/周期，2/3 未定义。
- CTRL/PRESET/COUNT reset 均为 0；CTRL 高 28 位读零、写忽略。
- 对外 IRQ 受 CTRL.IM 门控；清 IM 必须立即撤销可见请求。
- `CycleContract` 按官方状态机冻结：`IDLE && Enable -> LOAD` 并清 pending IRQ；`LOAD -> CNT` 并令 COUNT=PRESET；`CNT && !Enable -> IDLE`；`CNT && COUNT>1` 递减；`CNT && COUNT<=1 -> INT`、COUNT=0、pending IRQ=1。
- `INT` 的下一边沿：Mode 0 清 Enable、回 IDLE 且 pending IRQ 保持；Mode 1 清 pending IRQ、回 IDLE，随后还需经历 `IDLE -> LOAD -> CNT` 才重新装载。不得实现为到零同边沿立即 reload。
- 计数中清 Enable 会停止；再次置 Enable 从 PRESET 重新加载。所有寄存器写均优先于设备同周期自动更新。Mode 0 restart 的写 EN 周期仍保持 IRQ，紧随的第一个非 WE `IDLE -> LOAD` 边按官方 RTL 清 pending IRQ；Timer PDF 的相反表述登记为 source conflict，不宣称两者一致。
- Timer 按时钟周期推进；外部中断按宏观 PC 产生，并保持到对 `0x7f20` 的有效写。
- IG 读取恒为 0；写入本身无存储状态，官方测试只用 handler 中的 `sb $0,0x7f20($0)` 应答 IRQ。

#### 官方 P7 场景边界

- `0x417c -> 0x4180` 的自然顺序执行是普通执行，不能仅凭 PC=`0x4180` 推断发生异常。
- 官方场景不跳到合法 IM 范围内但未加载的 word，并保证 handler 内不再发生异常/中断；strict harness 遇到前者 fail-closed 为 out-of-domain，真正越过 IM 合法范围仍必须进入架构 AdEL，不能由 host 提前终止。
- 官方场景不写 Cause，但可能通过 `mtc0` 修改 SR/EPC；测试不得错误地把所有 CP0 写都当非法。

来源：[Timer 规范](../../../cscore/markdown/assets/cscore-assets/COCO定时器设计规范-1.0.0.4.pdf)、[官方 Timer](../../../cscore/markdown/assets/cscore-assets/P7_standard_timer_2019.v)、[中断 TB](../../../cscore/markdown/P7/assets/tb_interrupt_demo.v) 和 [P7-2-6](../../../cscore/markdown/P7/implement/P7-2-6.md)。

### 3.4 必须显式决策的歧义

阶段 0 应建立带稳定 ID 的 contract/decision ledger，至少处理：

- `COURSE-P7-ISA-EXT-001`：P7 必做表不含 `addu/addiu/subu`，官方 handler 示例实际使用 `addu/addiu`；`subu` 只能作为另行决定的常见扩展。建议拆成 `required`、`commonExtensions`、`marsCompatibility` 三层。
- `COURSE-P7-EXC-PRIORITY-001`（2026-08-26 frozen）：课程冻结 Int 优先与程序年龄；同一 victim 的 `F>D>E>M` 是 stone926 接受的产品补全。L13 相邻页表述冲突已登记，向量只覆盖可达组合。
- `COURSE-P7-CP0-SAME-CYCLE-001`（2026-08-26 frozen）：`reset > accepted Req > victim side effects`，中断资格读取 pre-instruction SR；accepted Req 抑制当前 `mtc0`/`eret` 等副作用。官方 handler 排除 `eret+Req`，`eret` 延迟槽和同指令 `mtc0×eret` 不进入伪笛卡尔要求。
- `COURSE-P7-TIMER-MODE-001`：Mode 2/3 为 undefined；生成器不得产生，执行器返回明确的 undefined/unsupported 事件。
- `COURSE-P7-TIMER-RESTART-001`（2026-08-26 frozen）：PDF 与官方 Verilog 明确冲突；official-device lane 仲裁为后者，在 restart 的首个非 WE `IDLE→LOAD` 边清 IRQ。CI 必须直接编译固定哈希官方 RTL。
- `COURSE-P3-IM-001`：旧 MARS 教程限制不等于 4096-word 硬件限制；course 模式支持到 `0x6ffc`，legacy provider 单独记录其边界。
- `COURSE-P3-DELAY-001`：P3 教程没有明文定义延迟槽；产品冻结为无延迟槽，并用 P3 模板、评测 trace 和 P4 明确的无延迟槽规则交叉验证。
- `COURSE-P7-MDU-PRECISE-001`：已经改变 MDU 状态的动作允许不恢复；当较老 victim 在 M 级、年轻 `mult/mthi` 仍在 E 级且本周期尚未发生动作时，必须抑制启动/写入。架构 oracle 不假装模拟唯一微结构，容许集合由 P7 DUT scenario policy 判断。
- `COURSE-P7-UNLOADED-IM-001`（2026-08-26 frozen）：教程只排除该输入而未定义 ROM 值；stone926 将 strict lane 冻结为 out-of-domain，zero-fill 仅允许显式 exploratory synthetic 模式。
- `COURSE-COMMON-ASM-RAW-WORD-001`（2026-08-28 frozen）：builtin TS 汇编器允许 `.word` 出现在 `.text`/`.ktext`，把每个操作数按小端原始 32-bit word 注入当前段并推进 PC（例如 `.text; .word 0x12345678; ori ...`）。这是为后续测试点生成器注入未知指令、参与 P7 RI 异常测试而保留的内部扩展；测试点生成的注入侧尚未实现。固定 MARS 汇编器拒绝该形式，作为 `MARS-DIV-RAW-TEXT-WORD-001` 登记为有意差异；assembly-diff 声明语料不得依赖该扩展，P7 RI 生成路径在本阶段仍走 legacy `cl` 自定义 class。

### 3.5 Reference artifact 基线

“MARS reference”必须按角色解析，不能等同于用户设置中的任意 JAR：

| 角色 | 固定输入 | 用途 |
| --- | --- | --- |
| `mars-assembler-v0.6.3` | [`Mars_CO_v0.6.3.jar`](https://github.com/stone926/Mars-with-BUAA-CO-extension/releases/download/v0.6.3/Mars_CO_v0.6.3.jar)，3,544,465 bytes，SHA-256 `599957c96b4e94c267a117d548eb5a1bd32d72d879a831a5f695a648c1eafb31`，tag commit `8b53a492dddc4fe1c62a7a02c55bea6fc4fb49d8` | 汇编兼容/image dump 和历史运行基线 |
| `mars-regression-v0.6.3` | [`Mars_Test_CO_v0.6.3.zip`](https://github.com/stone926/Mars-with-BUAA-CO-extension/releases/download/v0.6.3/Mars_Test_CO_v0.6.3.zip)，8,771 bytes，SHA-256 `0b7f705de67bbd5a4060c03a4425aad84c8be1e257ff4e049290484aa3d7987e` | 不随本地 fork 漂移的 frozen regression |
| `legacy-course-executor` | 阶段 0 决定并归档；候选为 tag 之后的 `c6197f433e20ac0800a48ea1255053147ade5a77` | 对拍当前 fork 新增的课程语义；必须从干净 checkout 可重复构建并拥有独立 artifact hash |

制定本计划时，配置路径 `D:\Program FIles\Mars\Mars.jar` 的实测 SHA-256 为 `307ca4547d2fa8220157c212119ed41c77db34b057f79046034f75ade643aa68`，与 release asset 不同；本地 fork 也位于 `c6197f4` 且有未提交状态。因此二者只能作为现状调查输入，不能进入 conformance。CI 必须下载/读取 manifest 指定资产，校验名称、大小、hash 后 fail closed，禁止从用户路径、本地 HEAD 或脏工作树隐式替换。

如果阶段 0 接受 `c6197f4` 的课程修复，应发布一个不可变、可重建的 reference artifact；若不接受，则其行为差异必须进入 course vector/ledger，不能把未发布 HEAD 伪装成 v0.6.3。

## 4. 当前系统与迁移切入点

当前数据流是：

```text
ASM -> runMarsFile(dump) -> HexText
    -> runMarsFile(coL2 oracle) -> 文本修复/兼容检查
    -> ISim/Logisim -> 文本 Trace
    -> compare -> report/case artifacts
```

主要硬耦合：

- [mips.ts](../../src/mips.ts) 的 `runMarsFile` 同时处理 VS Code UI、参数、文件系统、课程预检、进程和产物。
- [asmCaseStore.ts](../../src/asmCaseStore.ts) 直接用 MARS 准备机器码。
- [traceRunner.ts](../../src/courseTesting/traceRunner.ts) 硬编码 dump→MARS→DUT→compare；P3 的 [courseTestLogisim.ts](../../src/courseTestLogisim.ts) 也直接跑 MARS。
- [asmCaseStoreCore.ts](../../src/asmCaseStoreCore.ts) manifest v1 将 provider 和 artifact 命名为 `mars`。
- [traceParser.ts](../../src/language/mips/traceParser.ts)、[machineCodeValidation.ts](../../src/courseTesting/machineCodeValidation.ts)、[marsImageCompatibility.ts](../../src/mips/legacy/marsImageCompatibility.ts) 和随机生成器重复实现 decoder、寄存器读集、延迟槽及部分语义。
- 当前 `CpuState` 是生成器辅助状态，不是可独立验证的 oracle。

可复用基础：

- MIPS 宽容 lexer/AST、字面量和 operand 解析。
- 课程 profile、P7 常量、随机 seed/case 持久化、trace compare 和 probe。
- Vitest、无头 `test-cli`、现有 MARS regression 及大量已知差异反例。
- 独立 LSP IPC 进程和通用子进程封装。

## 5. 目标架构

### 5.1 分层

```text
SourceUnit[]
    │
    ▼
Pure TS assembler ───────► ProgramImage + SourceMap
                                  │
                                  ▼
                          MachineSession
                         stepInstruction()
                                  │
                                  ▼
                            CommitEvent stream
                           ├─ course projector
                           ├─ first-diff state
                           ├─ coverage/assertion
                           └─ artifact/replay

Official Timer contract ─► DeviceSession.tickCycle() ─► device state/events
Real DUT cycle probes ───────────────────────────────► scenario properties

VS Code/LSP/UI ─► Provider ─► lazy Worker host ─► Pure core
Legacy MARS ────────────────────────────────► reference provider only
```

建议目录：

```text
src/mips/
  core/                         # 纯 TS；无 vscode/LSP/fs/worker
    api.ts
    values.ts
    diagnostics.ts
    isa/{catalog,decoder,encoder,operandSchema,semantics}.ts
    assembler/{sourceGraph,preprocessor,parser,layout,directives,pseudo,assembler}.ts
    machine/{state,memoryBus,transition,session,execution}.ts
    devices/{timer,interruptController,console}.ts
    profiles/{profile,p2,courseP3P6,courseP7}.ts
    events/{commitEvent,traceProjection,coverage}.ts
  providers/
    contracts.ts
    providerResolver.ts
    builtinAssemblerProvider.ts
    builtinExecutionProvider.ts
    legacyMarsProvider.ts
  host/
    runtimeManager.ts
    workerProtocol.ts
    workerClient.ts
    workerMain.ts
    sourceBroker.ts
    assemblyCache.ts

src/courseTesting/
  pipeline/{courseTracePipeline,courseImagePolicy,executionBudget,haltPolicy}.ts
  oracle/{commitProjection,differentialRunner}.ts

conformance/mips/              # 独立 runner/corpus/golden；禁止 import 生产实现
```

模块边界由脚本检查：

- `src/mips/core/**` 禁止 import `vscode`、`vscode-languageserver`、`fs`、`path`、`worker_threads`。
- LSP 可以依赖纯 frontend/catalog；core 不得反向依赖 LSP。
- course testing 只通过 provider/API 使用核心，不直接改状态。
- MARS 参数、Java 进程和 MARS-specific repair 只能出现在 legacy/reference 层。

### 5.2 唯一 ISA catalog

新增权威 `resources/mips/isa.json`，描述真实指令：

- `runtimeMatchMask/runtimeMatchValue`：profile 执行期识别；P7 RI 只使用 opcode 与 R-type funct
- `canonicalEncodingConstraints`：assembler/validator 的固定保留位与规范编码检查，不得被 runtime decoder 误用
- 字段布局与 operand forms
- GPR/HI/LO/CP0 读写角色
- 控制转移、link、delay-slot 属性
- 可能异常、profile availability
- semantic handler ID

由 `scripts/generate-mips-isa.mjs` 生成 `src/mips/core/generated/isaCatalog.ts` 和 LSP 展示数据。执行 handler 仍写在 TS 中，并通过 exhaustive semantic-ID 映射注册。这样 worker 不需同步读取 JSON，也能让 encoder、decoder、validator、LSP 和生成器共享结构事实。

独立 conformance generator 不允许读取这份生产 catalog，避免实现和测试相关性错误。

### 5.3 核心数据契约

```ts
interface SourceUnit {
  id: string;
  uri?: string;
  text: string;
}

interface ProgramImage {
  formatVersion: number;
  fingerprint: string;
  entryPc: number;
  segments: readonly ProgramSegment[];
  symbols: readonly SymbolEntry[];
  sourceMap: readonly SourceMapEntry[];
  inputGraph: readonly SourceUnitFingerprint[];
}

interface MipsAssemblerProvider {
  readonly descriptor: EngineDescriptor;
  readonly capabilities: AssemblerCapabilities;
  preflight(request: AssemblePreflightRequest): ProviderPreflight;
  assemble(request: AssembleRequest, context: ProviderRunContext): Promise<AssembleResult>;
}

interface MipsExecutionProvider {
  readonly descriptor: EngineDescriptor;
  readonly capabilities: ExecutionCapabilities;
  preflight(request: ExecutePreflightRequest): ProviderPreflight;
  execute(request: ExecuteRequest, context: ExecutionRunContext): Promise<ExecutionResult>;
}
```

执行器输入必须是 `ProgramImage`，不能是 ASM 路径。HexText、MIF 和 Verilog memory image 是 artifact adapter 的输出格式，不进入领域模型。

`AssemblerCapabilities`/`ExecutionCapabilities` 是版本化数据，至少声明 profile、真实指令/扩展层、directive/pseudo、syscall、device、interactive console 和 event schema。Resolver 必须在产生任何副作用前完成 preflight；不支持时返回结构化 capability diagnostic，禁止“执行到一半再隐式 fallback”。`EngineDescriptor + capabilities + catalog/contract/normalizer revision` 共同构成证据 fingerprint。

架构执行与周期设备模型均同步、确定且实例化，但不伪造二者之间不存在的时间映射：

```ts
interface MachineSession {
  stepInstruction(input?: StepInput): StepResult;
  runSlice(maxInstructions: number): RunSliceResult;
  snapshot(level: SnapshotLevel): MachineSnapshot;
}

interface DeviceSession {
  tickCycle(input: DeviceCycleInput): DeviceCycleResult;
  snapshot(): DeviceSnapshot;
}

interface DeviceBusPort {
  prepare(access: DeviceAccess): PreparedDeviceAccess | DeviceAccessFault;
  read(prepared: PreparedDeviceAccess): number;
  commit(prepared: PreparedDeviceAccess): readonly DeviceEvent[];
  abort(prepared: PreparedDeviceAccess): void;
  sampleInterrupts(): number;
}

interface CourseSystemSession {
  stepInstruction(input?: SystemStepInput): StepResult;
  tickDevices(input: DeviceCycleInput): DeviceCycleResult;
}
```

`stepInstruction` 先产生 `InstructionEffect`，完成地址、异常和中断仲裁后再原子提交，结构上保证异常 victim 不产生部分 GPR/DM/CP0 写。它不会自动推进 Timer。架构 anchor 中 Timer 禁用，或只消费 `ExecuteRequest.deviceTimeline` 显式给出的 instruction-boundary 事件。

`DeviceSession.tickCycle` 单独实现官方 Timer/IRQ 的时钟边沿语义。`DeviceCycleInput` 明确本周期 bus read/write、外部 IRQ 和 reset；machine-readable `CycleContract` 冻结“输入采样 → 合法性检查 → register write 优先/内部更新 → IRQ/可观察状态”的顺序。真实 P7 DUT 中 CPU commit、stall 与 Timer cycle 的交织由学生微结构决定，顺序解释器不能推导；该类用 cycle probe/property/partial-order scenario 验证，不生成伪精确的逐指令 Timer golden。

`CourseSystemSession` 只负责组合二者：架构 step 在指定 boundary 采样 IRQ，MMIO 先 `prepare` 并完成宽度/地址/COUNT-write 校验；异常/中断仲裁失败时 `abort`，成功时 CPU effect 与 device transaction 作为同一个 canonical commit 提交。`prepare/read/commit/abort` 均不推进 Timer，只有显式 `tickDevices` 才推进周期。这样可以抑制异常 victim 的设备写，又不会让一次 `lw/sw` 隐式等价于一个流水线周期。

32 位值在生产核心中用 `number`，每次边界显式 `>>>0`/`|0`；乘除 64 位值用 `BigInt.asUintN/asIntN`。内存读写显式处理小端 byte lane，不能依赖宿主 TypedArray endian。

### 5.4 Canonical CommitEvent

```ts
interface CommitEvent {
  sequence: number;
  kind: 'instruction' | 'exception' | 'interrupt' | 'halt';
  pcBefore: number;
  instructionWord?: number;
  pcAfter: number;
  delaySlot?: boolean;
  branchOriginPc?: number;
  gprWrites: readonly RegisterWrite[];
  hiLoWrites: readonly HiLoWrite[];
  cp0Writes: readonly Cp0Write[];
  memoryWrites: readonly MemoryWrite[];
  deviceEvents: readonly DeviceEvent[];
  haltReason?: HaltReason;
}
```

`MemoryWrite` 同时保留 raw address/value、byte mask、写前/写后完整 word。P4–P7 的旧 trace 由 profile projector 生成；P6/P7 的 `sb/sh` 由 projector 输出对齐地址和合并后的 word。时间戳属于 DUT observation，不属于 oracle 架构状态。

Canonical expectation 另带字段级 `definedMask`、`observableMask` 和可选 `allowedValues/allowedTransitions`。HI/LO 未定义值、P7 容许的 MDU 微结构状态和只验证偏序的设备事件不得进入严格全状态比较；checkpoint/final digest 只覆盖“已定义且可观察”的字段。缺少必要 `CycleContract/deviceTimeline` 的 Timer case 标记为 `out-of-domain`，不能靠 waiver 或完整状态 digest 假装可比较。

### 5.5 Profile 与时间模型

`CourseExecutionProfile` 参数化：

- 指令 availability 与扩展层级
- delay-slot/link 策略
- arithmetic overflow 策略
- reset 后架构态
- segment/MMIO 地址空间
- exception/CP0 policy
- device/cycle policy
- trace projection 和 completion policy

P3/P4/P5/P6/P7 不得通过散落的 `if (profile === ...)` 修改状态机。P7 非 Timer anchor 使用架构 session；Timer 单元契约使用 `DeviceSession`；真实 CPU+Timer 集成使用 cycle/event scheduler 与 probe/property。MARS 的“每指令 tick”只能作为 legacy behavior，不能作为课程 Timer 真值或最终 shadow 通过证据。

### 5.6 Worker、取消与缓存

> 落地提示（2026-08-27）：本节的 include-graph 两级缓存索引、独立 LSP worker 与
> Worker 池设计属于偏重的前置设计。阶段 4 实际动手时按当时的真实负载重新评估
> 必要性，能用无缓存/单 Worker 就先做简单正确版本，测量证明有收益后再加层。

- activation 只构造轻量 `MipsRuntimeManager`，第一次 assemble/execute 时才启动 `out/mips/host/workerMain.js`。
- 第一版默认一个 Worker；测量证明有收益后，后台批跑最多两个。交互任务优先于 continuous 任务。
- Worker 每 128–256 条指令运行一个 slice 后 yield，检查 cancel 并处理消息；事件以固定批次传输并支持 backpressure。
- `AbortSignal` 在 host 转成 `cancel(id)`；宽限期后可 terminate/recreate Worker。legacy provider 和外部 DUT 进程也必须接收同一个 signal。
- include 由 worker preprocessor 发现，通过反向 `readSource(jobId, fromSourceId, specifier)` RPC 请求 host `SourceBroker`；host 负责工作区信任、根目录边界、路径规范化和异步读取，core/worker 不直接读文件。
- 第一版拒绝 macro expansion 动态生成的 include，并以 capability/稳定诊断声明；若以后支持，必须复用同一 RPC、加入展开上限并提升 semantics revision。
- 第一版只缓存不可变 `ProgramImage`。assembly key 包含核心语义 revision、profile、options、完整 include graph hash、ISA catalog hash 和课程 contract hash。
- include graph hash 使用解析后的 canonical URI、内容 hash 和有序边；Windows 盘符/分隔符/大小写与 Unicode normalization 规则写入 cache schema，防止同文件多键或错误复用。
- 因完整 include graph 只能在预处理后确定，cache 使用两级索引：root/options 指向上次 dependency manifest，host 重新校验所有依赖 hash 后才允许命中；否则重跑预处理并以最终 graph hash 写入，绝不只按根文件 mtime 命中。
- 不缓存 execution result；stdin、IRQ schedule、cycle policy、stop condition 和 engine revision 极易导致错误命中。
- 事件默认流式消费；报告只保留计数、第一处差异和选定 checkpoint，完整流写 artifact。

### 5.7 LSP 集成

当前 LSP AST 依赖 `TextDocument/Range`，且是容错导航模型，不能直接充当严格 assembler IR。先抽出 offset-based source model、lexer、literal/operand scanner；LSP adapter 转成 Range。严格 assembler 在 save/显式运行触发，on-change 仍使用轻量 parser，避免每次按键进行 include/layout。

Assembler diagnostics 使用稳定 code、纯 `SourceSpan` 和 macro/include origin chain；LSP/VS Code adapter 负责映射 URI/Range。运行时错误通过 `ProgramImage.sourceMap` 回溯到源代码，但默认进入测试报告，不长期污染 Problems 面板。

严格 assembler 不在 LSP request handler 同步执行。LSP process 使用同一版本化 worker protocol 启动自己的 lazy worker，不共享 extension-host Worker 实例；initialize/config IPC 下发 workspace roots、trust 和 capability，LSP-side `SourceBroker` 优先读取当前 `TextDocument` snapshot，再受限读取 include。每次任务绑定 `uri + documentVersion + generation` 和 AbortSignal；新版本取消旧任务，返回时版本不符即丢弃。worker crash 只使该次 strict diagnostics 失败并自动重建，不影响 tolerant on-change features。

### 5.8 Provider-neutral case/report

先增加 v1/v2 codec，不得直接将 manifest 版本常量改成 2。v1 永久只读兼容；新任务写 v2：

```json
{
  "version": 2,
  "program": {
    "assembler": { "id": "builtin-ts", "semanticsRevision": "..." },
    "imageFingerprint": "...",
    "sourceMap": "program/source-map.json"
  },
  "oracle": {
    "engine": { "id": "builtin-ts", "semanticsRevision": "..." },
    "configurationHash": "...",
    "stopReason": "halt-loop",
    "steps": 0,
    "finalStateDigest": "..."
  },
  "artifacts": {
    "source": {}, "program": {}, "oracle": {}, "dut": {}, "referenceMars": {}
  }
}
```

- artifact path 改为 case-relative，绝对原始路径仅作 provenance。
- `program.sourceMap` 为可选且带 schema revision；legacy assembler 没有可靠映射时必须省略，禁止伪造行号。阶段 5 后 builtin image 才将其作为必备 artifact。
- assembler/oracle descriptor 保存 build、semantics、capabilities、catalog/contract/normalizer/event schema revision；`configurationHash` 不能替代这些可审计字段。
- manifest 用临时文件+原子 rename，取消或 Worker crash 不得留下半个 JSON。
- stage 使用 `assemble | oracle | dut | compare | probe`。
- 报告用 `oracleOut/oracleEvents`，渲染器兼容旧 `marsOut/marsEvents`。
- 比较器字段使用 `oracle/dut` 或 `expected/actual`。

v2 bundle 必须是 replay closure，而不是一组原工作区 hash：

- `artifacts.source` 保存 root 及全部 include 的原始 bytes/content-addressed blobs、canonical source graph 和显示用 provenance URI。
- `artifacts.program` 保存序列化 `ProgramImage`、source map/observability schema（如适用）和导出给 DUT 的 exact bytes。
- run input 保存 profile/options、stdin bytes、device/IRQ timeline、cycle contract、stop/halt/step policy、seed 与资源限额。
- engine descriptor 保存可解析的 immutable artifact digest；无需在每个 case 重复嵌入引擎，但 registry 缺失时必须明确不可 exact replay。
- `exact replay` 使用 bundle 中原引擎和 image 重放并核对 event/final digest；`re-evaluate` 使用当前引擎重新汇编/执行，生成新的比较结果，绝不覆盖原裁决。

路径只作 provenance；移动/删除原工作区后，bundle 中的 blobs 和固定 engine artifact 足以完成 exact replay。schema validator 应以此最小闭包判定 v2 是否完整。

### 5.9 MARS 源模块处置映射

“提取核心”是提取行为契约和必要算法，不是按 Java package 逐文件翻译：

| MARS 源模块 | TS 去向 | 处置规则 |
| --- | --- | --- |
| `Assembler`、`MIPSprogram`、`SymbolTable`、`ProgramStatement` | `assembler/{sourceGraph,parser,layout,assembler}` | 以 image/diagnostic differential 提取行为；拆掉 program-global 可变状态 |
| `InstructionSet`、basic instruction classes、`PseudoOps.txt` | ISA catalog、encoder/decoder、semantic handlers、pseudo expander | 结构事实单一生成；每个 handler 独立实现，测试 expected 不读取生产 catalog |
| `RegisterFile`、`Memory`、`Coprocessor0` | `machine/{state,memoryBus,transition}`、P7 profile | 按课程地址/异常契约重建；MARS memory configuration 不进入 course profile |
| `Simulator`、`DelayedBranch`、`ProcessingException` | `MachineSession`、effect/commit、diagnostics | 保留可观察语义，放弃 Singleton、Swing thread、Observer 和异常驱动的部分提交 |
| `TimerOne/TimerTwo` | `DeviceSession` | 不直接翻译；以课程 PDF、官方 Verilog和 cycle vector 重建 |
| `SystemIO`/syscall | Stage 7 console/capability host | stdin/stdout 可确定化；文件、时间、随机不进入纯 core |
| `Globals`、`Settings`、`MarsLaunch` | request/profile/descriptor；CLI 仅留 legacy adapter | 所有选项显式传入，不保留全局 singleton 或 GUI 设置副作用 |
| `BackStepper`、Venus、Mars Tools、CP1 | 不迁移 | 仅在有独立产品需求时另立方案 |

每个映射切片遵循固定顺序：先写 contract/黑盒向量并锁定 provenance，再实现纯 TS，再跑 assembly/execution differential 和 mutation，最后才允许移除对应 legacy 调用。明显参考或派生 MARS 算法的文件保留 MIT attribution；课程规范优先的模块则优先独立重实现。

## 6. 实施阶段

### 阶段 0：课程契约与 conformance 基础（已完成，2026-08-27 过门）

**目标**：在写执行语义前先定义什么叫正确，并使固定 MARS reference 与 course vector 均可重现。

工作：

- 建立机器可读 `course-contract` 与 decision/divergence ledger。
- 按第 3.5 节固定 v0.6.3 JAR/regression 资产，并为 assembler reference 与 legacy execution reference 建立不同 manifest。
- 审查 `c6197f4` 相对 tag 的课程语义变化；选择接受并从干净 checkout 构建/归档，或拒绝并把差异转为 course vector/ledger。
- 建立独立 `conformance/mips` runner；它只能通过 CLI/JSONL 调用生产 TS 引擎，并在独立 workspace/job 中按依赖白名单运行。
- 收集教程微程序、现有 regression、已知 MARS 差异和固定随机 seeds。
- 可选增加 test-only Java state tap；补丁只能观察状态，并用完整 frozen/regression corpus 对未修改 JAR 证明无语义变化。本计划不假定 stock MARS 能加载任意 TS `ProgramImage`。
- 在固定 CI runner 记录 MARS 性能基线。

退出标准：

- 所有 P3–P7 指令、内存、delay、overflow、P7 CP0/异常/Timer/IRQ 条款均有 contract ID 和规范来源。
- 两种 reference role 均能从干净环境解析到唯一 artifact/hash；任一不符时 fail closed。
- `marsGolden` 与人工审阅的 `courseVector` 可分别重复生成/验证，互不覆盖。
- 关键 planted mutants 能证明 harness 不是“永远通过”。
- 已知差异均有最小复现或明确待补项目，不存在未命名的兼容补丁。

### 阶段 1：Provider-neutral 迁移与唯一 ISA catalog（已完成，2026-08-27 过门）

**目标**：在行为不变的前提下去掉生产管线对 MARS 名称和返回结构的依赖。

工作：

- 定义带 versioned capabilities/preflight 的 assembler/execution provider；`LegacyMarsProvider` 完整包装现有行为。
- neutral 化 pipeline、trace compare side、report stage 和 case v2。
- 建立 ISA catalog/generator，逐步替换重复 opcode、read-set、delay-slot 表。
- 建立 Worker 骨架、运行时 manager、取消和模块边界检查；默认 provider 仍为 MARS。
- 将 `processCore` 升级为可取消 process supervisor：AbortSignal、grace→force、stdin/stream 收尾、幂等 settle，并按平台终止完整进程树（Windows Job Object/受维护实现，Unix process group）。

退出标准：

- 所有现有测试通过；同一输入的新旧 legacy 路径机器码、trace、判定和 halt PC 一致。
- v1 case 可读，v2 case 可 replay。
- 生产调度仅允许 legacy provider adapter import `runMarsFile`；resolver 只做 provider 选择/分派，其他 orchestration 不得接触 legacy 进程与 trace API。
- capability 不足在启动前产生稳定诊断；任何 provider 都不会在部分执行后隐式 fallback。
- 所有课程基本指令有独立 encode/decode golden；runtime recognition mask 无歧义，canonical encoding constraints 完整，并有“非 canonical 保留位不额外触发 P7 RI”的反例。
- Worker 首次使用前不启动；取消能在约定 slice 内结束。
- Java/ISim/Logisim 测试 helper 产生孙进程时，cancel/timeout 后整棵进程树退出、pipe 关闭、Promise 只 settle 一次，重复取消无副作用。

### 阶段 2：P3–P6 机器执行核心（已实现，2026-08-27）

**目标**：先解决自动测试最需要的架构 oracle；输入暂时继续使用 MARS 生成的 image，以隔离执行器错误。

工作：

- GPR、PC、HI/LO、小端 memory bus、transactional effect/commit。
- P3/P4 无延迟槽，P5/P6 一条延迟槽和正确 link。
- P6 byte/half、MDU 结果和 undefined-read policy。
- CommitEvent、defined/observable state contract、coverage、checkpoint、halt/step-limit 和 PC/word 级 diagnostics。

退出标准：

- pinned MARS image → TS executor 对 frozen corpus 和生成语料无未解释差异；需要 MARS execution 对照时，先验证 MARS 当次 dump 与该 frozen image fingerprint 相同。
- 每条 profile 指令、taken/not-taken、立即数边界、所有 byte lane、DM/IM 边界均覆盖。
- `$0`、sign/zero extend、link、delay slot、HI/LO、地址/对齐等关键 mutation 全被杀死。
- 现有生成器 `CpuState` 不作为 expected oracle；生产与测试语义源保持独立。

### 阶段 3：P7 CP0、异常、中断与 Timer（已实现，2026-08-27）

**目标**：实现课程规范优先的 P7 执行和设备模型。

工作：

- CP0 masks、EPC/BD/EXL、异常 victim transaction、Int>exception 仲裁。
- AdEL/AdES/Syscall/RI/Ov、`eret` 无延迟槽、handler/normal fall-through 区分。
- MemoryBus region + Timer0/1 + IG ack；`MachineSession` 与 `DeviceSession/CycleContract` 分离。
- 外部 IRQ 使用“宏观 victim PC + occurrence”计划，不暴露旧 `p7irq - 4` 语义。
- P7 MDU 精确异常容许项放入 DUT scenario policy，而不是污染顺序 ISA 状态机。
- 将用例分为：Timer 禁用/显式 boundary event 的架构 anchor、对照官方 Verilog/PDF 的设备 cycle vector、真实 DUT 的 CPU+Timer probe/property scenario；三类结果不得混成一个逐指令 golden。

退出标准：

- 教程规定的每类异常/中断均有架构 directed vector；Timer 0/1、write priority、IRQ 宽度/restart 均有独立 cycle vector。
- 现有 anchor/hybrid/probe corpus 通过。
- victim 无提交、BD/EPC、EXL、IRQ priority、Timer write/tick、COUNT 只读、ack、`eret` 后继抑制等关键 mutation 100% 被杀死。
- 缺少 cycle schedule 的 Timer case 被明确拒绝为 out-of-domain；不存在把“每指令 tick”作为课程真值的通过路径。
- MARS 与课程规范的差异进入 ledger；不得用宽泛 waiver 隐藏。

### 阶段 4：生产 oracle 与自动测试能力接入

**目标**：让 TS executor 在真实课程 pipeline 中执行第一阶段的 executor shadow，并交付结构化诊断价值。

工作：

- `CourseTracePipeline` 注入 assembler、oracle、DUT runner、comparator、case store。
- P3 Logisim 与 P4–P7 使用同一 oracle provider。
- 接入 structured event artifact、first-diff snapshot、coverage、assertion/watchpoint、replay。
- continuous/batch 使用 session AbortController；外部 generator、legacy MARS、ISim/Logisim 同链取消。
- executor shadow 使用 pinned MARS image + TS executor；mismatch 自动保存完整复现 bundle。
- 已登记的 `mars-compatible` 差异才允许采用 legacy；`course-correct` 差异按 course vector 裁决；任何未分类差异标记 `inconclusive` 并保存 bundle 待裁决，不得计入通过。

退出标准：

- 相同 case 重跑得到相同 event stream/final digest。
- shadow mismatch bundle 包含 source/image/input/schedule/engine/contract hash 与 raw traces。
- 取消、Worker crash、artifact retention 不产生损坏 manifest。
- first-diff 能定位 PC、word、架构写和 CP0/device 状态；只有 legacy listing 可可靠映射时才附 source span。
- 默认 provider 保持 legacy MARS；builtin 只作为显式 shadow/verify-both 选项存在，不静默升级。

### 阶段 5：P3–P7 课程汇编器（已实现，2026-08-28）

**目标**：消除普通课程测试的最后一个 MARS 运行时依赖。

**落地记录**：核心位于 `src/mips/core/assembler`（14 文件），provider 位于
`src/mips/providers/builtinAssemblerProvider.ts`；`assembler.assemble` 进入
版本化 JSONL CLI 与 Worker。assembly-diff lane 用固定 MARS v0.6.3 对 manifest
全部 10 个 corpus 用例直接比较 text/ktext/data image，0 unexplained diff；
错误程序不产出 image；include cycle/限额、宏递归/局部标签、段重叠/容量、
CRLF/BOM 与中文路径均由 provider 的 source graph capture 或核心诊断覆盖。

工作：

- source/include graph、`.eqv`、macro、严格 parser。
- section/layout/symbol/relocation、source map 和 expansion stack。
- `.text/.ktext/.data`、课程必要 data directives、当前生成器需要的 pseudo。
- 第一子阶段只覆盖内置生成器/模板；第二子阶段覆盖常见手写课程 ASM。
- 内置 assembler 通过 assembly differential 后，与 TS executor 组成 full-stack lane 加入常规 CI。

退出标准：

- TS assembler 与 pinned MARS assembler 的 text/kernel/data image 对声明支持语料逐字节一致；课程有意差异带 contract ID 并进入 divergence ledger。该直接 image differential 是必需门槛，不依赖 stock MARS 加载 TS image。
- 错误程序不生成可执行 image；诊断有稳定 code 和准确 source/macro origin。
- 中文/空格路径、CRLF/BOM、include cycle、宏递归/膨胀上限、segment 容量全部测试。
- TS/TS 运行时事件能通过 `ProgramImage.sourceMap` 映射回准确 source/macro origin。
- assembly differential、execution differential 和 TS/TS full-stack 三条 lane 在两平台 CI 可运行；patched MARS raw-image runner 仅为可选增强。

### 阶段 6：默认切换与清理

**目标**：在证据充分的前提下，按 profile 逐项把课程默认 oracle 切换到 TS，并保留即时回滚。
取代初版“30 天 / 10,000 去重 case / 500 手写 graph”的 quota：这些数字无法由单人环境
可持续地产生，放宽后的门槛保留其意图（不盲目切换），不设配额。

工作：

- 完成阶段 4/5 的 shadow 接入，把 executor-only 与 full-stack 证据分开记录。
- 按 profile/capability 分项切换默认；只有对应项满足退出标准后才从 capability 的普通
  requiredTools 中移除 MARS/Java。
- MARS bug repair 退出生产 TS 路径，只保留在 legacy normalizer/conformance。
- 提供显式“使用固定 MARS 验证”开发者命令和回滚开关。

退出标准（每项按 profile 独立判定）：

- 对应 profile 的全部 directed 测试、RTL 决策向量、courseVector、ISA golden、TS-CLI
  在两平台 CI 全绿。
- TS executor 对 pinned MARS 在 250-seed 语料与手写语料上的 execution differential
  为 0 unexplained diff（assembler 切换项另加 assembly differential）；每个已解释
  差异有稳定 contract ID 并进入 divergence ledger。
- shadow 期间没有未解释 mismatch；每次 mismatch 保存 bundle 并按 mars-compatible /
  course-correct / inconclusive 裁决，inconclusive 阻断该项切换。
- 回滚开关一次设置即恢复 legacy，且同一 case bundle 可在两端复现。
- MARS 作为 CI reference 永久保留。

### 阶段 7：P2 与常见 MARS 用户体验

**目标**：覆盖常见手写汇编和确定性 console 程序，而不是完整复刻 MARS IDE。

工作：

- 常用 data directives、include、macro/pseudo 扩展。
- stdin/stdout syscall host；文件/时间/随机等通过显式 capability 注入，默认关闭或确定化。
- LSP 在 save/显式命令上接入真实 assembler diagnostics。
- 现有 `RunInTerminal` 在 session console RPC 完成前明确保持 `legacy-only`，provider resolver 不得把它静默切到一次性 Worker request。
- 若迁移交互命令，使用版本化 console session RPC（stdin chunk/stdout/stderr/EOF/cancel/exit code）和 VS Code `Pseudoterminal`；交互能力单独过兼容、背压和取消测试。

退出标准：

- 教程、模板和真实 P2 corpus 达到声明兼容范围。
- 常用 stdin/stdout 与固定 MARS 一致或存在明确 contract difference。
- `RunInTerminal` 要么仍显式提示使用 legacy，要么 builtin Pseudoterminal 已达到同等交互能力；不存在无提示功能回退。
- 未支持的浮点/GUI/文件 syscall 给出精确诊断，不崩溃、不静默误执行。

### 阶段依赖、并行和难度

阶段编号表示产品 gate，不要求所有编码严格串行。关键依赖为：

```text
阶段 0 -> 阶段 1 -> 阶段 2 -> 阶段 3 -> 阶段 4（executor shadow）
                    \-> 阶段 5 的 parser/layout 可并行
阶段 4 + 阶段 5 -> full-stack shadow -> 阶段 6
阶段 5 -> 阶段 7
```

下面的“切片数”不是人工人日，而是适合独立实现、验证并形成 Conventional Commit 的语义工作单元；每个切片必须同时包含实现、directed/property/differential test 和文档/contract 变化：

| 阶段 | 相对难度 | 预估语义切片 | 主导风险 |
| --- | --- | --- | --- |
| 0 | 高（推理/证据） | 4–7 | 错误规范和不可重现 oracle 会污染所有后续工作 |
| 1 | 中高 | 5–9 | schema 兼容、provider 边界、重复 ISA 表收敛 |
| 2 | 高 | 8–14 | delay/HI-LO/访存边界和 JS 32/64 位语义 |
| 3 | 极高 | 10–18 | 精确异常、Timer 时间域、allowed-state 判断 |
| 4 | 高 | 6–10 | 取消/Worker/artifact、真实 pipeline 回归 |
| 5 | 极高 | 12–22 | macro/layout/relocation/pseudo 与 source provenance |
| 6 | 编码中等、验证等待高 | 3–6 + shadow 窗口 | 证据污染、过早切换、跨平台发布 |
| 7 | 高且可后置 | 8–15 | syscall/交互状态机和安全 capability |

AI 辅助会显著降低重复 handler、schema adapter、语料生成和 reducer 的编码成本，但不能降低
规范裁决、独立 expected value 与 shadow 判读的最低证据成本。因此总难度仍为高；关键路径
是阶段 0、3、5，不是 TypeScript 行数。

## 7. 测试与正确性保证

### 7.1 固定 reference 与独立验证 lane

Stock MARS CLI 会重新汇编 ASM，不能直接加载任意 TS `ProgramImage`；因此默认方案不声称拥有不可实现的“四象限”。必需验证 lane 为：

| Lane | 数据路径 | 目的 |
| --- | --- | --- |
| legacy baseline | pinned MARS ASM → pinned MARS image/execution | 固定迁移基线 |
| assembly differential | 同一 SourceUnit graph → MARS image 与 TS image 逐 segment 比较 | 隔离 TS assembler 错误 |
| execution differential | frozen/handcrafted ProgramImage → TS；MARS 对照仅接受“其 dump fingerprint 与 frozen image 相同”的 case | 隔离 TS executor 错误 |
| full stack | TS assembler → TS executor | 最终用户路径和 source-map/replay |
| course vector | 教程契约/人工 expected，或官方 Timer/PDF/TB cycle vector | 覆盖 MARS 不权威、未定义或时间域不同的行为 |

只有在确有收益时才增加 test-only Java raw-image loader，形成 `TS image → patched MARS executor` 的可选第四执行组合；它必须能加载 text/kernel/data、设置显式初态、导出 canonical transitions，并用完整 frozen/regression corpus 证明 patch 未改变执行语义。它不是阶段 5 或默认切换的前置条件。

Course vector 适用于 P3–P7，不只用于 P7。发生冲突时按第 3.1 节和 contract ID 裁决。

Conformance harness 是独立 package/process，禁止 import 生产 assembler、decoder、simulator、ISA catalog、normalizer、机器可读 `course-contract` 派生物或生成器 `CpuState`。它在独立 workspace/build job 中按依赖白名单运行；CI 还要检查其 corpus、renderer、decoder 和 expected-value 生成链不读取/复制 `resources/mips/isa.json`、生产 contract/mask/policy 或 generated 路径。允许共享的只有不携带 expected-value 语义的 JSON schema/IPC types。TS 引擎只通过版本化 JSONL/CLI 暴露测试接口；encode/decode expected 必须是独立冻结数据，并记录 MARS dump 或课程条款 provenance。

所有 critical semantic mutants 必须至少被这套独立 conformance/`courseVector` suite 杀死；只被读取共享 catalog/contract 的生产单元测试杀死，不计入 critical gate。

### 7.2 `marsGolden` 与 `courseVector`

两类 expected data 物理隔离，使用不同目录、schema 与更新命令：

- `marsGolden`：由第 3.5 节固定 MARS 资产生成，只证明 mars-compatible/迁移行为。
- `courseVector`：由教程条款、官方设备规范/Verilog/TB 或人工审阅的数学 expected
  构造，定义 course-correct 行为；MARS 命令永远不能重写它。

两者按适用项保存；不适用项必须显式省略或标记，而不是填入虚假默认值：

- source/include hashes、ASM 和 raw image
- provenance：MARS tag/commit/JAR hash/runner patch hash/Java/CLI options，或 course contract/vector generator revision
- raw stdout/stderr/dumps
- normalized canonical transitions
- final state digest、checkpoint/digest，以及参与 digest 的 defined/observable mask
- profile/contract/catalog/normalizer schema revision
- stdin、interrupt/cycle schedule、stop condition、step limit

32 位值使用固定 8 位 hex 字符串，避免 JS signed/unsigned 展示差异。每步保存 delta，每 256 步保存 GPR/HI/LO/CP0 checkpoint；DM 保存初始 hash、稀疏写和周期 digest。digest 排除 undefined/unobservable 字段，并记录 mask revision。

普通测试不得自动更新 snapshot。expected data 的更新流程是：regenerate →
`--refresh-integrity`（强制 candidate 形态，任何内嵌 approval 声明都会被降级）→
在 diff 中审阅 raw 与 normalized 变化 → 正常提交。没有单独批准步骤；payload hash
与 CI 检查就是证据。

### 7.3 语料分层

1. **规范微程序**：每个 profile、每条指令的正常、边界、异常/拒绝向量。
2. **汇编布局**：标签、宏、`.eqv`、pseudo、expression、section/data directives、多文件、BOM/CRLF/中文路径。
3. **教程/真实语料**：教程 ASM、插件模板、MARS regression、经许可匿名化的学生工程。
4. **编码/状态边界**：`0/1/-1`、`0x7fff/0x8000/0xffff`、32 位极值、`$0`、首尾地址、前/后/自分支。
5. **独立 IR fuzz**：独立 manifest/renderer 生成 ASM 和 raw image，不读取生产 catalog。
6. **非法与 undefined**：区分课程应拒绝、MARS-only、course-correct divergence 和架构未定义。
7. **历史 challenge corpus**：`$gp/$sp` 初态、4095/4096 word、SWL/SWR、REGIMM link、异常 victim 缺 header、HI/LO 未定义和 MARS-only 地址段。

每个 fuzz failure 自动执行行、寄存器、立即数和控制流感知 shrink；最小复现、原 seed、双方 raw/canonical trace 固化为 regression。

### 7.4 属性与变形测试

汇编器：

- 空白、注释、大小写、LF/CRLF/BOM 不改变 image。
- 寄存器名称/编号别名和等值数字表达等价。
- label/macro 参数 alpha-renaming 等价。
- pseudo 与固定 MARS 展开逐 word 一致。
- 对齐平移后 PC-relative 行为保持一致。
- 未使用 label/`.eqv` 不改变 image。

执行器：

- `$0` 永远为零。
- sign/zero extension、signed/unsigned compare 满足数学关系。
- 对齐 store→load 恢复原值；byte/half/partial word 只改变目标 lane。
- delay slot 恰好一次，link 正确，`eret` 无 delay slot。
- 异常 victim 无非法提交；Cause.BD/EPC/EXL/优先级符合契约。
- CP0 mask、MMIO width、COUNT 只读、IRQ ack 和 Timer write-priority 正确。

Metamorphic 程序可做安全寄存器重命名、插入不相关指令/NOP、无依赖重排、DM 工作区平移、taken/not-taken 对偶、异常普通位置/延迟槽对偶。涉及 link PC、MMIO、Timer 和精确 IRQ window 时必须使用专门关系，禁止盲目变形。

### 7.5 Mutation testing

以下 critical mutants 是 directed 测试的固定检查单；每条都必须被独立 conformance/
courseVector 杀死，而不是只被读取共享 catalog 的生产单元测试杀死：

- branch base 使用 `PC` 而非 `PC+4`
- link 写 `PC+4` 而非 `PC+8`
- `eret` 错误带延迟槽
- sign/zero extension 互换
- endian/byte mask 反向
- `$0` 可写
- signed overflow 边界差一
- BD/EPC 差 4
- CP0 mask 错一位
- exception/interrupt priority 互换
- Timer COUNT 可写或到零差一周期
- 异常 store 仍写 DM/Timer
- pseudo 在 `0x7fff/0x8000` 选择错误展开

初版的分模块百分比门槛（assembler ≥90%、machine ≥95%、总体 ≥90% 等）已撤销：单人
维护下 mutant 作为 directed 测试存在并留在测试套件里即可，不另设 quota 与 ADR 审批；
等价 mutant 按稳定 ID 记录理由。

### 7.6 CI 层级

初版的 L0–L4 与 evidence 规模门槛（每 profile ≥10 万图、≥1 亿 transition）已撤销；
单人环境无法可持续地产生并裁决那种规模的证据。实际层级：

| 层级 | 触发 | 内容 |
| --- | --- | --- |
| push | 每次 push 到 main | `CI`：模块边界、dependency whitelist、contract/evidence gates、RTL 决策向量（Icarus）、ISA/course 候选校验、corpus freeze、compile、reference、regression、250 seeds、conformance 测试与 lanes、完整 vitest、test-cli smoke |
| push | 每次 push 到 main | `Phase 1 portability`：windows-2025 与 ubuntu-24.04 双平台完整套件（generated 检查、compile、全测试、CLI、Worker、process supervisor、MARS replay、新旧 legacy 等价） |
| benchmark | 手动 dispatch | 固定双 runner 的 benchmark candidate 与校验上传 |
| release | 手动 | 发布矩阵（三平台、空格/中文/BOM/换行） |

需要更高覆盖时，用 nightly dispatch 增大固定 seed 数并把结果固化为 regression，
而不是设配额。

### 7.7 Shadow 与默认切换

证据按 profile/capability 分开记录，executor-only 与 full-stack 不互相继承。切换判据
见第 6 节阶段 6 的退出标准：两平台 directed 测试全绿、对应 differential 为 0
unexplained diff、shadow 无未裁决 mismatch、回滚即时可用。不再要求固定天数、固定
case 数或固定手写语料数；这些是意图的量化表达，单人环境用"每个 mismatch 都有 bundle
且被裁决"来保留同一意图。

### 7.8 Expected data 与差异治理

- expected data 的物理隔离与更新流程见第 7.2 节；approval envelope 机制已撤销，
  历史信封归档仅作 provenance。
- 有意差异记入 `conformance/mips/contract/divergences.json`（稳定 ID、course/MARS
  两种行为、规范依据、directed 向量），不再使用 waiver/envelope 数据结构。
- 修改 expected data 的提交必须在信息里说明期望值来源（教程条款、官方 Verilog/TB、
  固定 MARS run URL 或手工推导过程）；来源缺失的期望变更一律视为 unexplained diff。
- `out-of-domain` 由 capability/contract scope 在 preflight 或 case 分类阶段决定，
  不是 waiver 类别；落在已声明 capability 内却被标为 out-of-domain 必须算失败。

## 8. 性能、可靠性与安全

### 8.1 性能基线

benchmark 作为手动工具保留：在固定双 runner（GitHub Actions `windows-2025` 与
`ubuntu-24.04`）上 dispatch `run_fixed_benchmark` 采集 candidate，用
`validate-fixed-benchmark.mjs` 校验后替换 baseline 并记录 run URL。

初版的绝对 CI gate 改为参考目标（ADR-0001 记录）：首次 Worker + 10-word assemble
p95 ≤500ms、warm 1,000-word assemble ≤100ms、4,096-word ≤300ms、1M-step trace-off
execute ≤2s、activation 新增 p95 ≤10ms、full trace 必须流式。观察到 p95 相对上一份
baseline 回退超过 15% 时人工调查，不在 CI 自动 fail。

### 8.2 资源与输入限制

- 限制 include 深度/总字节、macro 深度/展开数量、生成指令数、segment 大小、执行步数、trace 字节和 checkpoint 数。
- `.include` 由 worker preprocessor 发现，host `SourceBroker` 仅通过受限反向 RPC 解析路径并读取；core 不直接访问文件系统。
- 未信任工作区禁止执行、include 越界和任意 syscall host。
- P2 文件/时间/随机 syscall 必须显式授权并可确定化；课程 oracle 默认无宿主副作用。
- Worker crash 当前任务明确 `ERROR`；只对无外部副作用的纯任务允许自动重试一次。
- case/golden/artifact 使用内容 hash 和原子写入。

## 9. 迁移、兼容与回滚

- Provider 选择早期只作为内部/开发配置；稳定 shadow 后再公开 `auto | builtin | mars | verify-both`。
- `auto` 按 request 的 profile/capability gate 解析：未过 gate 的能力使用 legacy，已过 gate 的能力使用 builtin；显式选择永不被升级静默改写。
- v1 manifest/report 永久可读，新写 v2；不自动批量重写历史 case。
- legacy MARS 的 `$gp/$sp`、REGIMM、coL2 victim、Compact 上界修复全部保留在 reference adapter，不能污染 course profile。
- 若 builtin 发现未支持 assembler feature，应给精确 capability diagnostic；是否允许显式 fallback 由命令语义决定，课程裁决不可无提示改变 oracle。
- 默认切换前完成回滚演练：一项设置可恢复 legacy provider，且同一 case bundle 可在两端复现。
- `resources/co/courseConfig.json` 的 `requiredTools` 应按 capability 迁移；只有 builtin assembler+executor 达到 release gate 后才移除 MARS/Java 要求。

## 10. 许可与来源

MARS 及当前课程 fork 使用 MIT，允许修改和派生，但逐行转写或明显派生的 TS 文件仍应保留：

- Pete Sanderson / Kenneth Vollmar
- BUAA CO Lab course team
- fork 修改作者/贡献者

建议新核心主要根据课程契约重新实现，针对伪指令/边缘兼容选择性参考 MARS；在 `THIRD_PARTY_NOTICES` 和相关文件头注明来源。Timer 更应依据官方规范/Verilog和黑盒向量重新实现，而不是翻译带反编译来源的 Java 类。

固定 MARS JAR、test-only tap、源码、补丁、构建脚本、hash 和许可证材料作为开发/CI artifact 一起归档。

课程 tutorial、PDF、官方 Verilog/TB 和学生工程不自动继承 MARS 的 MIT 许可。发布插件或公开 conformance corpus 前应分别确认再分发权限；无法确认时只保存来源引用、contract ID 和自行编写的最小向量，不把原文件打进扩展。真实学生工程必须取得许可并去标识化，且不得作为公开 telemetry 上传。

## 11. 主要风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 机械转写 Globals/Singleton | 不可重入、难并行、GUI 耦合继续存在 | 纯实例化 state/session；provider/worker 隔离 |
| 实现与测试共享同一错误表 | 大量测试自洽但错误 | 独立 harness/IR generator、固定 references/course vectors、mutation |
| 把 MARS bug 当课程规范 | P7 错误 oracle | course/mars profile 分离、normative ledger |
| JS signed/64-bit 错误 | 边界静默错误 | u32/s32 helper、BigInt、边界笛卡尔积 |
| P7 Timer/IRQ 时间混淆 | 错误周期对拍或误报 | instruction/cycle 分离；规范 probe/偏序，不对拍 MARS 周期 |
| 事件流过大 | extension host OOM/卡顿 | Worker、batch/backpressure、bounded retain/artifact spool |
| LSP 与严格 assembler 互相拖累 | 输入延迟和不完整代码崩溃 | 共享纯 lexer/catalog；独立 tolerant/strict pipeline |
| 过早移除 MARS | 无法仲裁历史差异 | CI 永久 pin；shadow；两课程周期 fallback |
| scope 膨胀到完整 MARS | 长期无法切换 | required/commonExtensions/marsCompatibility 分层；明确非目标 |

## 12. AI 辅助开发约束

工作单位按“可独立证明的语义切片”而不是大文件/总行数组织：

1. 一次任务只迁移一个结构事实或一个指令族，并同时交付 directed、property 和
   differential tests；expected 值必须独立推导（教程/官方 Verilog/手工计算），
   不能从生产实现反向录制。
2. 每次 unexplained mismatch 先缩减复现并加入 regression，再修改实现；禁止用宽泛
   normalizer“修绿”。
3. 不让多个并行工作分别维护重复 opcode/语义表；先收敛唯一 catalog，再并行实现
   handler/语料。Conformance 的 expected 生成链必须保持独立，不得复制生产 catalog。
4. expected data 的变化在提交信息里说明期望值来源（教程条款、官方 Verilog/TB、
   固定 MARS run URL 或手工推导过程）。
5. 每个阶段用 Conventional Commit 分割，例如：

   - `feat(mips-core): add delayed branch and p6 memory semantics`
   - `feat(mips-core): implement p7 cp0 and exception policy`
   - `feat(course-testing): enable builtin oracle shadow mode`
   - `feat(mips-core): add course assembler`

## 13. Definition of Done

本计划完成不是指“TS 能跑几个 ASM”，而是同时满足：

- 架构：核心纯净、实例化、provider-neutral、worker 隔离，MARS quirks 不进入 course profile。
- 功能：声明支持的 P3–P7 ASM 能生成完整 4096-word 范围内的 image，并由 TS oracle 执行。
- 规范：P3–P7 contract 可追踪到教程/官方资源；所有有意差异有稳定 ID。
- 正确性：directed 测试、规范向量与两平台 CI 全绿；execution/assembly differential
  为 0 unexplained diff。
- 可诊断性：失败 bundle 可离线重放，第一处差异能映射回源代码和架构状态。
- 性能：lazy activation、取消与内存行为不退化；benchmark 可复测，ADR 目标可对照。
- 迁移：历史 case/report 可读，用户可回滚到固定 reference provider。
- 发布：普通 P3–P7 MIPS 工作流不再要求 MARS；MARS 作为 CI/reference 被永久固定和可重建。

## 14. 首个实施批次（已完成）

初版第一个编码批次（provider contracts、manifest v2 codec、reference manifest、
conformance CLI skeleton、module-boundary check、P3 8 条指令的 catalog 端到端）与随后
的阶段 0–3 均已落地，见第 0 节。本节保留作为历史记录。

## 15. 参考资料

仓库：

- [项目索引](../../docs/INDEX.md)
- [课程测试模块](../../docs/modules/course-testing.md)
- [MIPS LSP 模块](../../docs/modules/mips-lsp.md)
- [测试套件](../../docs/modules/test-suite.md)
- [当前 MARS 入口](../../src/mips.ts)
- [当前课程单 case runner](../../src/courseTesting/traceRunner.ts)
- [当前 case schema](../../src/asmCaseStoreCore.ts)
- [P7 硬件资源](../../resources/co/p7Hardware.json)

教程：

- [P3 整体结构](../../../cscore/markdown/P3/P3-1.md)、[P3 模块规格](../../../cscore/markdown/P3/P3-2.md)
- [P4 设计](../../../cscore/markdown/P4/P4-1.md)、[P4 在线测试](../../../cscore/markdown/P4/P4-7.md)
- [P5 流水线要求](../../../cscore/markdown/P5/project/P5-5-1.md)、[P5 在线测试](../../../cscore/markdown/P5/project/P5-5-2.md)、[P5 测试限制](../../../cscore/markdown/P5/testcases/P5-4-5.md)
- [P6 设计要求](../../../cscore/markdown/P6/P6-1.md)、[P6 外置接口](../../../cscore/markdown/P6/P6-6.md)
- [P7 外设/地址空间](../../../cscore/markdown/P7/implement/P7-2-2.md)、[P7 CP0/异常](../../../cscore/markdown/P7/implement/P7-2-3.md)、[P7 精确异常](../../../cscore/markdown/P7/implement/P7-2-4.md)、[P7 handler 示例](../../../cscore/markdown/P7/implement/P7-2-5.md)、[P7 提交要求](../../../cscore/markdown/P7/implement/P7-2-6.md)
- [官方 Timer](../../../cscore/markdown/assets/cscore-assets/P7_standard_timer_2019.v)、[Timer 规范](../../../cscore/markdown/assets/cscore-assets/COCO定时器设计规范-1.0.0.4.pdf)

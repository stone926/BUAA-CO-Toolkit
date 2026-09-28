# mips-core | src/mips/core/ | 41 files

纯 TypeScript MIPS 引擎核心：ISA 编解码、两遍课程汇编器、架构执行器与设备模型。**零** VS Code / LSP / 文件系统 / Worker 依赖（边界由 `scripts/check-module-boundaries.mjs` 检查）。汇编器与执行器通过不可变 `ProgramImage` 连接，因此可各自独立验证。

## 数据契约

- `api.ts` — SourceUnit / ProgramImage / EngineDescriptor / EngineCapabilities 等核心类型
- `values.ts` — 32/64 位值边界与固定宽度 hex 格式化
- `canonicalJson.ts` — canonical JSON（core fingerprint 与 replay digest 共用同一字节定义）
- `digest.ts` — 纯 TS SHA-256（禁止依赖 node:crypto，由 test 交叉验证）
- `programImage.ts` — ProgramImage canonical 载荷与内容 fingerprint
- `generated/isaCatalog.ts` — 由 `scripts/generate-mips-isa.mjs` 从 `resources/mips/isa.json` 生成（勿手改）；同一命令还生成 LSP facts 与 generatorProfiles

## ISA 与 Profile

- `isa/decoder.ts` — 基于生成 catalog 的机器码解码（runtime candidate group / REGIMM-COP0 精确分派 / 课程 canonical）；预筛 Profile/layer 表并缓存解码结果，全部作用域合计最多 65,536 项，runtime 结果与候选数组冻结
- `isa/encoder.ts` — 真实指令编码；拒绝未用操作数、非 canonical 保留字段与课程外 CP0 rd
- `isa/service.ts` — CLI/Worker 共用的无宿主 encode/decode DTO
- `profiles/profile.ts` — CourseExecutionProfile 契约：地址空间、延迟槽/link、溢出、CP0/异常、trace 投影、停机策略
- `profiles/courseProfiles.ts` — 冻结的 P3–P7 profile 数据（DM 0..0x2fff、IM 0x3000..0x6fff、handler 0x4180、Timer/IG 地址、CP0 位域）
- `profiles/profileIds.ts` — 从生成 catalog 的 profilePolicies 键导出核心使用的 P3–P7 列表

## 汇编器（两遍）

- `assembler/assembler.ts` — 编排：`.eqv` token substitution → layout/symbol/relocation → 伪指令展开 → ProgramImage
- `assembler/assemblyService.ts` — CLI/Worker 共用的有界 assembler DTO（显式 include 边，不解释文件路径）
- `assembler/sourceGraph.ts` — BOM/CRLF 归一化、递归 `.include` 展开、fingerprint 与深度/大小限额
- `assembler/syntax.ts` — 注释/字符串感知行语法、标签与顶层逗号操作数拆分
- `assembler/work.ts` — 两遍之间的 WorkInstruction/WorkOperand 中间表示
- `assembler/expression.ts` — MARS 风格有符号 32 位常量表达式与稳定 undefined-symbol 分类
- `assembler/macros.ts` — `.macro` 形参替换、宏内标签去重、递归/总膨胀限额
- `assembler/pseudo.ts` — 课程常用伪指令展开；内建能力以 handler 注册表为准
- `assembler/sections.ts` — text/ktext/data 段布局、空洞、容量/重叠检查、MARS 4 KiB 数据块 padding
- `assembler/operands.ts` — `off($base)` 内存形式与寄存器/立即数分类
- `assembler/literals.ts` — dec/hex/bin/oct 与字符/字符串字面量
- `assembler/instructionForms.ts` — 操作数模式辅助（encoder、pseudo 校验、波形反汇编共享）
- `assembler/registers.ts` — 架构寄存器事实（与 `resources/mips/registers.json` 同源）
- `assembler/diagnostics.ts` — 稳定诊断码与 offset-based SourceSpan
- `assembler/artifacts.ts` — ProgramImage → 课程 HexText/kernel dump 与停机 PC 检测；非 data 段按绝对地址投影到 4096-word IM

## 事件与执行

- `events/commitEvent.ts` — canonical CommitEvent 事件模型、TrapRecord 与 out-of-domain 分类
- `events/traceProjection.ts` — CommitEvent → 课程 GRF/DM 架构写 trace 投影
- `events/coverage.ts` — 生产侧覆盖率分箱（指令、分支、字节车道、异常/中断/设备）
- `machine/state.ts` — GPR/PC/HI/LO 与 CP0（掩码、EXL、中断资格、enterTrap/exitTrap）
- `machine/memoryBus.ts` — 小端 memory bus：region、对齐/越界/宽度检查、字节车道合并、设备事务路由
- `machine/semantics.ts` — 每条指令的纯语义（含 lwl/lwr/swl/swr 部分字）
- `machine/transition.ts` — 取指/译码/求值 → InstructionEffect，按 F>D>E>M 返回最早异常
- `machine/session.ts` — 原子提交、异常/中断仲裁、停机检测、步数预算、状态快照
- `machine/system.ts` — 架构 step 与显式设备周期推进的组合；不提供"每指令 tick"伪时间
- `machine/execution.ts` — 有界执行驱动：slice/yield、结构化取消、checkpoint、流式事件
- `machine/executeService.ts` — CLI/Worker 共用的执行与设备周期向量 DTO，支持流式 progress/ACK

## 设备

- `devices/timer.ts` — 官方 P7 计时器 CycleContract（依据 `P7_standard_timer_2019.v`）
- `devices/interruptController.ts` — 中断发生器（受害 PC、发生计划、`store 0x7f20` 应答）与 HWInt 聚合
- `devices/deviceBus.ts` — DeviceBusPort：MMIO prepare/read/commit/abort 与显式 `tickDevices`

## 核心设计决策

**时间域分离。** 架构 `MachineSession` 与周期级 `DeviceSession` 严格分离：`prepare/read/commit/abort` 都不推进 Timer，只有显式 `tickDevices` 或 case 提供的 `deviceTimeline` 才推进周期。缺少 cycle schedule 的 Timer 事务判为 out-of-domain，而不是 AdEL/AdES——教程没有定义流水线 commit 与 Timer 时钟的映射。

**可比较域 fail closed。** `OutOfDomainReason` 覆盖课程规定输入：未加载指令字、未识别指令、除零、jalr 双寄存器相同、延迟槽内跳转、未定义 HI/LO 读取、Timer Mode 2/3 等。strict lane 一律 fail closed；`synthetic-zero` / `deterministic` 只是显式 exploratory policy，结果不得作为 strict golden。

**证据分层。** 核心 full-stack 回归直接覆盖 P3–P7 的 ProgramImage 与最终状态；独立 assembly-diff 另通过 JSONL CLI 与固定 MARS 对比 text、P7 ktext 与 data 段。P3–P7 的课程 `auto` 以 builtin assembler/executor 为默认，但核心本身不读设置、不选 provider——宿主用一次性 `CourseEnginePlan` 负责（见 mips-providers.md）。

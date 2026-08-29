# mips-core | src/mips/core/ | 41 files

纯 TypeScript MIPS 引擎核心。无 VS Code/LSP/文件系统/Worker 依赖；模块边界由 scripts/check-module-boundaries.mjs 检查。汇编器（阶段 5）与执行器（阶段 2/3）通过不可变 ProgramImage 连接，二者可独立验证。

- api.ts — 核心数据契约：SourceUnit、ProgramImage、EngineDescriptor、EngineCapabilities、指令分层
- values.ts — 32/64 位值边界 helper（u32/s32/signExtend16/乘除 64 位/溢出标志）与固定宽度 hex 格式化
- canonicalJson.ts — canonical JSON（递归键排序、数组保序）；core fingerprint 与 replay digest 共用同一字节序列定义
- digest.ts — 纯 TS SHA-256 与 UTF-8 编码；模块边界禁止 core 依赖 node:crypto，由 test 对照 node crypto 交叉验证
- programImage.ts — ProgramImage canonical 载荷、内容 fingerprint 与执行器输入构造；replay 层复用同一载荷
- generated/isaCatalog.ts — 由 scripts/generate-mips-isa.mjs 从唯一源 resources/mips/isa.json 生成（勿手改）；同一命令也生成 LSP facts 与 generatorProfiles，`--check` 对三者 fail closed
- isa/decoder.ts — 基于生成 catalog、profile 与 layer scope 的三层机器码解码（runtime RI candidate group / REGIMM-COP0 exact dispatch / 课程 canonical）
- isa/encoder.ts — 基于生成 catalog 的真实指令编码；拒绝未使用 operand、非 canonical 保留字段和课程外 CP0 rd
- isa/service.ts — CLI/Worker 共用的无宿主 encode/decode 服务 DTO；固定字宽输出且不泄露 generated entry 对象
- assembler/diagnostics.ts — 严格汇编器稳定诊断码与 offset-based SourceSpan/expansion origin
- assembler/sourceGraph.ts — BOM/CRLF 归一化、递归 `.include` 展开、source graph fingerprint 与 depth/unit/byte 限额；source span 仍使用原始文本的 UTF-16 offset，并保留完整嵌套 include origin
- assembler/syntax.ts — 注释/字符串感知行语法、标签与顶层逗号操作数拆分
- assembler/literals.ts — 整数/字符/字符串字面量解析（dec/hex/bin/oct、转义）
- assembler/expression.ts — MARS 风格有符号 32 位归一化的常量表达式、符号解析回调与稳定 undefined-symbol 分类；移位运算同级且左结合
- assembler/macros.ts — `.macro` 定义、形参替换、宏内标签 `_M#` 去重、递归/总膨胀限额与嵌套展开栈
- assembler/pseudo.ts — 课程常用 pseudo 展开（li/la/move/b/blt/... 与便捷访存寻址）；最终真实指令仍统一经过 catalog profile/layer 校验
- assembler/sections.ts — text/ktext/data 绝对光标、前向空洞、容量/重叠检查、小端字节车道与 MARS 4 KiB 数据块 padding
- assembler/instructionForms.ts — 指令形式的操作数模式/参数化辅助（encoder 与 pseudo 校验共享）
- assembler/operands.ts — 操作数解析：`off($base)` 内存形式、寄存器/$0/立即数分类与括号配对
- assembler/registers.ts — 架构寄存器名称/编号事实（与 resources/mips/registers.json 同源，勿手改）
- assembler/work.ts — 两遍汇编的中间 WorkInstruction/WorkOperand 表示——text/data 指令统一为可编码/编码前居中的对象
- assembler/assembler.ts — 两遍汇编：MARS 风格递归 `.eqv` token substitution、layout/symbol/relocation、伪指令展开、ProgramImage 生成；任一诊断存在时不返回 image
- assembler/assemblyService.ts — CLI/Worker 共用的有界 assembler DTO；显式 include 边，不解释文件路径
- assembler/artifacts.ts — ProgramImage 到课程 HexText/kernel dump 与停机 PC 检测
- assembler/sourceMap.ts — CommitEvent/PC/访存地址到 source/macro origin 的查询；include、嵌套 macro 与 pseudo 生成的每个真实 word 都保留 expansion stack
- profiles/profile.ts — CourseExecutionProfile 契约：地址空间、延迟槽/link、溢出策略、CP0/异常策略、trace 投影与停机策略
- profiles/courseProfiles.ts — 冻结的 P3–P7 profile 数据（DM 0..0x2fff、IM 0x3000..0x6fff、handler 0x4180、Timer/IG 地址、CP0 位域）
- events/commitEvent.ts — canonical CommitEvent 事件模型、defined/observable 标记、TrapRecord、out-of-domain 分类与稳定诊断码
- events/traceProjection.ts — CommitEvent 到课程 GRF/DM 架构写 trace 的投影；oracle 永不伪造 `$time` 周期前缀
- events/coverage.ts — 生产侧覆盖率分箱（指令、分支双向、字节车道、地址边界、异常/中断/设备场景）
- machine/state.ts — 架构状态：GPR/PC/HI/LO 与 CP0（SR/Cause/EPC 掩码、EXL、中断资格谓词、enterTrap/exitTrap）
- machine/memoryBus.ts — 小端 memory bus：region 分类、对齐/越界/宽度检查、字节车道合并与设备事务路由
- machine/semantics.ts — 纯算术/比较/移位/乘除与 lwl/lwr/swl/swr 部分字语义；每条指令独立实现，不共享通用表达式
- machine/transition.ts — 取指/译码/求值到 InstructionEffect；按 F>D>E>M 返回最早异常，或把 fault 分类为可比较域之外
- machine/session.ts — MachineSession：原子提交、异常/中断仲裁、停机检测、步数预算与 canonical 状态快照/摘要
- machine/system.ts — CourseSystemSession：组合架构 step 与显式设备周期推进；不提供"每指令 tick"伪时间映射
- machine/execution.ts — 有界执行驱动：slice/yield、结构化取消、checkpoint、流式事件与 trace/覆盖率收集
- machine/executeService.ts — CLI/Worker 共用的执行与设备周期向量服务 DTO（固定字宽输出、显式上限）；阶段 4 增加异步 worker 驱动：按 slice 流式 CommitEvent 并支持 ACK/取消
- devices/timer.ts — 官方 P7 计时器 CycleContract（依据 P7_standard_timer_2019.v：WE 抑制状态机、IRQ = ctrl[3] & _IRQ）
- devices/interruptController.ts — 中断发生器（宏观 victim PC + occurrence 计划、store 0x7f20 应答）与 HWInt 聚合
- devices/deviceBus.ts — DeviceBusPort：MMIO prepare/read/commit/abort 与显式 tickDevices；COUNT 只读在设备提交前抑制

## 时间域边界

架构 `MachineSession` 与周期级 `DeviceSession` 严格分离：`prepare/read/commit/abort` 都不推进 Timer，只有显式 `tickDevices` 或 case 提供的 `deviceTimeline` 才推进周期。缺少 cycle schedule 的 Timer 事务被判为 `device-schedule-missing` 的 out-of-domain，而不是架构 AdEL/AdES——教程没有定义流水线 commit 与 Timer 时钟的映射，那属于真实 DUT 的 scenario property。

## 可比较域

`OutOfDomainReason` 覆盖 COURSE-P56-DOMAIN-001 与 COURSE-P7-UNLOADED-IM-001 规定的输入：未加载指令字、未识别指令、除零、jalr 双寄存器相同、延迟槽内跳转、未定义 HI/LO 读取、Timer Mode 2/3 等。strict lane 一律 fail closed；`synthetic-zero` 与 `deterministic` 只作为显式 exploratory policy，结果不得成为 strict golden。

## 阶段 5 验证边界

核心 full-stack 回归直接覆盖 P3–P7 的 ProgramImage 与最终状态，并有一条 include + macro + `.eqv` + pseudo + data 用例用真实 executor CommitEvent 验证 sourceMap provenance。独立 assembly-diff 另通过 JSONL CLI 与固定 MARS 对当前 10 个单源 corpus 比较 text、P7 ktext 和 data 段；这些 corpus 当前只含直接指令、data 均为空，因而该 lane 不单独证明 include/macro/`.eqv`/pseudo 或非空 data，相关能力由核心/provider 回归覆盖。

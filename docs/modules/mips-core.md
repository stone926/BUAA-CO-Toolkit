# mips-core | src/mips/core/ | 25 files

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
- machine/executeService.ts — CLI/Worker 共用的执行与设备周期向量服务 DTO（固定字宽输出、显式上限）
- devices/timer.ts — 官方 P7 计时器 CycleContract（依据 P7_standard_timer_2019.v：WE 抑制状态机、IRQ = ctrl[3] & _IRQ）
- devices/interruptController.ts — 中断发生器（宏观 victim PC + occurrence 计划、store 0x7f20 应答）与 HWInt 聚合
- devices/deviceBus.ts — DeviceBusPort：MMIO prepare/read/commit/abort 与显式 tickDevices；COUNT 只读在设备提交前抑制

## 时间域边界

架构 `MachineSession` 与周期级 `DeviceSession` 严格分离：`prepare/read/commit/abort` 都不推进 Timer，只有显式 `tickDevices` 或 case 提供的 `deviceTimeline` 才推进周期。缺少 cycle schedule 的 Timer 事务被判为 `device-schedule-missing` 的 out-of-domain，而不是架构 AdEL/AdES——教程没有定义流水线 commit 与 Timer 时钟的映射，那属于真实 DUT 的 scenario property。

## 可比较域

`OutOfDomainReason` 覆盖 COURSE-P56-DOMAIN-001 与 COURSE-P7-UNLOADED-IM-001 规定的输入：未加载指令字、未识别指令、除零、jalr 双寄存器相同、延迟槽内跳转、未定义 HI/LO 读取、Timer Mode 2/3 等。strict lane 一律 fail closed；`synthetic-zero` 与 `deterministic` 只作为显式 exploratory policy，结果不得成为 strict golden。

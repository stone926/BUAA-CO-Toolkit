# course-testing | src/courseTesting/ | 57 files + host adapters

P3–P7 自动化测试：生成 ASM → 内置 TS assembler/ProgramImage → 内置 TS 课程 oracle → Verilog（bundled Icarus）或 Logisim 仿真 Trace → 对比/Probe 检查 → HTML/JSON 报告。通用 Verilog 仿真与自动 DUT lane 固定使用扩展内置 Icarus，运行目录 `.co/iverilog`。

## 核心设计决策

**自动强度不可调。** `automaticTestPolicy.ts` 内部固定引擎、强度与外部工具预算；用户唯一的公开旋钮是 `co.test.instructions`（选择重点 payload 指令）。instruction_count 只统计 payload，生成器统一追加 `_co_test_end` 自分支 + nop。P3–P6 用满 4094 条 payload，P7 用 1118 条且不覆盖 0x4180；工作区 legacy 回滚设置不能降低自动规模。教程硬件/builtin lane 使用完整 4096-word IM（0x3000..0x6fff）；手动 legacy v0.6.3 路径因 Compact 内存排他 bug 单独采用 4095-word policy。

**默认写入覆盖证据。** 生成程序先为全部 31 个可写 GPR 写入互异非零值并经两个读端口传播存入 DM；P4–P7 固定覆盖 `ori/add/sub/lw → jr` × 间隔 0/1/2（错误旧目标写毒值，正确路径独立标记）；含 `ori` 且 payload ≥256 的程序在最后一槽发出 `_co_test_complete` 可见写，再接标准两条 halt 尾。

**P7 双通道。** 自动固定 `hybrid`：`anchor`（TS 课程 oracle 精确对拍 + 中断注入）与 `probe`（DM 探针黑盒检查）同时覆盖。probe 在内部确定性拆为 core / MMIO / Timer / priority / MDU 五个分片，每个程序都留在 0x4180 之前且最多使用 64 个 DM 记录。**probe 是 DUT-only，不能冒充 full-stack reference evidence**；mode 与分片只是内部类型，不是公共设置。

**证据诚实。** probe 在首次 mtc0/异常前用 mfc0 读取 SR/Cause/EPC 并把原始值写入 DM，metadata 把样本绑定到各自的 store PC 并严格检查初值零、唯一、早于 handler 记录。MDU 黑盒结果无法区分产生相同完整结果的合法早启动与非法晚启动，因此**不**宣称为内部启动时刻的证明。报告也说明"通过"只对应本次可观察结果，完整无写回执行、课程周期与结构仍需独立验证。

**引擎边界。** automatic case 直接建立 builtin `CourseEnginePlan`，生成规模、工具链预检、prepare 与 oracle 都不读 workspace rollback，也不启动 legacy capability probe——这保证 text/ktext `.word` RI 可稳定执行。手动 case 开始时读一次 resource-scoped `co.mips.engine` 并生成原子计划，prepare 与 oracle 必须复用。

**失败即停、有界留存。** 持续测试首个失败或错误立即停止，零延迟主动 yield 保持扩展宿主响应；取消不计测试 error。留存清理对同一 manifest 串行，捕获并复验目录/manifest identity 后原子移入受控 `.co/trash`，所有不确定状态 fail-closed 保留。

## Pipeline

- `pipeline/courseTracePipeline.ts` — 可注入的课程 Trace pipeline 对象（image policy、builtin oracle、backend-neutral DUT 执行与差分比较）
- `pipeline/courseImagePolicy.ts` + `pipeline/executionBudget.ts` — 课程 ProgramImage 段布局/容量/停机字策略与执行预算单一入口；自动仿真从架构 step budget 派生私有预算并由 Icarus 转成 watchdog，不受手动 `co.project.simTime` 截断
- `traceRunner.ts` — 单 case 执行：一次快照 engine plan，依次校验 source closure、assembler image、ProgramImage policy、oracle、Icarus DUT 与 manifest metadata；复用已持有且已落盘的有界 stdout，不重读
- `automaticTestPolicy.ts` — 自动测试引擎/强度/预算唯一入口
- `generatorWorkflow.ts` — 自动入口始终用内置 generator 与 internal policy；provenance/指令数/session 所有权随 case 首次 manifest 原子写入；部分生成失败时回收本 session 未执行的 case
- `courseTestSession.ts` — 持续测试的原子会话租约（异步初始化前同步占位）
- `executorShadowRunner.ts` — executor-only shadow，结果显式标为 `executor-only`，不计入 full-stack gate
- `fullStackShadowRunner.ts` + `shadowBundleArtifacts.ts` — full-stack shadow：隔离物化 source closure，双端独立运行并逐字比较 image，matched/mismatch/inconclusive 都原子保存 bundle，未登记或不可比较结果阻断

## 策略与硬件事实

- `p7Hardware.ts` — P7 硬件布局单一入口（加载/校验 `resources/co/p7Hardware.json`）
- `mnemonicSets.ts` — Profile 指令集与功能分组、访存对齐、MDU 周期
- `generatorInstructionCatalog.ts` — 从唯一 ISA catalog 加载的生成器 profile、分类与 MDU 延迟投影
- `p7RiWords.ts` / `p7RiInstruction.ts` — P7 RI raw-word 目录与旧助记符的只读兼容
- `p7InterruptAnchor.ts` — P7 外部中断 schedule 的共享静态契约（生成与 replay 校验复用）
- `machineCodeValidation.ts` — 用 core catalog canonical decoder 校验最终 HexText；调用方须显式选 4096-word 或 4095-word 容量策略
- `courseDataInitialization.ts` — 课程 DM 初态预检（4 KiB 分配块，首个非零或畸形 dump 立即失败）
- `cpuState.ts` — 软件 CPU 模型（32 GPR + 3072-word DM + HI/LO + CP0 + MDU 保护与最近写入追踪）
- `random.ts` / `mipsUtil.ts` / `executionBudget.ts` — 确定性伪随机、立即数工具与课程 halt 尾、provider-neutral 预算计算
- `mips/legacy/haltValidation.ts`、`mips/legacy/marsOracleCompatibility.ts`、`mips/legacy/marsImageCompatibility.ts` — legacy/reference 层的停机尾证明、coL2 动态兼容与 HexText/IG 绑定检查

## 内置 ASM 生成

- `builtinAsmGenerator.ts` — 入口 `generateBuiltinAsmTestCase`；P7StressMode 分派（anchor→randomBody、probe→probeEmitter、hybrid 两次调用）
- `builtinAsm/facade.ts` — 高层 API 与指令集解析
- `builtinAsm/randomBody.ts` — 核心随机引擎：课程 DM 内对齐访存、分支双路径、有界控制流；普通路径避免有符号溢出/未初始化 HI-LO/除零等非法输入，P7 只通过受控场景制造异常
- `builtinAsm/instructionSemantics.ts` — ALU/立即数/移位/计数/分支判定与溢出的纯语义
- `builtinAsm/registerCoverage.ts` — 全 GPR 写入/双读端口/DM 传播与 jr × 间隔矩阵；预算不足时不发出半套覆盖段
- `builtinAsm/programWriter.ts` / `builtinAsm/types.ts` / `builtinAsm/asmTemplates.ts` — 行累积与 PC 跟踪、P7 场景与期望类型、异常处理模板插值
- `builtinAsm/hazard/hazardTracker.ts`、`builtinAsm/hazard/hazardTargets.ts`、`builtinAsm/hazard/hazardBlocks.ts`、`builtinAsm/hazard/operandSteer.ts` — 复用 hazard-analysis.md 的共享 AT 模型做定向冒险生成，按覆盖缺口先类别后元组选择

## P7 probe

- `builtinAsm/p7/probeVariants.ts` — 变体目录与唯一分片归属（按 `mdu-` / `priority-` / Timer 寄存器前缀分流）
- `builtinAsm/p7/probeScenarios.ts` — 场景 kind 规划（先覆盖启用类别，再按当前分片补齐变体；core 余量以 RI 填充）
- `builtinAsm/p7/probeEmitter.ts` — probe 主程序与统一异常处理程序；每场景 guard→触发/中断窗口→完成标记，写入单个 8-word 物理记录
- `builtinAsm/p7/probeVictims.ts` — 内部异常精确触发序列（victim PC、EPC/BD、MDU 完整旧/新 HI-LO 允许态）
- `builtinAsm/p7/probeExternalScenarios.ts`、`builtinAsm/p7/probePriorityScenarios.ts`、`builtinAsm/p7/probeMduScenarios.ts`、`builtinAsm/p7/probeMduOperations.ts`、`builtinAsm/p7/probeTimerWriteScenario.ts`、`builtinAsm/p7/probeAsm.ts`、`builtinAsm/p7/constants.ts` — 外部受害路径、中断优先级序列、MDU 组合、Timer pending-writes 稳定态与共用原语/常量
- `p7ProbeCheck.ts` — DUT-only 黑盒精确检查：重建完整 DM 记录并校验 CP0/EPC/Timer 前后状态与 handler 前后精确 commit

## Oracle 与观察

- `oracle/commitProjection.ts` — CommitEvent → 结构化 first-diff 摘要与 canonical event digest
- `oracle/differentialRunner.ts` — legacy/builtin 架构写 trace、first-diff 与 final digest 的确定性差分
- `oracle/shadowPolicy.ts` — 已登记 divergence 策略；未登记差异固定为 inconclusive
- `oracle/executionAssertions.ts` — CommitEvent assertion/watchpoint 观察器
- `dmStoreCheck.ts` — 从 builtin CommitEvent 与 `CO_DM_STORE` 公开事务逐笔对拍，补齐整字相同情况下的地址/mask 漏检

## Logisim（P3）

- `logisimTraceProfile.ts` — 从 courseConfig 读取的 Trace profile（text base、ROM 容量、列顺序、halt/PC 策略）
- `logisimTrace.ts` / `logisimPrep.ts` — 电路 XML 端口标注推导、Trace 解析、PC 监控自动 kill 与单用例 ROM 注入

## 宿主入口与用例存储

- `courseTest.ts` — 仅注册持续测试启动/停止/测试历史三个公共入口
- `courseTestContinuous.ts` — 持续生成循环：首个失败即停、有界产物与报告、1 秒窗口合并
- `courseTestToolchain.ts` — mode-aware 校验，automatic 固定 builtin override 且不泄漏本机路径
- `courseTestLogisim.ts` — P3 自动电路诊断与 ROM 注入对拍；原始 stdout 最多 64 MiB，触顶终止并报告截断原因
- `courseTestReport.ts` / `courseTestMessages.ts` / `courseTestStdin.ts` / `courseTestTraceFiles.ts` / `courseTestCases.ts` / `continuous.ts` — HTML 报告、中文 diff 提示、stdin 发现、输出命名（`.co/out/{stem}.oracle.out` 与 `.sim.out`）、case 输入与留存裁剪
- `asmCaseStore.ts` / `asmCaseStoreCore.ts` / `manifestCodec.ts` / `continuousCaseRetention.ts` / `pathContainment.ts` — 用例持久化与 manifest v1（只读）/v2 codec：创建时捕获完整 SourceUnit/include graph，后续汇编与 oracle 只读 case 内 immutable materialization；所有路径只接受 canonical `/`，大小写碰撞、symlink 与 containment escape fail closed

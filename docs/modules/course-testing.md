# course-testing | src/courseTesting/ | 74 files + host adapters

P3–P7 自动化测试：生成 ASM → 内置 TS assembler/ProgramImage → 内置 TS 课程 oracle → Verilog（bundled Icarus）或 Logisim 仿真 Trace → 对比/Probe 检查 → HTML/JSON 报告。通用 Verilog 仿真与自动 DUT lane 固定使用扩展内置 Icarus，运行目录 `.co/iverilog`。

## 核心设计决策

**自动强度不可调。** `automaticTestPolicy.ts` 内部固定引擎、强度与外部工具预算；`co.test.instructions` 选择重点 payload 指令，`co.test.concurrency` 只控制并发资源上限（默认 4，1–8），不改变每点强度。instruction_count 只统计 payload，生成器统一追加 `_co_test_end` 自分支 + nop。随机点 P3–P6 用满 4094 条 payload，P7 用 1118 条且不覆盖 0x4180；工作区 legacy 回滚设置不能降低自动规模。教程硬件/builtin lane 使用完整 4096-word IM（0x3000..0x6fff）；手动 legacy v0.6.3 路径因 Compact 内存排他 bug 单独采用 4095-word policy。

**独立 GPR 覆盖。** 每个持续测试会话先运行一个 127 条 payload 的独立测试点，为全部 31 个可写 GPR 写入互异非零值并经两个读端口传播存入 DM，最后发出完成标记；后续随机测试点不再重复 126 条 GPR 前导。该基础检查使用课程必需指令，不受 payload 重点指令设置影响。P4–P7 随机点固定覆盖 `ori/add/sub/lw → jr` × 间隔 0/1/2（错误旧目标写毒值，正确路径独立标记）；随机跳转将可观察毒指令计入最低预算，余量不足时改发其他指令。含 `ori` 且 payload ≥256 的程序在最后一槽发出 `_co_test_complete` 可见写，再接标准两条 halt 尾。

**P7 双通道。** 自动固定 `hybrid`：`anchor`（TS 课程 oracle 精确对拍 + 中断注入）与 `probe`（DM 探针黑盒检查）同时覆盖。正常 probe 分为 core / MMIO / Timer / MDU / hazard，另逐轮生成 5 个真实中断返回后再次中断的独立程序，最后执行 3 个特殊 Timer 分片。首轮加独立 GPR 共 15 点，后续 14 点；随机 payload 预算保持 1118。原 130 个变体全部保留，新增 4 个 older-MDU 变体、2 个 Mode1 停止态变体与 5 个返回程序；每个程序的用户文本留在 0x4180 之前、DM 记录不超过 64 个。**probe 是 DUT-only，不能冒充 full-stack reference evidence**；mode、分片与变体均不是公共设置。

**特殊测试说明。** 原软件设置 EXL/EPC、通过 `jal→eret` 释放 pending Timer 的 36 个变体单独放入 special-priority（14）/special-mdu（12）/special-hazard（10），保持实际检查与失败状态。ASM、manifest、运行输出、HTML/JSON 报告和历史都标明其官方保证范围尚未确认，单凭此失败不能判定课程 CPU 不合格；旧混合点按实际 scenario 类型推断同样的说明。正常测试与新返回点先运行，特殊点随后运行，不新增配置开关。

**真实返回边界。** return 程序通过真实外部 IRQ 进入只有一个 eret 出口的 handler。公开 TB 先确认首次应答，观察 eret 成为宏观指令，再在宏观 PC 离开时产生第二次 IRQ；保留原始 PC、不对齐掩码、不读取内部层次，也不固定 CP0 级或周期偏移。这依赖官方宏观 PC 的架构边界契约，不声称独立测得错误 DUT 的内部 EXL。未观察到触发边界时单列“未覆盖”，作为检测 error 停止本轮，不计 CPU 功能失败或通过。Checker 绑定全部主程序/handler 提交与记录来源，校验 EPC/BD 与提交先后，只允许被 BD/EPC 证明的 jal link 重放。中断发生器事务在官方下降沿消费点观察；毒写已经构成公开反例后提前结束，保留当前边沿 trace。

**证据诚实。** probe 在首次 mtc0/异常前用 mfc0 读取 SR/Cause/EPC 并把原始值写入 DM，metadata 把样本绑定到各自的 store PC 并严格检查初值零、唯一、早于 handler 记录。MDU 黑盒结果无法区分产生相同完整结果的合法早启动与非法晚启动，因此**不**宣称为内部启动时刻的证明。报告也说明"通过"只对应本次可观察结果，完整无写回执行、课程周期与结构仍需独立验证。

**引擎边界。** 手动与 automatic case 均建立 builtin `CourseEnginePlan`，prepare 与 oracle 必须复用；旧 mars/verify-both 配置归 auto，不启动魔改 MARS 或其 capability probe。text/ktext `.word` RI、P7 异常/Timer/IRQ 与课程复位、停机语义由内置引擎提供。历史 legacy adapter 与证据只用于辨认原结果，不把官方 MARS 当作课程 oracle。

**有界并发、失败即停。** 会话启动时快照并发量；P3–P6 每轮生成对应数量的独立随机点，P7 保留原有 14 点套件。GPR / 常规 / 特殊测试之间有完成屏障，同一 manifest 的 stdin 变体互斥，空闲槽立即接新点。首个失败或错误立即停止派发并 abort 同批任务，等待所有在途任务（含进程退出、manifest 写入）完成后才清理或释放会话；取消不计 error，已完成结果和失败证据保存。并发量 1 维持串行顺序，轮间零延迟主动 yield 保持扩展宿主响应。报告写入仍串行合并，caseIndex 保持原测试点编号，activeCases 展示多个活动点并兼容旧 activeCase。

**有界留存。** 留存清理对同一 manifest 串行，捕获并复验目录/manifest identity 后原子移入受控 `.co/trash`，所有不确定状态 fail-closed 保留；清理始终等待整批任务结束。

**中文诊断。** P7 定向检查、普通写回差异、DM 写事务与 Logisim 检查在诊断来源生成中文消息；持续测试报告使用中文类别、参考/待测标签和复现编号。旧报告中已知的 CP0 复位及写回差异英文消息在展示时兼容转换，原始记录不改写。机器状态码、协议标记、寄存器/信号名和外部工具原始诊断保持原样。

**特殊点结果可见。** 特殊范围说明不替代测试判定：历史保存具体首个失败（场景、PC、期望与实际等有界摘要），显示通过/失败/错误；无明确终态时显示“无结果”或“已取消”，不从测试类别或产物推断通过。历史面板仅在打开时监视本工作区 `.co/cases/*/case.json`，合并变更后串行刷新。持续页在特殊点开始/结束时立即刷新，并在轮次表上方展示最近含特殊点的一轮及其真实结果；运行中的点尚无正误判定，首失败停止策略不变。

## Pipeline

- `pipeline/courseTracePipeline.ts` — 可注入的课程 Trace pipeline 对象（image policy、builtin oracle、backend-neutral DUT 执行与差分比较）
- `pipeline/courseImagePolicy.ts` + `pipeline/executionBudget.ts` — 课程 ProgramImage 段布局/容量/停机字策略与执行预算单一入口；自动仿真从架构 step budget 派生私有预算并由 Icarus 转成 watchdog，不受手动 `co.project.simTime` 截断
- `traceRunner.ts` — 单 case 执行：一次快照 engine plan，依次校验 source closure、assembler image、ProgramImage policy、oracle、Icarus DUT 与 manifest metadata；复用已持有且已落盘的有界 stdout，不重读
- `automaticTestPolicy.ts` — 自动测试引擎/强度/预算唯一入口
- `generatorWorkflow.ts` — 自动入口始终用内置 generator 与 internal policy；provenance/指令数/session 所有权随 case 首次 manifest 原子写入；部分生成失败时回收本 session 未执行的 case
- `courseTestSession.ts` — 持续测试的原子会话租约（异步初始化前同步占位）
- `concurrentCases.ts` — 固定槽的有界异步调度、阶段屏障、产物互斥、即时失败取消与全量 drain；不依赖 VS Code
- `continuousTraceBatch.ts` — 单批课程测试的并发执行、活动点状态与串行结果保存
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
- `builtinAsm/registerCoverageProgram.ts` — 独立 GPR 测试点，释放每个随机点的前导预算；由 workflow 每会话调度一次
- `builtinAsm/controlTargetCoverage.ts` — 有界双向控制流图：自目标、低地址回边、高地址前跳、分支两臂汇合与可观察路径写；短预算使用紧凑图，循环不以静态值快照冒充动态冒险覆盖
- `builtinAsm/programWriter.ts` / `builtinAsm/types.ts` / `builtinAsm/asmTemplates.ts` — 行累积与 PC 跟踪、P7 场景与期望类型、异常处理模板插值
- `builtinAsm/hazard/hazardTracker.ts`、`builtinAsm/hazard/hazardTargets.ts`、`builtinAsm/hazard/hazardBlocks.ts`、`builtinAsm/hazard/operandSteer.ts` — 复用 hazard-analysis.md 的共享 AT 模型做定向冒险生成，按覆盖缺口先类别后元组选择
- `builtinAsm/hazard/hazardWitnesses.ts` — 双端口混合生产者、较新 load/ALU 写优先、load 同时供给 store 地址与数据、字节/半字 lane 读回；错误来源必须改变架构结果

## P7 probe

- `builtinAsm/p7/probeVariants.ts` — 变体目录与唯一分片归属；Timer 的 priority/MDU/hazard 旧释放链单独归入三个特殊分片，legacy priority 仍可复现
- `builtinAsm/p7/probeScenarios.ts` — 场景 kind 规划（先覆盖启用类别，再按当前分片补齐变体；core 余量以 RI 填充）
- `builtinAsm/p7/probeEmitter.ts` — probe 主程序与统一异常处理程序；每场景 guard→触发/中断窗口→完成标记，写入单个 8-word 物理记录
- `builtinAsm/p7/probeVictims.ts` — 内部异常精确触发序列（victim PC、EPC/BD、MDU 完整旧/新 HI-LO 允许态）
- `builtinAsm/p7/probeExternalScenarios.ts`、`builtinAsm/p7/probePriorityScenarios.ts`、`builtinAsm/p7/probeMduScenarios.ts`、`builtinAsm/p7/probeMduOperations.ts`、`builtinAsm/p7/probeTimerWriteScenario.ts`、`builtinAsm/p7/probeAsm.ts`、`builtinAsm/p7/constants.ts` — 外部受害路径、中断优先级序列、MDU 组合、Timer pending-writes 稳定态与共用原语/常量
- `builtinAsm/p7/probeHazardScenarios.ts` — 中断重试 load→branch/jr 和延迟槽 load-use；AdEL/AdES/Ov 与依赖链交叉；Timer 的软件 EXL 返回链作为特殊场景保留
- `builtinAsm/p7/probeReturnProgram.ts` — 5 个带种子数据/布局变化的真实双 IRQ 程序：direct、load-jr、branch-delay、jal-delay、MDU；整个程序均有精确可观察提交义务
- `builtinAsm/p7/probeTimerMode1Scenario.ts` — mode1-repeat 保持 Enable=1/PRESET 不变，验证 COUNT 重载及第二次自然 IRQ；恢复 IM 后在 IE=0 下轮询并保留实际零样本，不假定后续采样相位。额外 mode1-stopped 用 CTRL=2/0xa 建立停止态稳定观察，允许最后一次 LOAD 瞬态，再显式启动新周期。COUNT/IP 采样仍受混叠限制，未命中不能单凭 watchdog 证明 Timer 错误
- `p7ProbeScope.ts` — 特殊压力场景范围判定与统一用户说明，兼容旧混合 metadata 和早期工具错误
- `testOutcomeDiagnostic.ts` — 历史与持续测试共用的有界中文结果摘要，保留探针首失败、结构化写回/DM 事务差异及工具诊断；脱敏后附独立范围说明
- `p7ReturnCheck.ts` — 返回协议、全部 main/handler 事务、记录字段来源、EPC/BD 提交边界与合法 jal link 重放检查；未覆盖与功能失败分别记录
- `p7ProbeCheck.ts` — DUT-only 黑盒精确检查：重建完整 DM 记录并校验 CP0/EPC/Timer 前后状态与 handler 前后精确 commit；按 PC 一次索引提交，older 必须早于记录首字段，取消的 younger/错误路径提交即失败

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

- `src/courseTestFailure.ts` / `src/courseTestFailureReport.ts` — 持续页与历史共用的失败排查面板：首差异、保存的源码定位、trace diff、日志、可取消重跑与波形入口；固定消息动作，按需加载
- `failureEvidence.ts` / `failureDiagnosis.ts` — 有界首差异导航信息、历史解码、PC/场景定位目标、结果与排查提示；不把观察差异推断为根因
- `writebackComparison.ts` / `src/courseTestWriteback.ts` / `src/courseTestWritebackReport.ts` — 共用 trace parser / 对齐 iterator 的有界事件比较；忽略排版与时间戳，41项上下文页、差异导航、逐字段高亮和源码/原始日志定位，替代原始文本 diff
- `caseInspection.ts` — 指定 case 的 containment/hash/bounded read、ProgramImage→include 源码行、部分损坏降级；大波形只在打开时验证
- `caseRerun.ts` / `caseRerunWaveform.ts` — 原 ASM/include/stdin/P7 闭包→独立新 case→现有 automatic pipeline；阶段校验、原证据保留、取消单列。波形仅装饰 DUT，复用私有 TB / 预算，dump 编译失败可降级存储器；波形问题不改 CPU 判定

- `courseTest.ts` — 仅注册持续测试启动/停止/测试历史三个公共入口
- `courseTestHistory.ts` / `courseTestHistoryReport.ts` — 历史页宿主监视/合并刷新与纯 HTML 渲染分离；执行终态优先，无结果明确标注，面板关闭后释放监视与定时器
- `courseTestContinuous.ts` — 持续生成循环：首个失败即停、有界产物与报告、1 秒窗口合并
- `courseTestToolchain.ts` — mode-aware 校验，automatic 固定 builtin override 且不泄漏本机路径
- `courseTestLogisim.ts` — P3 自动电路诊断与 ROM 注入对拍；原始 stdout 最多 64 MiB，触顶终止并报告截断原因
- `courseTestReport.ts` / `courseTestMessages.ts` / `courseTestStdin.ts` / `courseTestTraceFiles.ts` / `courseTestCases.ts` / `continuous.ts` — HTML 报告、中文 diff 提示、stdin 发现、输出命名（`.co/out/{stem}.oracle.out` 与 `.sim.out`）、case 输入与留存裁剪
- `asmCaseStore.ts` / `asmCaseStoreCore.ts` / `manifestCodec.ts` / `continuousCaseRetention.ts` / `pathContainment.ts` — 用例持久化与 manifest v1（只读）/v2 codec：创建时捕获完整 SourceUnit/include graph，后续汇编与 oracle 只读 case 内 immutable materialization；所有路径只接受 canonical `/`，大小写碰撞、symlink 与 containment escape fail closed

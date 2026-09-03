# course-testing | src/courseTesting/ | 51 files + host adapters

P3-P7 自动化测试：生成 ASM -> 内置 TS assembler/ProgramImage -> 内置 TS 课程 oracle -> Verilog(bundled Icarus)/Logisim 仿真 Trace -> 对比/Probe 检查 -> HTML/JSON 报告。通用 Verilog 仿真和自动 DUT lane 固定使用扩展内置 Icarus；resource-scoped `isePath` 仅服务 ISim GUI 波形和当前 ISim VCD 等专属功能，不再充当默认后端 selector。所有 `source.kind=generator` 自动用例固定使用 builtin reference stack，不继承 resource-scoped `co.mips.engine`；`mars` 回滚、`verify-both` 与固定 MARS reference 只属于手动测试、历史 replay 和显式开发者验证。

MARS reference 按角色严格拆分：assembly compatibility 使用 `mars-assembler-v0.6.3`（8b53a49，SHA-256 `599957…afb31`）；真实 execution/full-stack gate 使用 `legacy-course-executor` v0.6.3-course1（c6197f4，SHA-256 `d13456…0c64`）。`mars` 模式是 configured legacy 回滚，只有 `verify-both`/开发命令要求后一固定身份。legacy 课程 oracle 强制 coL2，coL1 仅作兼容探针；P7 按需使用 efc/p7irq，只有历史 `_co_internal_unknown_instruction` 用例才额外使用 cl，新生成 RI raw word 不需要。MARS 的 dump、停机尾、SWL/SWR、REGIMM link、Compact 初态/边界 bug 修复只存在于 `mips/legacy` normalizer 和 conformance，不进入 builtin provider/core。任一含非零 `.data` 初值的课程 case 会在 provider-neutral ProgramImage policy 处拒绝，因为 DUT 复位内存为全零。

生成程序边界：自动测试强度由 `automaticTestPolicy.ts` 内部固定，用户只可通过 `co.test.instructions` 选择重点 payload 指令。instruction_count 只统计 payload；P3-P7 内置生成器统一追加 `_co_test_end` 自分支+nop。P3-P6 自动使用 4094 条 payload，P7 使用 1118 条且不覆盖 0x4180；工作区 legacy 回滚设置不能降低自动规模。教程硬件/builtin lane 使用完整 4096-word IM（0x3000..0x6fff）；手动 legacy v0.6.3 兼容路径因 Compact* 排他 bug 单独采用 4095-word policy（末址 0x6ff8），不属于 automatic policy。P7 DUT image 把 text/ktext 等非 data 段按绝对地址合并并用零填补空洞，不再丢失 0x4180 内核段。

默认生成程序先为全部 31 个可写 GPR 写入互异非零值，经两个读端口传播并存入 DM；P7 在启用 handler/中断前完成此段，随后恢复 $26/$27 的约定。P4–P7 固定覆盖 ori/add/sub/lw → jr × 间隔 0/1/2，错误旧目标指向毒写，正确路径有独立标记；P3 课程指令集不含 jr。固定覆盖段在所需指令已启用且预算足够时生成。含 ori 且至少 256 payload 的程序在最后一个 payload 槽发出 `_co_test_complete` 可见写（默认 automatic 均满足），之后仍是标准两条 halt 尾；短程序及不含 ori 的历史重点集保持兼容。完成标记增强到达程序末尾的证据，不证明其后所有无写回指令或课程性能。

P7 自动固定运行 hybrid：anchor(TS 课程 oracle 精确对拍+中断注入)与 probe(DM 探针黑盒检查)同时覆盖；probe 在内部确定性拆为 core 64、MMIO 26、Timer 10、priority 14、MDU 18 场景，每轮覆盖全部 109 个显式变体，core 剩余位置补 RI；每个程序都留在 0x4180 前，最多使用 64 个 DM 记录。外部中断、Timer 与全部课程异常类型始终启用。probe 为 DUT-only，不能冒充 full-stack reference evidence；低层 mode/分片仅为历史 replay/内部测试类型，不是公共设置。

P7 系统组合使用合法的程序可见状态同步：Timer Mode0 在 IE=0 下通过 Cause.IP 轮询确认 pending，再设置 EXL/EPC，经 handler 内独立 eret 入口精确返回受害指令。Timer 与 RI/AdEL/AdES/Ov/Syscall 的直接组合检查 Int 优先、随后重试异常；两种分支组合先中断分支，再检查延迟槽异常的 BD/EPC。外部与两路 Timer 分别组合六种 MDU 写操作，handler 接受课程允许的完整旧/新 HI/LO 状态，返回后必须精确读回结果，mthi/mtlo 未修改的半部必须保留。该观察不能区分产生相同完整结果的合法早启动与非法晚启动，因此不把黑盒结果宣称为内部 MDU 启动时刻的证明。

Probe 在首次 mtc0/异常前以 mfc0 读取 SR、Cause、EPC，并将三项原始值写到 DM；metadata 将样本绑定到各自的 store PC，严格检查初值为零、唯一且早于 handler 记录，后续复用同一地址不能掩盖错误。Timer pending-writes 场景以已确认到期的 Mode0 稳定态检查 CTRL/PRESET/COUNT 和 IM 屏蔽/重开后的 pending；相邻 ASM 指令不被当作固定设备访问节拍，逐边沿 WE > FSM 仅由 Timer 单元测试验证。

阶段 6 引擎边界：automatic case 直接建立 builtin `CourseEnginePlan`，生成规模、工具链预检、prepare 与 oracle 均不读取 workspace rollback，也不会启动 legacy capability probe；这保证 text/ktext `.word` RI 可稳定执行。手动 case 开始时读取一次 resource-scoped `co.mips.engine` 并生成原子计划，prepare 与 oracle 必须复用：`auto` 对 P3–P7 选 builtin，stdin/交互能力在阶段 7 前明确选 legacy；`builtin` 强制 builtin；`mars` 强制 configured legacy；`verify-both` 主路径 builtin，并用固定 reference 的独立汇编结果喂给独立 legacy executor。builtin event artifact 在持久化时复核 event count/digest、final-state digest、engine/image/profile/stop 绑定；assembler 与 executor 使用各自逻辑 artifact/revision 身份。

orchestration:
  courseTest.ts — 总调度；公共测试启动入口唯一为“启动持续测试”，默认按最强策略无限生成，并在首个失败或错误时立即停止；另保留“停止持续测试”和“测试历史/失败用例”两个控制/诊断入口，旧单轮自动入口已删除，低层手动/回放命令 ID 仅作隐藏兼容。runCourseTraceCase 串联 plan->assemble provider->同 plan oracle provider->Icarus/Logisim DUT->compare，并分流 P7 probe
  courseTestCases.ts — CourseTraceCaseInput 类型、failedCase 构造
  courseTestContinuous.ts — “启动持续测试”的持续生成循环：生产入口固定最强配置、无限轮、首个失败或错误立即停止、零延迟主动 yield、会话内通过产物/报告有界、失败/错误产物保留；monitor JSON/Webview 常态按 1 秒窗口合并，只有首次/最终强制落盘。每个 session 以 UUID 绑定生成 case，P7 首例失败、展开异常或用户取消后只回收本 session 尚未执行/已取消的 case，取消不计测试 error；留存清理按本轮候选有界轮转，单个拒绝项不会饿死后续合法 case，standalone 失败保留为可重试。启动阶段同步占位防重复会话，面板关闭触发停止，最终报告写失败也保证释放会话
  courseTestMessages.ts — diffMessage 中文提示、marsStageFailureMessage
  courseTestReport.ts — HTML 报告：批量/Logisim 准备/持续监控/ASM 索引；批量和持续报告说明通过仅对应本次可观察结果，完整无写回执行、课程周期和结构仍需独立验证；读取时兼容旧 mars/sim/logisim 字段，新结果只使用 oracle/dut；DUT terminal failure 公开字段只保留归一化 phase/reason/exit 与脱敏、限长首条诊断，`[AUTO-DUT]` 直接给出可定位原因；legacy logisimOut 只解释为原始 CLI 输出，不伪装成已解析 DUT trace
  courseTestToolchain.ts — mode-aware 校验：automatic 固定传 builtin override，P4–P7 不探测 Java/MARS，失败只输出稳定能力名而不泄漏本机路径；手动 mars/verify-both 才检查稳定版 Compact/coL1/coL2/efc/p7irq 与内存配置，cl 仅在历史 RI mnemonic 精确回放时按需校验。固定验证另在执行前按编译内置信任身份校验 course1 bytes/SHA-256
  courseTestLogisim.ts — P3 Logisim：与 traceRunner 共享原子 engine plan/ProgramImage policy/full-stack shadow；电路诊断(提取 Trace 端口映射)->ROM 注入批量准备->单用例(CLI 启动->PC 监控->自动 kill->Trace 解析->对拍)。只有 legacy lane 才运行 MARS coL2/初态兼容检查
  courseTestStdin.ts — stdin 文件发现：input/inputs/test/data 目录，按文件名相似度排序
  courseTestTraceFiles.ts — 输出命名：.co/out/{stem}.oracle.out、.co/out/{stem}.sim.out；手动比较仍兼容读取旧 `.mars.out`

generation:
  courseTesting/batchRunner.ts — 批量课程 Trace case 调度、结果汇总和 trace-batch-report.json 写入；会话级 AbortController 贯穿 assembler/oracle/Icarus/Logisim，`stopCourseTraceBatch()` 支持停止当前 batch；新报告固定 schemaVersion 2 与 assemble/oracle/dut/compare/probe/internal 中立 stage，未分类框架异常不得伪装成 compare 失败
  courseTesting/courseTestSession.ts — batch 与 continuous 共用的原子会话租约；任意单次/持续课程测试互斥，避免共享 Icarus/Logisim 工作目录、testbench 和机器码被并发覆写，release 幂等并在 finally 中执行
  courseTesting/automaticTestPolicy.ts — 自动测试引擎、强度与外部工具预算唯一入口：固定 builtin；P3-P6 4094 payload，P7 1118+hybrid+全异常，中断/Timer 固定开启；持续测试的停止/留存策略也在此冻结
  courseTesting/generatorWorkflow.ts — 自动入口始终使用内置 generator 和 internal policy，不再由活动外部生成器文件接管；生成器 provenance/实际指令数/continuous ownership 随 case 首次 manifest 原子写入，不再紧接第二次 metadata 提交，部分生成失败时回收已创建且仍属本 session 的 case；P7 hybrid 内部展开为 anchor 与目录定义的五个 probe 分片，分片写入 manifest 供精确 replay 但不形成用户设置；历史 external setup 与完整 CourseTraceBatchSource provenance 仅供隐藏兼容/精确 replay
  courseTesting/executorShadowRunner.ts — executor-only shadow 宿主：同一 legacy ProgramImage 证据上对比 builtin executor；结果显式标为 `executor-only`，不能计入 full-stack gate
  courseTesting/fullStackShadowRunner.ts + shadowBundleArtifacts.ts — full-stack shadow：从已哈希 v2 source closure 建立隔离 materialization，builtin assembler→builtin executor 与 fixed legacy assembler→其自身 legacy executor 双端独立运行；前后复验 fixed hash、逐字比较实际 image，matched/mismatch/inconclusive 都原子保存 source/image/raw trace/engine/contracts/result bundle，未登记或不可比较结果阻断

  courseTesting/pipeline/courseTracePipeline.ts — 可注入的课程 Trace pipeline 对象（image policy、builtin oracle、backend-neutral Verilog DUT 执行与差分比较）；
  courseTesting/pipeline/courseImagePolicy.ts + courseTesting/pipeline/haltPolicy.ts + courseTesting/pipeline/executionBudget.ts — 课程 ProgramImage 段布局/容量/停机字策略与执行预算单一入口；自动 Verilog 仿真从架构 step budget 派生 200us..5ms 私有预算并由 Icarus 转成 watchdog（probe 使用内部上界），不受手动 `co.project.simTime` 截断

  courseTesting/oracle/commitProjection.ts — CommitEvent 到结构化 first-diff 摘要（PC、word、GPR/HI-LO/CP0、memory/device）与 canonical event digest；
  courseTesting/oracle/differentialRunner.ts — legacy/builtin 架构写 trace、first-diff、final digest 的确定性差分；
  courseTesting/oracle/shadowPolicy.ts — 已登记 divergence 策略；未登记差异固定为 inconclusive；
  courseTesting/oracle/executionAssertions.ts — CommitEvent assertion/watchpoint 观察器；

  courseTesting/traceRunner.ts — 单 case 执行：一次快照 engine plan，依次校验 source closure、assembler image、课程 ProgramImage policy、oracle、Icarus DUT 与 manifest metadata；自动 builtin 预算复用 case 首次捕获的实际指令数，DUT 比较/Probe 直接复用 runner 已持有且已落盘的有界 stdout，不再重读最多 16 MiB sim.out；provider-neutral 输出为 `.oracle.out`。anchor 与 P7 probe 失败统一经 simulationDiagnostic 归因，case result 保存安全摘要，case 目录另留私有原始 compile/simulation log 供复现。所有自动 P3-P7 case 固定 builtin，manual/replay 才读取 engineMode；普通 stdin、hash 变化、任一 inconclusive/not-comparable 仍阻断固定验证
  mips/legacy/marsOracleCompatibility.ts — legacy/reference 层的 P3-P7 稳定版 MARS oracle 兼容检查；coL2 动态跟踪 `$gp/$sp` 是否已显式初始化并重建访存有效地址，拒绝 signed EA 溢出和 Compact* 中课程硬件不存在的数据段；P7 对 efc 处理异常时不输出 victim 指令头的情况增加保守静态兜底
  mips/legacy/marsImageCompatibility.ts — legacy/reference 层将每个 coL2 动态 PC/机器码绑定到最终硬件 HexText（含 P7 padding/handler merge），并只允许 handler 内精确 `sb $0,0x7f20($0)` 访问 IG；用跨分支/跳转及延迟槽的静态常量数据流兜底无 victim header 的非对齐 IG 访问
  courseTesting/builtinAsmGenerator.ts — 入口：generateBuiltinAsmTestCase；P7StressMode 分派(anchor->randomBody、probe->probeEmitter、hybrid 两次调用)
  courseTesting/generator.ts — 外部生成器(.py/.js/.jar/.ps1/.bat 等)和 ASM 文件快照；以 mtime+ctime+size 判定新建/重写，能识别同 mtime、倒退 mtime 或尺寸变化，跳过 .co 产物目录
  courseTesting/p7RiWords.ts — P7 内置 RI raw-word 唯一目录/格式化/源码声明识别：覆盖 unknown opcode `0xfc000000` 与 unknown funct `0x0000003f`；anchor/probe/机器码白名单共用
  courseTesting/p7RiInstruction.ts — 历史只读兼容：仅对 P7 使用严格 assembler line parser 识别旧 `_co_internal_unknown_instruction` mnemonic；只供旧 manifest/replay/MARS class，新的内置源码不再生成该助记符
  courseTesting/generatorInstructionCatalog.ts — 加载由唯一 ISA catalog 生成的内置 ASM generator profile、分类、对齐和 MDU 延迟投影；生成脚本校验成员资格与 instruction effects/control/memory facts 一致
  courseTesting/machineCodeValidation.ts — 对最终 HexText 使用 core catalog canonical decoder；调用方必须显式选择 `course-hardware` 4096-word 或 `stable-mars-v0.6.3` 4095-word 容量策略，再校验保留字段、CP0 rd/方向与课程 profile 指令白名单；手写/外部 ASM 只允许默认课程集，只有 case manifest 证明来源为内置生成器时才采纳匹配的 instruction_set 声明；可信内置 P7 源码只特许其 text/ktext 中实际声明的 RI catalog raw words，并只读兼容旧助记符的 `0x0000003f`
  courseTesting/courseDataInitialization.ts — 课程 DM 初态预检：按修改版 MARS 的 4 KiB 分配块在同次汇编导出 0x0000..0x2fff，严格解析每个非空 1024-word HexText 块；允许未分配/`.space` 全零块，首个非零初值或缺失/畸形 dump 立即失败
  courseTesting/executionBudget.ts + mips/legacy/haltValidation.ts — provider-neutral pipeline 计算确定性执行预算；新自动 builtin case 可从创建时绑定的 instructionCount 直接计算，旧/manual case 仍解析源码或机器码保守回退；legacy/reference 层单独解析 coL2/停机标记，确认标准停机尾已实际执行并拒绝 cliff exit、错误自环和未到达尾部
  courseTesting/cpuState.ts — 软件 CPU 模型：32 GPR+3072-word DM(0x0000..0x2fff)+HI/LO+CP0+MDU 保护；HI/LO 初始化状态、字节/半字/字及修改版 MARS 小端 LWL/LWR/SWL/SWR 语义、最近写入追踪
  courseTesting/mnemonicSets.ts — Profile 指令集(P3:8 条，P4-5:+J 型，P6:+MDU/load-store 变体，P7:+CP0/异常)、功能分组、memoryAlignment/mduBusyCycles
  courseTesting/p7Hardware.ts — P7 硬件布局单一入口：加载/校验 resources/co/p7Hardware.json，导出 4096-word IM(0x3000..0x6fff)、3072-word DM(0x0000..0x2fff)、0x4180 异常入口、Timer、CP0、probe 状态/日志/testbench 常量
  courseTesting/p7InterruptAnchor.ts — P7 外部中断 schedule 的共享静态契约：MARS trigger(target-4)与 DUT target 必须都是 canonical simple ALU/immediate 指令；生成器选择与 replay bundle 校验复用同一集合
  courseTesting/random.ts — 32 位 xorshift 伪随机：int(min,max)/chance/pick、hashSeed
  courseTesting/mipsUtil.ts — 有符号/无符号与立即数工具；courseAsmHaltLoop 生成课程 ASM 停机尾，courseTraceHaltLoopError 拒绝源码与硬件机器码不一致的缺尾课程用例，appendHaltLoop 只为普通 dump/兼容流程幂等补齐尾部
  courseTesting/continuous.ts — ContinuousRunStatus/Counts、按留存轮数裁剪、功能失败与 stopOnFailure 的停止判定

builtin-asm:
  courseTesting/builtinAsm/asmTemplates.ts — 从 resources/templates/asm/*.asm 加载 P7 异常处理模板并做受控变量插值
  courseTesting/builtinAsm/facade.ts — 高层 API：generateBuiltinAsmTestCase/resolveBuiltinInstructionSet
  courseTesting/builtinAsm/randomBody.ts — 核心随机引擎(约 2100 行)：课程 DM 内的对齐访存、正/负偏移、分支双路径与有界控制流、稳定版 MARS 局部字访问；所有普通随机路径均避免有符号溢出、未初始化 HI/LO、除零等非法输入，P7 只通过受控场景制造异常；RI 以 `.word` 轮换共享目录并在默认 anchor 预算内覆盖 unknown opcode/funct；payload 后生成停机尾
  courseTesting/builtinAsm/registerCoverage.ts — 固定全 GPR 写入/双读端口/DM 传播，与 jr 生产者及 0/1/2 间隔矩阵；共享生成器 CpuState，预算不足时不发出半套覆盖段，毒写不污染正常模型状态
  courseTesting/builtinAsm/programWriter.ts — ProgramWriter：label/emit/raw 累积汇编行并跟踪 PC
  courseTesting/builtinAsm/types.ts — P7StressMode、场景 kind/variant、按序 CP0 期望、精确 retry commit、完成标记与 P7ProbeMetadata

p7-probe:
  courseTesting/builtinAsm/p7/probeAsm.ts — 安全噪声填充、中断启停、Timer 清零、立即数/探针状态写入等辅助原语
  courseTesting/builtinAsm/p7/probeEmitter.ts — Probe 主程序和统一异常处理程序生成；固定脚手架不依赖用户 payload 重点集，入口记录原始 CP0 复位样本；每场景 guard->触发/中断窗口->完成标记，写入单个 8-word 物理记录；中断优先级重放把第二次 Cause/EPC 打包进 aux，Timer 在 handler 软件清零前捕获 CTRL/COUNT；Mode1 先屏蔽设备 IM，再以软件轮询证明至少两次 COUNT 回卷、重新开 CPU 中断前 Cause.IP 已撤销，最后才接受新的 IRQ；另覆盖 disable/re-enable reload 与稳定 pending 写入性质
  courseTesting/builtinAsm/p7/probeTimerWriteScenario.ts — 两路 Timer 的 pending-writes 稳定态场景：等待 Mode0 到期，再改写 PRESET、切换 CTRL.IM，检查 COUNT=0、寄存器读回和 Cause.IP；CPU 场景不要求固定 COUNT 三连读结果
  courseTesting/builtinAsm/p7/probeExternalScenarios.ts — 外部中断的真实受害位置与重试路径：store、load-use 依赖、jal、已取/未取分支延迟槽 store；描述必须且仅能在异常处理后出现一次的 GPR/DM 提交
  courseTesting/builtinAsm/p7/probeScenarios.ts — 场景 kind 规划：先覆盖启用类别，再按当前分片的变体计数补齐轮换；core 余量以 RI 填充，其余分片只在自身类别内填充
  courseTesting/builtinAsm/p7/probeVariants.ts — 109 个变体及唯一分片归属：外部 Syscall/AdEL/AdES/Ov/RI 优先级、Timer 与五种内部异常优先级、两路 Timer 六寄存器 lb/lh 和 Count sb/sh/sw、六种 MDU 中断重试；保留屏蔽/等待/访存与跳转重试、延迟槽异常、Timer Mode0/Mode1/reload/pending-writes、年轻 MDU、RI raw words
  courseTesting/builtinAsm/p7/probePriorityScenarios.ts — 外部与 Timer 中断优先级序列、Cause.IP pending 证据和 handler eret 释放原语；Int 后重试异常独立检查两次 Status
  courseTesting/builtinAsm/p7/probeMduOperations.ts — 中断 MDU 六种操作及变体名称的纯目录，生成器与分片共用
  courseTesting/builtinAsm/p7/probeMduScenarios.ts — 外部/Timer0/Timer1 的 HI/LO 初始化哨兵、中断允许态、精确 EPC 重试和返回后 GRF/DM 结果检查；复用 Timer pending/eret 原语
  courseTesting/builtinAsm/p7/probeVictims.ts — 内部异常精确触发序列：计算 victim PC、EPC/BD，覆盖对齐/越界/MMIO 宽度/取指异常与溢出；RI 在分支延迟槽使用共享 catalog 的 `.word` raw word；用 handler aux 回读 Timer 前后状态捕获内部副作用；syscall 后置 mult/div/mthi/mtlo 接受完整旧/新 HI/LO 允许态，拒绝撕裂结果与未修改半部损坏，不从最终值推断内部启动时刻
  courseTesting/builtinAsm/p7/constants.ts — 课程映射常量：用户段 0x3000、异常入口 0x4180、DM 探针区 0x2800(8 words/场景)、Timer 0x7f00-0x7f1c、外部中断应答 0x7f20、magic 0xc0a70001

logisim/verilog-observer:
  courseTesting/dmStoreCheck.ts — 从 builtin CommitEvent 读取目标 word、byteMask、有效 lane 值，与 CO_DM_STORE 公开事务逐笔对拍；独立于 GPR 写回时序，忽略禁用 lane 的 X/Z 或任意值，补齐整字结果相同时的地址/mask 漏检；原始地址按 DM 所指 word 解释，SW/SH 文档允许忽略的低位不被要求为零；legacy 无结构化事件时仍保留 testbench 端口契约检查
  resources/templates/verilog/dm_store_contract.v — P6/P7 共享有效 DM 写观察块：记录原始 PC/地址/word/byte-enable/data，仅有效写校验有意义地址位、对应 store opcode、mask 和使能 lane 的已知值；SW 忽略低两位、SH 忽略 bit0（包括 X/Z），独立 word 字段保留被原始十六进制 X 掩盖的有效地址位；出错经现有仿真诊断报告。无有效写的 PC/地址以及未使能数据不作断言，不读取 DUT 内部信号
  courseTesting/logisimTraceProfile.ts — P3 Logisim Trace profile：从 courseConfig 读取/校验 text base、ROM 容量、列顺序/宽度、halt 和 PC 监控策略
  courseTesting/logisimPrep.ts — LogisimPrepareCaseResult、preparedCircuitFileName
  courseTesting/logisimTrace.ts — 电路分析(XML 端口标注/label 推导/appearance 排序)、Trace 解析(TTY table->CpuTraceEvent)、识别源码已有停机尾并以自环首条计算 halt PC、PC 监控自动 kill、Fetch 校验；GRF 写先检查已知目标寄存器，仅非零目标要求 regdata 已知，丢弃 $0 写中的 X/Z，保留非零目标的零值写
  courseTesting/p7ProbeCheck.ts — P7 黑盒精确检查：严格解析 DM Trace 并按物理顺序重建完整记录，拒绝未知/重复字段、0x2fff 之外 DM 写及任一 eret 后 poison 写；要求 Status 精确为 0x1c03，新生成 packed replay 在记录窗口内独立采样第二次 Status（兼容旧 metadata），并校验 Cause 未实现位、ExcCode/IP/BD、EPC、HI/LO、Timer 前后状态、异常 victim 无提交、handler 前后精确 commit 及外部 arm/raise/ack 顺序；期望提交 PC 上的额外错误值/目标/种类写回也会失败
  resources/templates/verilog/p7_probe_invalid_store_observer.v + p7_probe_invalid_store_case.v — 仅通过公开的 m_inst_addr/m_data_byteen/m_int_byteen 观察 AdES victim；若无效 store 仍产生任一 byte-enable，输出 invalid_store_effect 并令 Probe 失败

case-storage:
  asmCaseStore.ts — 持久化：createAsmCaseFromAsm/FromText（新 case 写 manifest v2）、prepareAsmCaseMachineCode（经 assembler provider）、artifact 管理、manifest 列表（v1/v2 兼容读取）；v1 严格只读。初始 metadata 与首次 manifest 合并，artifact write/copy 直接复用已持有 bytes 计算 path/bytes/SHA，不再回读刚写目标，并可将 snapshot-derived metadata 合入同一次提交；同一 workspace/session 的 builtin engine registry 成功注册有 64 项节点身份复验缓存，exact replay 仍重新按内容验证。创建时捕获完整 SourceUnit/include graph，后续汇编/oracle 只读取 case 内 immutable materialization；root/stdin/artifact/manifest 均以同句柄有界读取；manifest discovery 流式枚举并限制 2048 个条目与 16 MiB manifest 总量
  courseTesting/continuousCaseRetention.ts — 连续 case 的所有权与保留策略：同一 manifest 的终态写入、取消标记、通过产物裁剪串行执行，并统一校验 session/state/builtin provenance/containment；清理捕获并复验目录/manifest identity 与内容，原子移入受控 `.co/trash` 后复验 exact manifest 才删除，所有不确定状态 fail-closed 保留；失败删除进入 64 项有界后续回收队列，ASM 发现排除 trash
  asmCaseStoreCore.ts — Manifest Schema(v1)：caseId(ISO+SHA256 前 8 位)、.co/cases/{caseId}/、sha256Bytes/sha256Text、machineCode.haltPc、manifest-only P7 metadata；v1 永久只读兼容
  src/pathContainment.ts — case 路径包含审计：realpath/lexical 双重包含、symlink/junction 拒绝、大小写折叠检测；供 replay 与 case-storage 复用（不可信路径 fail-closed）
  courseTesting/manifestCodec.ts — Manifest v2 codec：program/oracle/artifacts typed alias、只接受 canonical `/` 的严格 case-relative 路径、完整 source artifact closure、assembler/oracle launch tuple、stdin/device/cycle/stop/seed/resource input、snapshot 数量/单项/总量 ceiling、大小写碰撞、symlink/bytes/hash/ProgramImage/HexText/trace evidence 校验；`p7.probe` 在 canonicalize 前以迭代式 depth/node/key/string-byte ceiling 验证。早期 v2 可读但不能 replay。exact replay/re-evaluate 见 mips-replay 模块

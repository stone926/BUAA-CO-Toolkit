# course-testing | src/courseTesting/ 35 files + host adapters

P3-P7 自动化测试：生成 ASM -> 稳定版修改 MARS dump/黄金 Trace -> ISim/Logisim 仿真 Trace -> 对比/Probe 检查 -> HTML/JSON 报告
MARS 黄金模型：兼容基线固定为已发布的 Mars-with-BUAA-CO-extension v0.6.3（8b53a49）。课程 oracle 运行一律强制 coL2；coL1 只在工具链检查中作为兼容能力探针。非 P7 另依赖 FixedCompactLargeText/CompactLargeText，P7 另依赖 efc、p7irq、cl 与 CompactLargeText；固定 ae/se 令汇编与运行错误以非零退出码失败。课程 dump 先静态确认最终 `_co_test_end` 是自分支+nop，运行时再用 coL2 逐指令块确认该自分支确实执行，并用 MARS 原生 max-step 结束永久自环；不依赖未发布的专用停机 marker。SWL/SWR 按动态指令合并同一 DM 字的多次局部写入；BGEZAL/BLTZAL 按 MIPS 规范补齐分支自身在 not-taken 路径遗漏的 `$31=PC+8` Trace，但稳定版 MARS 的后续执行状态仍是旧值，因此在显式重写 `$31` 前继续读取会被拒绝。同一详细 Trace 还只拒绝实际执行到的 oracle 初态差异/未定义行为。同次汇编仍分块 dump 0x0000..0x2fff，以拒绝与硬件全零 DM 复位不一致的非零 `.data` 初值；内置生成器约束普通测试数据，手写/外部用例须自行遵守教程地址映射和下述稳定版边界，不假定 MARS 提供额外的课程地址或 handler 契约开关
生成程序边界：配置的 instruction_count 只统计修改版 MARS 最终执行的 payload；P3-P7 内置生成器统一追加 `_co_test_end` 自分支+nop，手选/外部 ASM 的最终用户 `.text` 也必须自带同一尾部。教程硬件 IM 是 4096 words，但稳定版 MARS v0.6.3 把 Compact* 的 0x6ffc 上界当作排他值，因此课程 oracle 最终机器码上限为 4095 words（0x3000..0x6ff8）
P7 模式：anchor(精确对拍+中断注入)、probe(DM 探针黑盒检查)、hybrid(两者)、off(无中断)

orchestration:
  courseTest.ts — 总调度：14 个 co.test.* 命令；runCourseTraceCase 串联 assemble provider->oracle provider->ISim/Logisim DUT->compare，并分流 P7 probe；阶段 1 默认 provider 仍为 legacy MARS
  courseTestCases.ts — CourseTraceCaseInput 类型、failedCase 构造
  courseTestContinuous.ts — 持续生成循环：启动阶段同步占位防重复会话，启动检查期间也可取消；每轮生成并展开全部 ASM；stopOnFailure=false 时功能失败继续，生成器异常/无新 ASM 则停止；轮数耗尽不额外等待，停止请求可打断间隔或在途外部工具，用户取消的未完成 case 不计为测试 error；面板关闭触发停止，最终报告写失败也保证释放会话；按策略保留通过产物和报告轮次
  courseTestMessages.ts — diffMessage 中文提示、marsStageFailureMessage
  courseTestReport.ts — HTML 报告：批量/Logisim 准备/持续监控/ASM 索引；读取时兼容旧 mars/sim/logisim 字段，新结果只使用 oracle/dut；legacy logisimOut 只解释为原始 CLI 输出，不伪装成已解析 DUT trace
  courseTestToolchain.ts — 稳定版能力校验：P7 须 CompactLargeText，非 P7 须 FixedCompactLargeText 或 CompactLargeText；启动前用 coL1/coL2 兼容探针验证输出可解析及 Compact 初始 `$gp=0x1800`、`$sp=0x2ffc`，实际课程 oracle 只运行 coL2；P7 另验证 efc/p7irq，RI 用例运行时使用 cl 加载插件内置指令类；不要求未发布的课程取指域、数据桥或 handler 契约能力
  courseTestLogisim.ts — P3 Logisim：电路诊断(提取 Trace 端口映射)->ROM 注入批量准备->单用例(CLI 启动->PC 监控->自动 kill->Trace 解析->对拍)，准备前校验稳定版 MARS coL2，并在启动 Logisim 前执行 oracle 初态兼容检查
  courseTestStdin.ts — stdin 文件发现：input/inputs/test/data 目录，按文件名相似度排序
  courseTestTraceFiles.ts — 输出命名：.co/out/{stem}.mars.out、.co/out/{stem}.sim.out

generation:
  courseTesting/batchRunner.ts — 批量课程 Trace case 调度、结果汇总和 trace-batch-report.json 写入；新报告固定 schemaVersion 2 与 assemble/oracle/dut/compare/probe 中立 stage
  courseTesting/generatorWorkflow.ts — 生成器工作流：外部/内置 generator setup、运行、ASM 产物收集、CourseTraceBatchSource 描述
  courseTesting/traceRunner.ts — 单 case 执行：课程 dump 机器码校验、稳定版 MARS/ISim/Logisim、P7 probe 和 manifest metadata；用 coL2 逐指令块校验实际到达标准停机尾、合并 SWL/SWR 局部写、修复 REGIMM 链接分支自身的遗漏事件，并拒绝未跳转链接分支后继续读取旧 `$31`、稳定版 `$gp/$sp` 初态差异、DivZero/JalrSame/DoubleDelay/未定义 HI/LO 读取及链接分支读取 `$31` 的 UNPREDICTABLE 输入；任一侧空 Trace 报错，两侧都空明确标记为无法判定
  mips/legacy/marsOracleCompatibility.ts — legacy/reference 层的 P3-P7 稳定版 MARS oracle 兼容检查；coL2 动态跟踪 `$gp/$sp` 是否已显式初始化并重建访存有效地址，拒绝 signed EA 溢出和 Compact* 中课程硬件不存在的数据段；P7 对 efc 处理异常时不输出 victim 指令头的情况增加保守静态兜底
  mips/legacy/marsImageCompatibility.ts — legacy/reference 层将每个 coL2 动态 PC/机器码绑定到最终硬件 HexText（含 P7 padding/handler merge），并只允许 handler 内精确 `sb $0,0x7f20($0)` 访问 IG；用跨分支/跳转及延迟槽的静态常量数据流兜底无 victim header 的非对齐 IG 访问
  courseTesting/builtinAsmGenerator.ts — 入口：generateBuiltinAsmTestCase；P7StressMode 分派(anchor->randomBody、probe->probeEmitter、hybrid 两次调用)
  courseTesting/generator.ts — 外部生成器(.py/.js/.jar/.ps1/.bat 等)和 ASM 文件快照；以 mtime+ctime+size 判定新建/重写，能识别同 mtime、倒退 mtime 或尺寸变化，跳过 .co 产物目录
  courseTesting/generatorInstructionCatalog.ts — 加载由唯一 ISA catalog 生成的内置 ASM generator profile、分类、对齐和 MDU 延迟投影；生成脚本校验成员资格与 instruction effects/control/memory facts 一致
  courseTesting/machineCodeValidation.ts — 对最终 HexText 使用 core catalog canonical decoder（不再维护 opcode/funct 副本），先校验教程 IM 的 4096-word 物理容量及稳定版 oracle 的 4095-word 排他上界，再校验保留字段、CP0 rd/方向与课程 profile 指令白名单；手写/外部 ASM 只允许默认课程集，只有 case manifest 证明来源为内置生成器时才采纳匹配的 `# instruction_set` 声明；P7 内部 RI 探针仅特许机器码 0x0000003f
  courseTesting/courseDataInitialization.ts — 课程 DM 初态预检：按修改版 MARS 的 4 KiB 分配块在同次汇编导出 0x0000..0x2fff，严格解析每个非空 1024-word HexText 块；允许未分配/`.space` 全零块，首个非零初值或缺失/畸形 dump 立即失败
  courseTesting/executionBudget.ts + mips/legacy/haltValidation.ts — provider-neutral pipeline 计算确定性执行预算；legacy/reference 层单独解析 coL2/停机标记，确认标准停机尾已实际执行并拒绝 cliff exit、错误自环和未到达尾部
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
  courseTesting/builtinAsm/randomBody.ts — 核心随机引擎(约 2100 行)：课程 DM 内的对齐访存、正/负偏移、分支双路径与有界控制流、稳定版 MARS 局部字访问；所有普通随机路径均避免有符号溢出、未初始化 HI/LO、除零等非法输入，P7 只通过受控场景制造异常；payload 后生成停机尾
  courseTesting/builtinAsm/programWriter.ts — ProgramWriter：label/emit/raw 累积汇编行并跟踪 PC
  courseTesting/builtinAsm/types.ts — P7StressMode、场景 kind/variant、按序 CP0 期望、精确 retry commit、完成标记与 P7ProbeMetadata

p7-probe:
  courseTesting/builtinAsm/p7/probeAsm.ts — 安全噪声填充、中断启停、Timer 清零、立即数/探针状态写入等辅助原语
  courseTesting/builtinAsm/p7/probeEmitter.ts — Probe 主程序和统一异常处理程序生成；每场景 guard->触发/中断窗口->完成标记，写入单个 8-word 物理记录；中断优先级重放把第二次 Cause/EPC 打包进 aux，Timer 清零和 HI/LO 精确观测也通过 aux 返回
  courseTesting/builtinAsm/p7/probeExternalScenarios.ts — 外部中断的真实受害位置与重试路径：store、load-use 依赖、jal、已取分支延迟槽 store；描述必须且仅能在异常处理后出现一次的 GPR/DM 提交
  courseTesting/builtinAsm/p7/probeScenarios.ts — 场景 kind 规划：先覆盖启用的 external/timer/异常类别，再依据变体数量补齐轮换，最后按强度加权填充并随机截取
  courseTesting/builtinAsm/p7/probeVariants.ts — 场景变体目录和最小覆盖计数：外部优先级/等待/四类重试，AdEL/AdES 地址与访问宽度边界（含 Timer0/1 CTRL/PRESET 的 sb/sh 与 COUNT sw），syscall 延迟槽及年轻 MDU，Ov add/addi/sub
  courseTesting/builtinAsm/p7/probeVictims.ts — 内部异常精确触发序列：计算 victim PC、EPC/BD，覆盖对齐/越界/MMIO 宽度/取指异常与溢出；用 handler aux 回读 Timer 前后状态捕获内部副作用；syscall 后置 mult/div/mthi/mtlo 用 HI/LO 哨兵验证年轻 MDU 指令不得启动
  courseTesting/builtinAsm/p7/constants.ts — 课程映射常量：用户段 0x3000、异常入口 0x4180、DM 探针区 0x2800(8 words/场景)、Timer 0x7f00-0x7f1c、外部中断应答 0x7f20、magic 0xc0a70001

logisim/verilog-observer:
  courseTesting/logisimTraceProfile.ts — P3 Logisim Trace profile：从 courseConfig 读取/校验 text base、ROM 容量、列顺序/宽度、halt 和 PC 监控策略
  courseTesting/logisimPrep.ts — LogisimPrepareCaseResult、preparedCircuitFileName
  courseTesting/logisimTrace.ts — 电路分析(XML 端口标注/label 推导/appearance 排序)、Trace 解析(TTY table->CpuTraceEvent)、识别源码已有停机尾并以自环首条计算 halt PC、PC 监控自动 kill、Fetch 校验
  courseTesting/p7ProbeCheck.ts — P7 黑盒精确检查：严格解析 DM Trace 并按物理顺序重建完整记录，拒绝未知/重复字段和 0x2fff 之外 DM 写；要求 Status 精确为 0x1c03、Cause 未实现位为 0，并校验 ExcCode/IP/BD、EPC、HI/LO、Timer 清零/异常前后回读一致、异常 victim 无提交、handler 后唯一完成/retry commit，以及外部 arm/raise/ack 顺序
  resources/templates/verilog/p7_probe_invalid_store_observer.v + p7_probe_invalid_store_case.v — 仅通过公开的 m_inst_addr/m_data_byteen/m_int_byteen 观察 AdES victim；若无效 store 仍产生任一 byte-enable，输出 invalid_store_effect 并令 Probe 失败

case-storage:
  asmCaseStore.ts — 持久化：createAsmCaseFromAsm/FromText（新 case 写 manifest v2）、prepareAsmCaseMachineCode（经 assembler provider）、artifact 管理、manifest 列表（v1/v2 兼容读取）；v1 严格只读。创建时捕获完整 SourceUnit/include graph，后续汇编/oracle 只读取 case 内 immutable materialization；原 workspace 路径仅作 provenance。dump 后保存 serialized ProgramImage、observability、DUT exact bytes；oracle 后保存完整 run input 与 raw/event/final-state digest。新 artifact 必须先复制到 case 内并记录相对路径/bytes/SHA-256，非文件 provenance 进入独立 metadata。root/stdin/artifact/manifest 均以同句柄有界读取；manifest discovery 流式枚举并限制 2048 个条目与 16 MiB manifest 总量
  asmCaseStoreCore.ts — Manifest Schema(v1)：caseId(ISO+SHA256 前 8 位)、.co/cases/{caseId}/、sha256Bytes/sha256Text、machineCode.haltPc、manifest-only P7 metadata；v1 永久只读兼容
  courseTesting/manifestCodec.ts — Manifest v2 codec：program/oracle/artifacts typed alias、只接受 canonical `/` 的严格 case-relative 路径、完整 source artifact closure、assembler/oracle launch tuple、stdin/device/cycle/stop/seed/resource input、snapshot 数量/单项/总量 ceiling、大小写碰撞、symlink/bytes/hash/ProgramImage/HexText/trace evidence 校验；`p7.probe` 在 canonicalize 前以迭代式 depth/node/key/string-byte ceiling 验证。早期 v2 可读但不能 replay。exact replay/re-evaluate 见 mips-replay 模块

conformance/phase-0:
  conformance/mips/corpus — P3–P7 spec microprogram、challenge、教程引用、250 个固定 seed 与机器可读 feature distribution；seed renderer 独立生成 250 个唯一 source graph/HexText image（合计 5,000 words），先由固定 MARS 分 profile 汇编核对，再经编译后的 versioned JSONL CLI 全量 encode/decode；freeze verifier 防 silent corpus drift
  conformance/mips/contract/evidence-gates.json — revision 2 冻结 22 个 P3–P7 capability scope、589 个由 `idPrefix.member` 精确展开的 bin、逐 bin 数字 minimum 与 assembly/execution/device/full-stack 各自的 fingerprint inclusion/exclusion
  conformance/mips/expected — 人工 courseVector 与 ISA golden 使用独立 schema；`manage-*.mjs --refresh-integrity` 会强制把内嵌 approval 声明降级回 candidate，因此 artifact 永远保持 candidate 形态，不存在单独的批准步骤
  conformance/mips/bench — 固定 Windows Server 2025 / Ubuntu 24.04 runner 的 cold benchmark matrix、统计与 candidate 校验；baseline 仅来自受保护 main 的 CI dispatch
  conformance/mips/decision-vectors — frozen contract/decision 的独立 vectors；Timer official-RTL lane 在缺少 Icarus 时必须由 required CI 失败而不是跳过伪通过
  conformance/mips/governance — 只保留 2026-08-27 审阅记录与归档的历史 approval 信封（provenance）；approval 机制已随单人维护放宽撤销
  conformance/mips/expected/guardedFs.mjs — expected-data 依赖闭包唯一文件系统入口；lexical/realpath 均限制在 conformance/mips，dependency whitelist 同时禁止 direct fs、dynamic import、child_process 等旁路读取 production catalog/contracts
  gate — `npm run verify` 聚合全部检查（候选与正式层已于 2026-08-27 合并）；Timer RTL lane 只在装有 Icarus 的环境（CI）通过

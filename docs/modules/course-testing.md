# course-testing | src/ | 30 files

P3-P7自动化测试: 随机ASM生成->MARS dump->MARS golden trace->ISim/Logisim仿真trace->对比->HTML报告
P7模式: anchor(精确对拍+中断注入), probe(DM探针0x2800黑盒检查), hybrid(两者), off(无中断)

orchestration:
  courseTest.ts — 总调度: 14个co.test.*命令, runCourseTraceCase串联全流程(dump->MARS->ISim/Logisim->compare), P7 probe分流
  courseTestCases.ts — CourseTraceCaseInput类型, failedCase构造
  courseTestContinuous.ts — 持续测试循环: 定时生成->展开->执行->监控面板+JSON报告, 按留存策略自动清理
  courseTestMessages.ts — diffMessage中文提示, marsStageFailureMessage
  courseTestReport.ts — HTML报告: 批量/Logisim准备/持续监控/ASM索引
  courseTestToolchain.ts — 内存配置校验: P7须CompactLargeText, 非P7须FixedCompactLargeText或CompactLargeText
  courseTestLogisim.ts — P3 Logisim: 电路诊断(提取Trace端口映射)->ROM注入批量准备->单用例(CLI启动->PC监控->自动kill->trace解析->对拍)
  courseTestStdin.ts — stdin文件发现: input/inputs/test/data目录, 按文件名相似度排序
  courseTestTraceFiles.ts — 输出命名: .co/out/{stem}.mars.out, .co/out/{stem}.sim.out

generation:
  courseTesting/generatorWorkflow.ts — 生成器工作流: 外部/内置generator setup、运行、ASM产物收集、CourseTraceBatchSource描述
  courseTesting/traceRunner.ts — 单个课程 Trace case 的 MARS/ISim/Logisim 执行、P7 probe 校验和 P7 manifest metadata 解析
  courseTesting/builtinAsmGenerator.ts — 入口: generateBuiltinAsmTestCase, p7StressMode分派(anchor->randomBody, probe->probeEmitter, hybrid两次调用)
  courseTesting/generator.ts — 外部生成器: .py/.js/.jar/.ps1/.bat, snapshotAsmFiles(mtime快照)
  courseTesting/generatorInstructionCatalog.ts — 内置 ASM 生成器指令 profile、分类、对齐和 MDU 延迟资源加载
  courseTesting/cpuState.ts — 软件CPU模型: 32GPR+256word DM+HI/LO+CP0(SR/Cause/EPC)+MDU保护, 按字节/半字/字读写, 最近写入追踪
  courseTesting/mnemonicSets.ts — Profile指令集(P3:8条,P4-5:+J型,P6:+MDU/load-store变体,P7:+CP0/异常), 功能分组(分支/load-store/MDU/CP0), memoryAlignment/mduBusyCycles
  courseTesting/p7Hardware.ts — P7 硬件布局单一入口: 加载/校验 resources/co/p7Hardware.json, 导出异常入口/Timer/CP0/probe/testbench容量常量
  courseTesting/random.ts — 32位xorshift伪随机: int(min,max)/chance/pick, hashSeed
  courseTesting/mipsUtil.ts — appendHaltLoop(停机自环), 符号扩展, 立即数格式化
  courseTesting/continuous.ts — ContinuousRunStatus/Counts, 按留存轮数裁剪

builtin-asm:
  courseTesting/builtinAsm/asmTemplates.ts — 从 resources/asm/*.asm 加载 P7 异常处理模板并做受控变量插值
  courseTesting/builtinAsm/facade.ts — 高层API: generateBuiltinAsmTestCase/resolveBuiltinInstructionSet
  courseTesting/builtinAsm/randomBody.ts — 核心引擎(1860行): 状态感知指令生成, 合法操作数选取, MDU忙周期保护, P7 anchor中断调度, 异常率控制
  courseTesting/builtinAsm/programWriter.ts — ProgramWriter类: label/emit/raw累积汇编行, 跟踪PC
  courseTesting/builtinAsm/types.ts — P7StressMode, P7ProbeScenarioKind, P7ProbeMetadata, P7ProbeOptions

p7-probe:
  courseTesting/builtinAsm/p7/probeAsm.ts — 辅助原语: 安全噪声填充, 中断启/禁用, Timer清零
  courseTesting/builtinAsm/p7/probeEmitter.ts — 场景代码生成: prologue(关中断/清定时器/初始化探针区), 场景循环(guard->状态写入->异常触发/中断窗口->done), 统一异常处理程序(.ktext, 8-word DM探针日志), guard子程序
  courseTesting/builtinAsm/p7/probeScenarios.ts — planProbeScenarioKinds: external×4/timer0×6/timer1×6/异常×2, 随机排序截取, 不足加权填充
  courseTesting/builtinAsm/p7/constants.ts — 内存映射: 用户0x3000, 异常入口0x4180, 探针0x2800(8 words/场景), Timer 0x7f00-0x7f1c, magic 0xc0a70001

logisim:
  courseTesting/logisimTraceProfile.ts — P3 Logisim trace profile: 从courseConfig读取/校验text base、ROM容量、列顺序/宽度、halt和PC监控策略
  courseTesting/logisimPrep.ts — LogisimPrepareCaseResult, preparedCircuitFileName
  courseTesting/logisimTrace.ts — 电路分析(XML端口标注/label推导/appearance排序), Trace解析(TTY table->CpuTraceEvent), PC监控(到达停机PC自动kill), Fetch校验(逐拍比对instr列)
  courseTesting/p7ProbeCheck.ts — 黑盒验证: 从ISim DM写事件重建探针记录, 逐场景检查kind/ExcCode/Cause.IP/EPC/时序

case-storage:
  asmCaseStore.ts — 持久化: createAsmCaseFromAsm/FromText, prepareAsmCaseMachineCode, artifact管理(update/write/copy), listAsmCaseManifests；P7 metadata 只来自 manifest/显式参数
  asmCaseStoreCore.ts — Manifest Schema(v1): caseId(ISO+SHA256前8位), .co/cases/{caseId}/, sha256Bytes/sha256Text, manifest-only P7 metadata

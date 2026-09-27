# hazard-analysis | src/ | 14 files

P5–P7 内置冲突冒险分析：汇编 / 机器码 → 内置 MIPS 动态执行 → 课程 AT 流水线模型 → 可筛选 Webview + 版本化 JSON。运行时无 Java、Python、Hazard-Calculator 依赖，P7 使用 P6 覆盖评分表。

分析循环（无 VS Code 调用或输入文件访问；静态课程事实与测试生成器共用）：

  hazardAnalysis/machineCode.ts — 有界 HexText / Logisim v2 raw（含重复压缩）/ COE 解析；原始行号错误、32 位字与 4096-word 容量检查
  hazardAnalysis/analyzer.ts — ProgramImage 动态执行与汇总；分片让出事件循环、取消、100000 默认步数上限；仅保留有界事件示例，全部事件参与汇总
  hazardAnalysis/reportTypes.ts — 原生报告 v1 DTO：终止原因、覆盖、类别分数、事件、警告与 image fingerprint
  hazardAnalysis/courseHazardTheory.ts — 课程 P5/P6 类别表、元组上限与 60+40·k/K 评分；缺席类别计 0、无目标类别不参与平均
  hazardAnalysis/hazardInstruction.ts — ISA 目录和生成器 ASM 到寄存器读写、HI/LO 事实的适配
  hazardAnalysis/hazardTiming.ts — 指令类别、Tuse、就绪级和 MDU 时延
  hazardAnalysis/hazardPipeline.ts — 动态流的 D 级阻塞、首次转发及有效性、优先级、$0、HI/LO 观察；数据阻塞和 MDU 等待分开
  hazardAnalysis/hazardCoverage.ts — 课程四元组/三元组键与生成器类别覆盖；上述模型由测试生成器共同复用

宿主与界面：

  hazardUi/input.ts — 当前文件/选择文件与有界读取；ASM 固定内置汇编，保存取消或汇编失败即停止；保留 data/sourceMap，不回退旧机器码
  hazardUi/workflow.ts — 进度通知、取消、同工作区分析互斥、保存和重开；扩展退出取消运行并关闭面板
  hazardUi/reportValidation.ts — 导入报告的字段类型、枚举、数值和集合上限检查
  hazardUi/reportStore.ts — `.co/hazard/<源文件名>-<路径hash>-hazard.json` 原子保存；同源更新、不同源独立保留；4 MiB 有界读取，只发现该目录的最近报告
  hazardUi/panel.ts — Webview 生命周期及固定 reanalyze/openInput/openJson 操作；消息不能提供文件路径或命令
  hazardUi/reportView.ts — 中文主题自适应报告，课程覆盖/评分/有效率、类别矩阵、事件筛选和改进建议；不可信文本转义、nonce CSP；模板在 `resources/templates/hazard/`

边界：只统计实际执行路径。正常顺序到代码末尾、课程停机循环、步数截断、越出定义域和取消分别标记；Timer 无真实周期调度时不伪造设备行为。周期是课程模型估算，不是 DUT 测量值，也不证明 CPU 正确。原外部工具 JSON 不作为新版报告导入，需用原始输入重新分析。

验证：`src/test/hazard.test.ts` 覆盖宿主输入/保存/取消/固定内置选择/报告重开与消息白名单；`src/test/hazardReportView.test.ts` 覆盖渲染与注入；`src/test/hazardAnalysis/` 覆盖解析、动态路径、数据/MDU 冲突与资源上限；原 `builtinHazardGeneration.test.ts` 继续验证共享模型。

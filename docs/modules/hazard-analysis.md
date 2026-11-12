# hazard-analysis | src/ | 18 files

P5–P7 内置流水线冲突分析：汇编/机器码 → 内置 MIPS 动态执行 → 课程 AT 流水线模型 → 可筛选 Webview + 版本化 JSON。运行时无 Java、Python 或外部 Hazard-Calculator 依赖；P7 复用 P6 覆盖评分表。

## 核心设计决策

**只统计实际执行路径。** 分析跑在真实执行流上，因此被跳过路径、异常受害者冲刷与调用返回重排天然被排除在覆盖统计之外。正常顺序到代码末尾、课程停机循环、步数截断、越出定义域与取消分别标记终止原因；Timer 无真实周期调度时不伪造设备行为。

**课程模型是共享事实。** 类别表、Tuse、就绪级、MDU 时延与覆盖分箱被分析器和自动测试生成器（`courseTesting/builtinAsm/hazard/`）共同复用，避免两套模型漂移。周期是课程模型估算，**不是** DUT 测量值，也不证明 CPU 正确。

**课程计分与完整细分分开。** 原 107/15（P5）、1036/110（P6/P7）计分键保持兼容；新报告另存全流计数与助记符/端口/动态间隔键，优先级含旧、新生产者身份。每个阻塞周期保留课程主因，同时记录全部参与端口的原因，不能把原因数当成额外阻塞周期。`events` 只是有界实例，截断不影响完整计数；每组细分键最多 2048 项，清单截断单独标记，没有虚构的可行组合分母。

**值差与效果敏感性分开。** 课程 `valid` 只表示转发值不同于旧 GRF 值。额外检查在实际提交前替换一个源端口或 HI/LO 半部，复用纯执行语义比较当前指令的架构效果，分为效果改变/效果不变/未评估。只访问普通 RAM，不提交状态或设备事务；设备、未定义或不支持语义明确为未评估。这不是整程序的故障检出率或周期级 RTL 证明。

**保存用例保留执行上下文。** 分析 `.co/cases/<id>` 中的主 ASM、物化主 ASM 或完整机器码时，定向验证 manifest、源码闭包、映像及所选文件的一致性，复用保存映像（含 data/ktext）并载入原外部 IRQ 调度；已有 oracle 配置/timeline/hash 必须一致。文件改动、阶段冲突或不一致拒绝分析，不能静默继承旧调度。普通 P7 输入明确没有 IRQ；依赖 DUT 周期的 probe 不冒充可重放的顺序用例，Timer 无时间线时仍不可分析。

**历史兼容。** 原生报告继续使用 v1，细分统计和执行上下文为可选字段；旧报告显示“未采集”，不填成零。新增字段有结构、计数、长度和清单上限校验，报告仍受 4 MiB 导入限制。

## 分析循环（无 VS Code 调用、无输入文件访问）

- `hazardAnalysis/machineCode.ts` — 有界 HexText / Logisim v2 raw / COE 解析与容量检查
- `hazardAnalysis/analyzer.ts` — ProgramImage 动态执行与汇总；分片让出、取消、步数上限，仅保留有界事件示例
- `hazardAnalysis/hazardPipeline.ts` — 动态流上的 D 级阻塞、首次转发及有效性、优先级、`$0` 与 HI/LO 观察（数据阻塞与 MDU 等待分开）
- `hazardAnalysis/courseHazardTheory.ts` — P5/P6 类别表、元组上限与 `60+40·k/K` 评分
- `hazardAnalysis/hazardTiming.ts` — 指令类别、Tuse、就绪级与 MDU 时延
- `hazardAnalysis/hazardInstruction.ts` — ISA 目录与生成器 ASM 到寄存器读写/HI-LO 事实的适配
- `hazardAnalysis/hazardCoverage.ts` — 课程四元组/三元组键与生成器类别覆盖
- `hazardAnalysis/detailedStats.ts` — 全流分类计数与有界具体助记符/端口/优先级键汇总
- `hazardAnalysis/observability.ts` — 不影响真实执行的单消费者反事实效果检查与设备隔离
- `hazardAnalysis/reportTypes.ts` — 原生报告 v1 DTO

## 宿主与界面

- `hazardUi/input.ts` — 文件对话框选择与有界读取（详见上文设计决策）
- `hazardUi/caseInput.ts` — 保存用例的源码/映像/IRQ 完整性与原始执行上下文加载
- `hazardUi/workflow.ts` — 进度通知、取消、同工作区分析互斥、保存与重开
- `hazardUi/reportStore.ts` — `.co/hazard/<源文件名>-<路径hash>-hazard.json` 原子保存与有界读取
- `hazardUi/reportValidation.ts` — 导入报告的字段/枚举/数值/集合上限检查
- `hazardUi/panel.ts` — Webview 生命周期与固定 reanalyze/openInput/openJson 操作；消息不能提供文件路径或命令
- `hazardUi/reportView.ts` — 中文主题自适应报告（覆盖/评分/有效率、类别矩阵、事件筛选、改进建议），不可信文本转义 + nonce CSP
- `hazardUi/detailView.ts` — 完整细分统计、三态效果检查、执行上下文与旧报告缺数据说明

报告模板在 `resources/templates/hazard/`。

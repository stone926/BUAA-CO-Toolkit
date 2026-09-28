# hazard-analysis | src/ | 14 files

P5–P7 内置流水线冲突分析：汇编/机器码 → 内置 MIPS 动态执行 → 课程 AT 流水线模型 → 可筛选 Webview + 版本化 JSON。**运行时无 Java、Python 或外部 Hazard-Calculator 依赖**；P7 复用 P6 覆盖评分表。

## 核心设计决策

**只统计实际执行路径。** 分析跑在真实执行流上，因此被跳过路径、异常受害者冲刷与调用返回重排天然被排除在覆盖统计之外。正常顺序到代码末尾、课程停机循环、步数截断、越出定义域与取消分别标记终止原因；Timer 无真实周期调度时不伪造设备行为。

**课程模型是共享事实。** 类别表、Tuse、就绪级、MDU 时延与覆盖分箱被分析器和自动测试生成器（`courseTesting/builtinAsm/hazard/`）共同复用，避免两套模型漂移。周期是课程模型估算，**不是** DUT 测量值，也不证明 CPU 正确。

**宿主输入不猜。** 输入来自系统文件对话框，不自动采用活动文件、不扫描工作区；ASM 固定走内置汇编，保存取消或汇编失败即停止，且不回退旧机器码。

## 分析循环（无 VS Code 调用、无输入文件访问）

- `hazardAnalysis/machineCode.ts` — 有界 HexText / Logisim v2 raw / COE 解析与容量检查
- `hazardAnalysis/analyzer.ts` — ProgramImage 动态执行与汇总；分片让出、取消、步数上限，仅保留有界事件示例
- `hazardAnalysis/hazardPipeline.ts` — 动态流上的 D 级阻塞、首次转发及有效性、优先级、`$0` 与 HI/LO 观察（数据阻塞与 MDU 等待分开）
- `hazardAnalysis/courseHazardTheory.ts` — P5/P6 类别表、元组上限与 `60+40·k/K` 评分
- `hazardAnalysis/hazardTiming.ts` — 指令类别、Tuse、就绪级与 MDU 时延
- `hazardAnalysis/hazardInstruction.ts` — ISA 目录与生成器 ASM 到寄存器读写/HI-LO 事实的适配
- `hazardAnalysis/hazardCoverage.ts` — 课程四元组/三元组键与生成器类别覆盖
- `hazardAnalysis/reportTypes.ts` — 原生报告 v1 DTO

## 宿主与界面

- `hazardUi/input.ts` — 文件对话框选择与有界读取（详见上文设计决策）
- `hazardUi/workflow.ts` — 进度通知、取消、同工作区分析互斥、保存与重开
- `hazardUi/reportStore.ts` — `.co/hazard/<源文件名>-<路径hash>-hazard.json` 原子保存与有界读取
- `hazardUi/reportValidation.ts` — 导入报告的字段/枚举/数值/集合上限检查
- `hazardUi/panel.ts` — Webview 生命周期与固定 reanalyze/openInput/openJson 操作；消息不能提供文件路径或命令
- `hazardUi/reportView.ts` — 中文主题自适应报告（覆盖/评分/有效率、类别矩阵、事件筛选、改进建议），不可信文本转义 + nonce CSP

报告模板在 `resources/templates/hazard/`。原外部工具 JSON **不**作为新版报告导入，需用原始输入重新分析。

# BUAA CO Toolkit | VSCode extension for computer organization course (P0-P7)

入口: src/extension.ts activate()
LSP: src/server.ts (路由) + src/languageClient.ts (客户端)
架构: Client/Server IPC, TypeScript strict

子系统:
  orchestration   | docs/modules/orchestration.md   | 61 files | 扩展宿主层（命令/配置/UI/工具链；含 Logisim 与 hazard 命令注册）
  common-lsp      | docs/modules/common-lsp.md      | 7 files  | 共享 LSP 基础设施
  mips-lsp        | docs/modules/mips-lsp.md        | 34 files | MIPS 汇编语言支持
  mips-core       | docs/modules/mips-core.md       | 65 files | 纯 TS MIPS 引擎核心（课程与普通 MARS ISA/profile/assembler/machine/devices/events/debug）
  mips-debug      | docs/modules/mips-debug.md      | 19 files | 内置 MARS 调试工作台（VS Code 面板、状态投影与 Webview）
  mips-cli        | docs/modules/mips-cli.md        | 2 files  | 独立、版本化、有界 JSONL ISA/执行/设备接口
  mips-providers  | docs/modules/mips-providers.md  | 9 files  | Provider-neutral 引擎契约与不可变 CourseEnginePlan
  mips-host       | docs/modules/mips-host.md       | 13 files | 懒启动 Worker、普通 MARS syscall I/O、交互调试、真实 ISA batch 与 ACK 背压
  mips-replay     | docs/modules/mips-replay.md     | 9 files  | manifest v2 用例闭包、可信引擎注册表与证据校验
  verilog-lsp     | docs/modules/verilog-lsp.md     | 75 files | Verilog HDL 语言支持（子模块：verilog-ast 8、verilog-diagnostics 12）
  logisim-lsp     | docs/modules/logisim-lsp.md     | 2 files  | Logisim 电路文件
  hazard-analysis | docs/modules/hazard-analysis.md | 14 files | 内置流水线冲突分析与交互报告
  course-testing  | docs/modules/course-testing.md  | 74 files + host adapters | 自动化测试框架与失败定位、用例重跑
  waveform        | docs/modules/waveform.md        | 60 files | 内置 VCD 波形查看器（自定义编辑器 + 仿真并查看波形）
  conformance     | conformance/mips/               | 独立 Node 包：ISA golden、冻结执行语料与 JSONL 门禁；MARS 参考仅用于历史证据
  test-suite      | docs/modules/test-suite.md      | 260 files| Vitest 测试
  resources       | docs/modules/resources.md       | ~55 files + 5 bundled Icarus runtimes | 静态资源与生成源
  highlighting    | docs/modules/syntax-highlighting.md | 3 grammars | TextMate/semantic 分层高亮

数据流:
  MIPS: Text -> syntax.ts -> ast.ts -> semantic.ts -> parser.ts -> diagnostics, cache: parseCache.ts
  Verilog: Text -> lexer.ts -> statementParser.ts -> astParser.ts/exprAst.ts/blockAst.ts/proceduralAst.ts -> ast.ts -> semanticModel.ts -> diagnostics.ts 调度: syntaxDiag/lintDiag/instanceConnectionDiag/usageDiag/driverDiag/workspaceDiag, cache: parseCache.ts
  Waveform: 仿真并查看波形 -> runIverilog + 生成的 dump 顶层(GRF 逐字) -> .co/wave/<tb>.vcd -> 宿主流式解析为列式模型 -> Webview Canvas 渲染（esbuild 打包到 out/media），同名 .sim.out trace 叠加
  Test: SourceUnit immutable bundle -> 一次性 CourseEnginePlan -> assembler provider -> serialized ProgramImage/DUT bytes -> CourseTracePipeline -> 同一计划的 oracle provider -> bundled Icarus/Logisim DUT -> traceCompare -> HTML/JSON v2 report

自动测试与 P7:
  P2–P7 汇编使用内置 TypeScript 引擎；普通 MARS 控制台命令使用独立服务策略。P3–P7 手动与 automatic 课程执行固定 builtin-ts；automatic 使用最大 payload 规模，co.test.instructions 选择侧重点，co.test.concurrency 控制并发上限（默认 4，1–8）；旧 mars/verify-both 自动迁移
  P7 stress mode（内部类型，非用户设置）: anchor(TS课程oracle对拍+中断/Timer注入) / probe(DM探针黑盒检查) / hybrid(runner 展开为前两者，P7 automatic 固定取值) / off(P3–P6 固定取值，同时关中断与 Timer)；probe 为 DUT-only，不能冒充 full-stack reference evidence

专门文档:
  automatic-test-concurrency.md: 自动测试并发、编译/文件复用策略与真实 CPU 吞吐对比
  cpu-failure-workflow.md: 自动测试失败后的交互设计与实现边界
  diagnostic-catalog.md: MIPS/Verilog 诊断代码注册表（由 scripts/generate-diagnostic-catalog.mjs 生成，--check 校验漂移）
  syntax-coverage-matrix.md: 语法覆盖矩阵
  semantic-colors.md: 语义 token 分类与 VS Code 主题协作

代码约定: // @index role — brief
验证:
  日常门禁: npm run check:generated（生成物漂移）、node scripts/check-module-boundaries.mjs（mips-core 依赖边界）、node scripts/check-index.mjs（索引完整性）
  课程门禁: npm run verify:phase6 — 单元验证 + 独立 ISA/course vectors、255 个冻结用例的真实 JSONL 汇编/执行；不启动外部 MARS。普通 MARS 与 P7 syscall 隔离另由 `npm run verify:internal-mars` 验证

普通 MARS：ASM 运行、文件标准输入、伪终端与 P2 汇编全部经 mips-host Worker，复用 mips-core 汇编器与机器状态。课程 P7 CPU 的 `syscall` 只陷入 0x4180 内核，不执行普通服务，符合 tutorial P7-2-6。真实 VS Code 宿主另强制运行普通命令和 P3–P7 导出 smoke；不需要外部 MARS 或 Java。

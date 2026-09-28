# BUAA CO Toolkit | VSCode extension for computer organization course (P0-P7)

入口: src/extension.ts activate()
LSP: src/server.ts (路由) + src/languageClient.ts (客户端)
架构: Client/Server IPC, TypeScript strict

子系统:
  orchestration   | docs/modules/orchestration.md   | 58 files | 扩展宿主层（命令/配置/UI/工具链；含 Logisim 与 hazard 命令注册）
  common-lsp      | docs/modules/common-lsp.md      | 6 files  | 共享 LSP 基础设施
  mips-lsp        | docs/modules/mips-lsp.md        | 33 files | MIPS 汇编语言支持
  mips-core       | docs/modules/mips-core.md       | 41 files | 纯 TS MIPS 引擎核心（ISA/profile/assembler/machine/devices/events）
  mips-cli        | docs/modules/mips-cli.md        | 2 files  | 独立、版本化、有界 JSONL ISA/执行/设备接口
  mips-providers  | docs/modules/mips-providers.md  | 8 files  | Provider-neutral 引擎契约与不可变 CourseEnginePlan
  mips-host       | docs/modules/mips-host.md       | 5 files  | 懒启动 Worker、真实 ISA batch 与 ACK 背压
  mips-replay     | docs/modules/mips-replay.md     | 9 files  | manifest v2 用例闭包、可信引擎注册表与证据校验
  verilog-lsp     | docs/modules/verilog-lsp.md     | 68 files | Verilog HDL 语言支持（子模块：verilog-ast 8、verilog-diagnostics 12）
  logisim-lsp     | docs/modules/logisim-lsp.md     | 2 files  | Logisim 电路文件
  hazard-analysis | docs/modules/hazard-analysis.md | 14 files | 内置流水线冲突分析与交互报告
  course-testing  | docs/modules/course-testing.md  | 57 files + host adapters | 自动化测试框架
  waveform        | docs/modules/waveform.md        | 59 files | 内置 VCD 波形查看器（自定义编辑器 + 仿真并查看波形）
  conformance     | conformance/mips/               | 46 mjs   | 独立 Node 包：ISA golden、冻结执行语料、固定 MARS 引用与证据门禁（只能经 mips-cli 访问生产引擎）
  test-suite      | docs/modules/test-suite.md      | 222 files| Vitest 测试
  resources       | docs/modules/resources.md       | ~55 files + 5 bundled Icarus runtimes | 静态资源与生成源
  highlighting    | docs/modules/syntax-highlighting.md | 3 grammars | TextMate/semantic 分层高亮

数据流:
  MIPS: Text -> syntax.ts -> ast.ts -> semantic.ts -> parser.ts -> diagnostics, cache: parseCache.ts
  Verilog: Text -> lexer.ts -> statementParser.ts -> astParser.ts/exprAst.ts/blockAst.ts/proceduralAst.ts -> ast.ts -> semanticModel.ts -> diagnostics.ts 调度: syntaxDiag/lintDiag/instanceConnectionDiag/usageDiag/driverDiag/workspaceDiag, cache: parseCache.ts
  Waveform: 仿真并查看波形 -> runIverilog + 生成的 dump 顶层(GRF 逐字) -> .co/wave/<tb>.vcd -> 宿主流式解析为列式模型 -> Webview Canvas 渲染（esbuild 打包到 out/media），同名 .sim.out trace 叠加
  Test: SourceUnit immutable bundle -> 一次性 CourseEnginePlan -> assembler provider -> serialized ProgramImage/DUT bytes -> CourseTracePipeline -> 同一计划的 oracle provider -> bundled Icarus/Logisim DUT -> traceCompare -> HTML/JSON v2 report

自动测试与 P7:
  P3–P7 automatic 固定 builtin-ts 引擎与最大 payload 规模，用户唯一旋钮是 co.test.instructions；mars/verify-both 仅供手动与历史复现
  P7 stress mode（内部类型，非用户设置）: anchor(TS课程oracle对拍+中断/Timer注入) / probe(DM探针黑盒检查) / hybrid(runner 展开为前两者，P7 automatic 固定取值) / off(P3–P6 固定取值，同时关中断与 Timer)；probe 为 DUT-only，不能冒充 full-stack reference evidence

专门文档:
  diagnostic-catalog.md: MIPS/Verilog 诊断代码注册表（由 scripts/generate-diagnostic-catalog.mjs 生成，--check 校验漂移）
  syntax-coverage-matrix.md: 语法覆盖矩阵
  semantic-colors.md: 语义 token 分类与 VS Code 主题协作

代码约定: // @index role — brief
验证:
  日常门禁: npm run check:generated（生成物漂移）、node scripts/check-module-boundaries.mjs（mips-core 依赖边界）、node scripts/check-index.mjs（索引完整性）
  切换门: npm run verify:phase6 — 固定 v0.6.3 assembly-diff + course1 250+5 real execution evidence，经 conformance/mips 独立包运行

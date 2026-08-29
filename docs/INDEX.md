# BUAA CO Toolkit | VSCode extension for computer organization course (P0-P7)

入口: src/extension.ts activate()
LSP: src/server.ts (路由) + src/languageClient.ts (客户端)
架构: Client/Server IPC, TypeScript strict

子系统:
  common-lsp     | docs/modules/common-lsp.md     | 6 files  | 共享 LSP 基础设施
  mips-lsp       | docs/modules/mips-lsp.md       | 33 files | MIPS 汇编语言支持
  mips-core      | docs/modules/mips-core.md      | 41 files | 纯 TS MIPS 引擎核心（ISA/profile/machine/devices/events）
  mips-cli       | docs/modules/mips-cli.md       | 2 files  | 独立、版本化、有界 JSONL ISA/执行/设备接口
  mips-providers | docs/modules/mips-providers.md | 6 files  | Provider-neutral 引擎契约
  mips-host      | docs/modules/mips-host.md      | 5 files  | 懒启动 Worker、真实 ISA batch 与 ACK 背压
  mips-replay    | docs/modules/mips-replay.md    | 15 files | v2 离线闭包、可信引擎注册表、exact replay/re-evaluate
  verilog-lsp    | docs/modules/verilog-lsp.md    | 61 files | Verilog HDL 语言支持
  logisim-lsp    | docs/modules/logisim-lsp.md    | 2 files  | Logisim 电路文件
  orchestration  | docs/modules/orchestration.md  | ~48 files| 扩展宿主层
  course-testing | docs/modules/course-testing.md | 42 files | 自动化测试框架
  test-suite     | docs/modules/test-suite.md     | 159 files| Vitest 测试
  resources      | docs/modules/resources.md      | ~15 files| 静态资源
  highlighting   | docs/modules/syntax-highlighting.md | ~8 files | TextMate/semantic 分层高亮

数据流:
  MIPS: Text -> syntax.ts -> ast.ts -> semantic.ts -> parser.ts -> diagnostics, cache: parseCache.ts
  Verilog: Text -> lexer.ts -> statementParser.ts -> astParser.ts/exprAst.ts/blockAst.ts/proceduralAst.ts -> ast.ts -> semanticModel.ts -> diagnostics.ts 调度: syntaxDiag/lintDiag/dataflowDiag/instanceConnectionDiag/usageDiag/workspaceDiag, cache: parseCache.ts
  Test: SourceUnit immutable bundle -> assembler provider -> serialized ProgramImage/DUT bytes -> CourseTracePipeline（阶段 4 全阶段注入）-> oracle provider -> ISim/Logisim DUT -> traceCompare -> HTML/JSON v2 report（默认 oracle 仍为 legacy MARS；builtin 显式 shadow/verify-both；case 可 exact replay）

P7 test modes: anchor(MARS+ISim精确对拍), probe(DM探针黑盒检查), hybrid(两者), off(无中断)

专门文档:
  diagnostic-catalog.md: MIPS/Verilog 诊断代码注册表
  syntax-coverage-matrix.md: 语法覆盖矩阵
  semantic-colors.md: 语义 token 分类与 VS Code 主题协作
  adr/0001-mips-performance-baseline-policy.md: MIPS fixed-runner 性能基线采集、统计与批准策略

代码约定: // @index role — brief
验证: node scripts/check-index.mjs

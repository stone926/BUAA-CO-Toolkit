# BUAA CO Toolkit | VSCode extension for computer organization course (P0-P7)

入口: src/extension.ts activate()
LSP: src/server.ts (路由) + src/languageClient.ts (客户端)
架构: Client/Server IPC, TypeScript strict

子系统:
  common-lsp     | docs/modules/common-lsp.md     | 5 files  | 共享 LSP 基础设施
  mips-lsp       | docs/modules/mips-lsp.md       | 29 files | MIPS 汇编语言支持
  verilog-lsp    | docs/modules/verilog-lsp.md    | 48 files | Verilog HDL 语言支持
  logisim-lsp    | docs/modules/logisim-lsp.md    | 2 files  | Logisim 电路文件
  orchestration  | docs/modules/orchestration.md  | ~46 files| 扩展宿主层
  course-testing | docs/modules/course-testing.md | 31 files | 自动化测试框架
  test-suite     | docs/modules/test-suite.md     | ~70 files| Vitest 测试
  resources      | docs/modules/resources.md      | ~15 files| 静态资源

数据流:
  MIPS: Text -> syntax.ts -> ast.ts -> semantic.ts -> parser.ts -> diagnostics, cache: parseCache.ts
  Verilog: Text -> lexer.ts -> statementParser.ts -> astParser.ts/exprAst.ts/blockAst.ts/proceduralAst.ts -> ast.ts -> semanticModel.ts -> diagnostics.ts 调度: syntaxDiag/lintDiag/dataflowDiag/instanceConnectionDiag/usageDiag/workspaceDiag, cache: parseCache.ts
  Test: 生成 ASM -> MARS dump -> MARS run -> ISim/Logisim run -> traceCompare -> HTML report

P7 test modes: anchor(MARS+ISim精确对拍), probe(DM探针黑盒检查), hybrid(两者), off(无中断)

专门文档:
  diagnostic-catalog.md: MIPS/Verilog 诊断代码注册表
  syntax-coverage-matrix.md: 语法覆盖矩阵
  semantic-colors.md: 语义着色配置
  功能完整说明.md: 用户功能说明
  ../ARCHITECTURE_REVIEW.md: Parser/AST 迁移状态
  ../CODE_REVIEW_REPORT.md: 最近代码审查

代码约定: // @index role — brief
验证: node scripts/check-index.mjs

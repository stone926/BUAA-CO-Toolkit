# verilog-lsp | src/language/verilog/ | 60 files

Verilog HDL(.v) LSP: 词法->递归下降解析->表达式AST(40+节点)->过程块AST->语义模型(符号表+引用)->多类型诊断->补全/hover(含宽度推断+常量折叠)/跳转/格式化/高亮/折叠/签名帮助/重命名/内联提示/代码操作 + 跨文件WorkspaceIndex

数据流: Text -> lexer.ts -> statementParser.ts -> astParser.ts/exprAst.ts/blockAst.ts/proceduralAst.ts -> ast.ts -> semanticModel.ts -> diagnostics.ts(调度): syntaxDiag/lintDiag/dataflowDiag/instanceConnectionDiag/usageDiag/workspaceDiag -> service.ts(provider barrel)
跨文件: workspaceModuleRegistry.ts(VSCode端) <-> workspaceIndex.ts(LSP端) -> signalWiring.ts

See also: verilog-diagnostics.md(诊断子模块10文件), verilog-ast.md(AST/解析子模块8文件), ARCHITECTURE_REVIEW.md(迁移状态)

core:
  parser.ts — 主解析入口: parseVerilog/buildTestbench/moduleAtPosition
  lexer.ts — 词法: VerilogToken流(关键字/标识符/数字/字符串/注释/预处理/系统任务/操作符)
  statementParser.ts — 语句源切片: module item边界/过程块边界
  astParser.ts — 模块/声明/实例结构解析: ports/parameters/declarations/instances/connections/generate
  moduleParser.ts — 薄门面: lexer+astParser组合
  ast.ts — VerilogAstDocument, VerilogModuleAst(items/alwaysBlocks/proceduralBlocks/subroutines)
  syntaxParser.ts — 语法树+语法诊断, 模块项发现从AST遍历
  semanticModel.ts — 符号表/作用域/AST引用收集, subroutine/localDecl/blockControl/loopControl/assignment/instance/gatePrimitive已接入AST

model:
  model.ts — VerilogDecl(width/initializer/constantValue/direction/explicitPortNetType), VerilogInstance(portConnections/parameterConnections), VerilogModule(ports/parameters/declarations/instances), VerilogMacro, VerilogInclude, VerilogDeclKind

expr-support:
  expressions.ts — 宽度推断(widthOfDecl/widthOfExpressionAst), 常量折叠(evalExpressionAstConstant), VerilogConstantOverrides
  declarations.ts — 声明类型分类: port方向/net类型/variable类型/parameter类型/course-out net类型
  gatePrimitives.ts — 内建门级原语关键字(and/or/not/buf/...)
  tokenUtils.ts — token辅助: 区间/种类/文本提取
  preprocessor.ts — 预处理指令集(define/include/ifdef/...)供补全
  moduleUtils.ts — moduleAtPosition/declDetail/buildTestbench, P7 testbench shell/block 从 resources/templates/verilog 渲染
  moduleProvider.ts — MutableVerilogModuleProvider接口
  lintRuleCatalog.ts — Verilog lint 规则元数据 catalog, 从 resources/verilog/lintRules.json 加载
  statementUtils.ts — splitTopLevelCommaSpans
  textUtils.ts — 文本/空白处理供formatting
  displayFormats.ts — $display/$write格式字符串提取供trace格式推断
  numericLiterals.ts — 数字字面量hover格式化+代码操作(进制转换/位宽)
  parameterOverrides.ts — 模块实例参数覆盖解析
  parseCache.ts — 解析缓存(DocumentResultCache wrapper)

lsp-providers:
  service.ts — 聚合facade: 只 re-export parser/diagnostic/provider 公共入口
  diagnosticProvider.ts — 诊断provider facade: parse cache + workspace diagnostics + disabled-code过滤
  completions.ts — completionProvider 依赖装配入口, 注入实例连接上下文 resolver
  completionProvider.ts — 补全provider: 实例连接上下文/宏/关键字/snippet/workspace模块补全
  hover.ts — hover provider: 宽度/常量/实例参数/include 状态/表达式 AST
  navigation.ts — definition/reference provider: 跨文件 module/interface/macro/include 引用收集和去重
  rename.ts — rename provider: 基于 reference provider 生成 workspace edit, 标识符边界校验
  codeActions.ts — quick fix/refactor provider: 隐式连线声明、lint 禁用、case default、表达式折叠/抽取、实例连接补全
  signatureHelp.ts — 实例端口/参数列表签名帮助
  inlayHints.ts — 实例连接端口方向/宽度与参数提示
  resolveSymbol.ts — 语义模型+语法 fallback 的 Verilog symbol resolution, 实例连接上下文
  display.ts — hover/inlay/signature markdown 文案、宽度/参数显示 helper
  semanticTokens.ts — 语义高亮: module/port/signal/parameter/instance/macro/systemTask/number/keyword/comment/string/formatSpecifier/punctuation
  formatting.ts — Verilog 细项格式化配置
  folding.ts — module/always/initial/function/task/generate/case/预处理条件块
  symbols.ts — 文档符号树(模块->端口/参数/声明/实例)
  traceParser.ts — ISim $display输出解析为CpuTraceEvent[]

cross-file:
  workspaceModuleRegistry.ts — VSCode端后台索引: FileSystemWatcher **/*.v, onDidSaveTextDocument增量更新
  workspaceIndex.ts — LSP端模块数据库: 索引模块/宏/引用/display格式, 跨文件查找, 增量更新(≤50逐文件,>50全量)
  signalWiring.ts — 跨模块信号driver/reader追踪

legacy:
  cst.ts — deprecated CST兼容包装, 生产路径已不使用

Diagnostic子模块: verilog-diagnostics.md | AST子模块: verilog-ast.md

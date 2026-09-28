# verilog-lsp | src/language/verilog/ | 68 files

Verilog HDL（`.v` / `.vh`）LSP：词法 → 递归下降解析 → 表达式/过程/块 AST → 语义模型（符号表 + 引用）→ 多类型诊断 → 补全/hover（含宽度推断与常量折叠）/跳转/格式化/高亮/折叠/签名/重命名/内联提示/代码操作，外加跨文件 `workspaceIndex`。SystemVerilog（`.sv` / `.svh`）刻意只走独立 language id + TextMate grammar，不接此 parser，避免 unsupported SV AST 产生误诊断

数据流: `lexer.ts` → `statementParser.ts` → `astParser.ts` / 表达式与块 AST（见 verilog-ast.md）→ `ast.ts` → `semanticModel.ts` → 诊断调度 → `service.ts`（provider barrel）
跨文件: `workspaceModuleRegistry.ts`（VS Code 端）↔ `workspaceIndex.ts`（LSP 端）→ `signalWiring.ts`

子模块：诊断见 verilog-diagnostics.md，AST 见 verilog-ast.md。

## 解析核心

- `parser.ts` — LSP 入口：`parseVerilog` 与诊断装配；`moduleDeclarations.ts` 供宿主命令只取模块声明，`parseCore.ts` 供信号视图取得无诊断 AST 与语义模型，两者复用同一次词法解析入口且不加载服务端诊断和 provider
- `moduleParser.ts` — 薄门面：lexer + astParser
- `lexer.ts` — 词法：关键字/标识符/数字/字符串/注释/预处理/系统任务/操作符
- `statementParser.ts` — 语句源切片：module item 与过程块边界
- `astParser.ts` — 模块、声明、实例、端口连接、generate 结构
- `instanceParser.ts` — 独立实例/连接建模（同句多实例共享参数头，保留空槽与源码范围）
- `instanceSyntax.ts` — 解析与语法验证共用的实例组 token 边界
- `proceduralBoundary.ts` — always/initial 的单条过程语句边界与错误恢复
- `syntaxParser.ts` — 语法树 + 语法诊断
- `semanticModel.ts` — 符号表/作用域/AST 引用收集；generate 块各自成作用域
- `model.ts` — VerilogDecl / VerilogInstance / VerilogModule / VerilogGenerateBlock / VerilogMacro 等模型类型

## 表达式与声明支持

- `expressions.ts` — 位宽推断与常量折叠
- `declarations.ts` — 声明类型分类（port 方向、net/variable、parameter）
- `driveStrength.ts` — 驱动强度前缀识别（保留源码偏移，不模拟强度）
- `preprocessor.ts` — `define`/`include`/`ifdef` 等指令集，供补全使用
- `directiveBoundaries.ts` — 在代码解析入口划出编译指令及参数边界
- `parameterOverrides.ts` — 实例参数按名/按位覆盖解析，逐级求值并报告不可求值项
- `generateScopes.ts` — generate 块作用域查询（纯模型，含条件分支互斥）
- `numericLiterals.ts` — 数字字面量 hover 格式化与进制/位宽代码操作
- `displayFormats.ts` — `$display`/`$write` 格式串提取，供 trace 格式推断
- `tokenUtils.ts` — token 区间/种类/文本提取
- `statementUtils.ts` — 顶层逗号区间切分
- `textUtils.ts` — 格式化用文本/空白处理
- `parseCache.ts` — 解析缓存（`DocumentResultCache` wrapper）
- `moduleUtils.ts` — `moduleAtPosition` / `declDetail` / `buildTestbench`，P7 testbench shell 从模板渲染
- `stimulusTestbench.ts` — 非课程 CPU 的可编辑激励 testbench 模板
- `moduleProvider.ts` — `MutableVerilogModuleProvider` 接口

## LSP providers

- `service.ts` — 聚合 facade，只 re-export 公共入口
- `diagnosticProvider.ts` — 诊断 facade：parse cache + workspace 诊断 + disabled-code 过滤
- `completions.ts` / `completionProvider.ts` — 依赖装配与补全（实例连接上下文、宏、关键字、snippet、workspace 模块）
- `hover.ts` — 声明/表达式宽度、常量、实例参数、include 状态；说明文字用中文，不回显源码
- `navigation.ts` — 跨文件 module/interface/macro/include 定义与引用
- `rename.ts` — 基于引用 provider 生成 workspace edit
- `codeActions.ts` — 隐式连线声明、表达式折叠/抽取、实例连接补全
- `signatureHelp.ts` — 实例端口/参数签名帮助（不含 localparam）
- `inlayHints.ts` — 实例连接端口方向/宽度与参数提示
- `resolveSymbol.ts` — 语义模型 + 语法 fallback 的 symbol resolution
- `display.ts` — hover/inlay/signature 文案与宽度/参数显示 helper
- `semanticTokens.ts` — 上下文语义高亮（module/port/signal/parameter/instance/macro/task/function）；词法类别由 TextMate 提供
- `formatting.ts` / `folding.ts` / `symbols.ts` — 格式化、折叠、文档符号树
- `traceParser.ts` — Verilog `$display` trace 输出解析为 `CpuTraceEvent[]`

## 跨文件

- `workspaceModuleRegistry.ts` — VS Code 端后台索引：保存时从文档更新，watcher 异步读盘并按内容指纹跳过保存回声；每个 URI 的修订序号防止旧读取覆盖新索引
- `workspaceIndex.ts` — LSP 端模块/宏/引用/display 格式数据库，增量更新（≤50 逐文件，>50 全量）
- `signalWiring.ts` — 跨模块 signal driver/reader 追踪

## 外部编译器

外部语法检查（`externalSyntaxProject.ts` / `externalSyntaxCheck.ts` / `iverilogSyntaxCheck.ts`）固定使用 bundled Icarus `-g2005 -tnull -i`，源集合与顺序复用确定性排序，保存的 `.co/tb` testbench 作为末尾源一并检查。详见 verilog-diagnostics.md

# verilog-lsp | src/language/verilog/ | 76 files

Verilog HDL（`.v` / `.vh`）LSP：词法 → 递归下降解析 → 表达式/过程/块 AST → 语义模型（符号表 + 引用）→ 多类型诊断 → 补全/hover（含宽度推断与常量折叠）/跳转/格式化/高亮/折叠/签名/重命名/内联提示/代码操作，外加跨文件 `workspaceIndex`。SystemVerilog（`.sv` / `.svh`）刻意只走独立 language id + TextMate grammar，不接此 parser，避免 unsupported SV AST 产生误诊断

数据流: `lexer.ts` → `statementParser.ts` → `astParser.ts` / 表达式与块 AST（见 verilog-ast.md）→ `ast.ts` → `semanticModel.ts` → 诊断调度 → `service.ts`（provider barrel）
跨文件: `workspaceModuleRegistry.ts`（VS Code 端）↔ `workspaceIndex.ts`（LSP 端）→ `signalWiring.ts`

子模块：诊断见 verilog-diagnostics.md，AST 见 verilog-ast.md。

## 解析核心

- `parser.ts` — LSP 入口：`parseVerilog` 与诊断装配；`moduleDeclarations.ts` 供宿主命令只取模块声明，`parseCore.ts` 供信号视图取得无诊断 AST 与语义模型，两者复用同一次词法解析入口且不加载服务端诊断和 provider
- `moduleParser.ts` — 薄门面：lexer + astParser
- `p7ReturnTestbench.ts` — 真实 handler 返回后的公开宏观 PC 历史触发；只用顶层端口，按官方下降沿检查中断应答，兼容 SW 忽略低地址位与未选中 IG 总线
- `lexer.ts` — 词法：关键字/标识符/数字/字符串/注释/预处理/系统任务/操作符
- `statementParser.ts` — 语句源切片：module item 与过程块边界
- `astParser.ts` — 模块、声明、实例、端口连接、generate 结构
- `instanceParser.ts` — 独立实例/连接建模（同句多实例共享参数头，保留空槽与源码范围）
- `instanceSyntax.ts` — 解析与语法验证共用的实例组 token 边界
- `proceduralBoundary.ts` — always/initial 的单条过程语句边界与错误恢复
- `syntaxParser.ts` — 语法树 + 语法诊断
- `semanticModel.ts` — 符号表/作用域/AST 引用收集（含 generate 控制与声明的 unpacked 数组维度）；generate 块各自成作用域
- `model.ts` — VerilogDecl / VerilogInstance / VerilogModule / VerilogGenerateBlock / VerilogMacro 等模型类型

## 表达式与声明支持

- `expressions.ts` — 位宽推断与常量折叠
- 函数声明保留返回范围及 integer/time/real 类型，返回赋值、函数调用与 hover 复用同一位宽；右移保持左操作数位宽，赋给较窄目标仍提示截断，显式 part-select 可表达取位意图。
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
- `textUtils.ts` — 解析与符号回退复用的文本、宽度和列表处理辅助；格式化不再依赖字符级等号扫描
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
- `formatting.ts` / `formatting/` — 全文与选区格式化：保真源码/保护区间、轻量结构、空白布局、对齐和局部编辑；不依赖诊断或完整语义 AST
- `folding.ts` / `symbols.ts` — 折叠、文档符号树
- `traceParser.ts` — Verilog `$display` trace 输出解析为 `CpuTraceEvent[]`

## 格式化

`formatting.ts` 保留全文与选区两个 provider 入口，核心只处理当前文档，不读取工作区文件，不调用外部编译器，也不构建诊断/语义 AST：

- `formatting/source.ts` — 复用全文 lexer 建立 token、源码间隙和行索引，识别指令逻辑行及 `// co-format: off/on` 保护区域
- `formatting/structure.ts` — 块、受控语句、case 和模块/实例列表的轻量结构上下文；支持同行多个开闭事件和有界恢复
- `formatting/spacing.ts` — 依据 token 与上下文调整间隙，不用正则改写 token 本体
- `formatting/layout.ts` — 缩进、续行和安全换行；保留注释内部布局与已有 EOL
- `formatting/alignment.ts` — 参数、模块端口分组对齐，按 Tab 可视列计算补齐量
- `formatting/continuation.ts` — 赋值右值续行锚点及同一表达式内的三元链对齐，避免不同语句之间互相补齐
- `formatting/edits.ts` — 标准 FormattingOptions、全文/选区工作范围及合法、非重叠的局部 edits

保真优先级高于布局：字符串、数字、注释正文、转义标识符及必要终止空白不被改写；指令/宏续行和关闭区域不参与普通空白清理。无法确定的语法局部保守保留，不展开宏、不增删 `begin/end`。选区以相交完整行为工作范围，末尾在下一行第 0 列时不含该行，工作范围外原文不变；不执行全局 EOF 清理。

格式化采用统一风格，删除九项旧 `co.verilog.format.*` 配置及读取逻辑，旧工作区值不再影响输出。缩进字符和宽度仍由 VS Code `FormattingOptions` 提供：模块参数、端口及实例内容缩进一级，独立右括号与声明起始行对齐；命名连接逗号后、实例名与端口括号之间保留空格；范围统一写成 `[31:0]`，声明范围外留空格。

赋值右值在首行开始时，续行对齐右值首列；右值另起一行时缩进一级。参数等号、模块端口名及同一表达式的三元链统一对齐，三元链包括首行条件及带注释的分支。保留用户已有换行、空行和 `end else` 的分行选择；只在全文格式化时遵循标准 EOF 清理选项。LSP 仅对 Verilog 注册选区能力，保持 SystemVerilog 与其他语言边界。

## 跨文件

- `workspaceModuleRegistry.ts` — VS Code 端后台索引：保存时从文档更新，watcher 异步读盘并按内容指纹跳过保存回声；每个 URI 的修订序号防止旧读取覆盖新索引
- `workspaceIndex.ts` — LSP 端模块/宏/引用/display 格式数据库，增量更新（≤50 逐文件，>50 全量）
- `signalWiring.ts` — 跨模块 signal driver/reader 追踪

## 外部编译器

外部语法检查（`externalSyntaxProject.ts` / `externalSyntaxCheck.ts` / `iverilogSyntaxCheck.ts`）固定使用 bundled Icarus `-g2005 -tnull -i`，源集合与顺序复用确定性排序，保存的 `.co/tb` testbench 作为末尾源一并检查。详见 verilog-diagnostics.md

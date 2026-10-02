# mips-lsp | src/language/mips/ | 34 files

MIPS 汇编（`.asm` / `.s` / `.mips`）LSP：解析 → AST → 语义 → 诊断 → 补全/hover/跳转/格式化/高亮/签名/折叠/重命名/内联提示/代码操作。另保留历史 MARS trace 解析对比；LSP 不启动 MARS。

数据流: core assembler lexer → `syntax.ts`（位置与不完整源码适配）→ `ast.ts` → `semantic.ts` → `parser.ts`（编排）→ 诊断 → `service.ts`；`parseCache.ts` 按 URI/设置缓存。诊断委托 `parseCache.ts`，LSP 层只做 provider。

## 核心

- `parser.ts` — 解析编排：source → parsed lines → AST → semantic model → diagnostics；未声明符号检查在单次解析内复用宏重载匹配与 label 参数分析
- `syntax.ts` — 适配 core assembler 的同一 token/comment lexer，保留编辑中未闭合字符诊断；位置解析与格式化 API
- `ast.ts` — 类型化 AST（operand / `.eqv` / `.macro` 头）
- `semantic.ts` — 符号收集、作用域、引用与跳转查询
- `model.ts` — MipsSymbol / MipsMacro / MipsParseResult
- `instructionValidation.ts` — 纯 AST 指令校验（操作数、寄存器类型、立即数、内存对齐、CP0 权限）

## AST 辅助

- `operandAst.ts` — 内存操作数解析与格式值提取
- `operandReferences.ts` — 递归操作数访问与引用收集
- `literals.ts` — 字符串/数字范围扫描；整数与字符解析直接复用 core，整数范围检查保留源码无符号数值

## 静态资源

- `resources.ts` — 展示资源与 core ISA/COP1/整数扩展 facts 合并；寄存器解析、指令可用性、directive 与 syscall 直接来自 core，JSON 仅保留展示/历史展开模板
- `generated/isaDisplayCatalog.ts` — 与 core catalog 同 schema revision 的 LSP 展示事实（勿手改）
- `marsArgs.ts` / `officialMarsDiagnostics.ts` — 旧 MARS CLI 参数与诊断兼容 API，仅供历史用例/测试识别，不启动外部进程
- `legacyMarsPolicy.ts` — 历史 MARS 内存/课程语义元数据，供归档校验读取
- `legacyMarsDiagnostics.ts` — 历史 coL1/coL2/efc/p7irq/cl 证据诊断映射

## LSP providers

- `service.ts` — 注册中心，re-export 全部 provider
- `completions.ts` — 按 core 可执行能力补全指令/伪指令/寄存器/directive/标签/宏/`.eqv`；课程模式不推荐 COP1、`.kdata` 或不支持的伪指令
- `hover.ts` — 指令/寄存器/伪指令/宏/syscall/CP0 说明（中文，不回显冗余上下文）
- `navigation.ts` — 定义跳转、引用查找、文档符号
- `formatting.ts` — 4 空格缩进、逗号空格、注释列对齐
- `signatureHelp.ts` — 指令格式与宏参数签名
- `folding.ts` — 通过 LSP 折叠 `.macro`，并处理 `#region` 标记（语言配置只保留 region 标记，避免宏名被 VS Code 提升为 minimap 区域标题）
- `rename.ts` — 标签/数据符号/`.eqv`/宏重命名
- `semanticTokens.ts` — 只输出上下文 semantic token（指令类别/寄存器/宏/符号）；词法类别交给 TextMate
- `inlayHints.ts` — syscall 服务名/CP0 名/分支目标
- `codeActions.ts` — `pseudo-instruction:*` QuickFix
- `display.ts` — hover/inlay 的 Markdown 文案（与 GUI/运行时同源的 27 项普通 syscall、12 项明确不支持服务、CP0 描述、宏体预览）；P7 仅提示 ExcCode=8 → 0x4180
- `queries.ts` — 宏重载查找与宏调用参数提取

## 基础设施

- `parseCache.ts` — diagnostics/semantic 共享解析缓存
- `state.ts` — MipsServerState（忽略伪指令告警的文件/助记符）
- `commands.ts` — 内部命令 ID（忽略伪指令告警）
- `text.ts` — 词范围与字符分类工具

## Trace

- `traceParser.ts` — 解析 coL1/coL2 为 `CpuTraceEvent[]`；legacy MARS oracle 固定用 coL2（支持停机尾证明与动态兼容检查），默认 builtin TS oracle 不经过此解析器
- `traceCompare.ts` — 事件对比引擎

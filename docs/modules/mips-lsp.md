# mips-lsp | src/language/mips/ | 34 files

MIPS 汇编（`.asm` / `.s` / `.mips`）LSP：解析 → AST → 语义 → 诊断 → 补全/hover/跳转/格式化/高亮/签名/折叠/重命名/内联提示/代码操作，另含 MARS trace 解析对比。

数据流: `syntax.ts`（行词法）→ `ast.ts` → `semantic.ts` → `parser.ts`（编排）→ 诊断 → `service.ts`；`parseCache.ts` 按 URI/设置缓存。诊断委托 `parseCache.ts`，LSP 层只做 provider。

## 核心

- `parser.ts` — 解析编排：source → parsed lines → AST → semantic model → diagnostics；未声明符号检查在单次解析内复用宏重载匹配与 label 参数分析
- `syntax.ts` — 词法解析与格式化 API
- `ast.ts` — 类型化 AST（operand / `.eqv` / `.macro` 头）
- `semantic.ts` — 符号收集、作用域、引用与跳转查询
- `model.ts` — MipsSymbol / MipsMacro / MipsParseResult
- `instructionValidation.ts` — 纯 AST 指令校验（操作数、寄存器类型、立即数、内存对齐、CP0 权限）

## AST 辅助

- `operandAst.ts` — 内存操作数解析与格式值提取
- `operandReferences.ts` — 递归操作数访问与引用收集
- `literals.ts` — 字符串/数字/字符字面量扫描与解析

## 静态资源

- `resources.ts` — ISA 资源加载（instructions/registers/cp0/directives/syscalls/pseudo）；真实指令 facts 合并自生成 catalog
- `generated/isaDisplayCatalog.ts` — 与 core catalog 同 schema revision 的 LSP 展示事实（勿手改）
- `marsArgs.ts` — 原版 MARS 参数构建与魔改参数拒绝；历史 class/range 元数据只用于档案解析
- `officialMarsDiagnostics.ts` — 原版 CLI 参数解析失败识别，补齐退出码 0 的错误情形
- `legacyMarsPolicy.ts` — 稳定版 MARS 兼容内存配置/异常入口策略
- `legacyMarsDiagnostics.ts` — 历史 coL1/coL2/efc/p7irq/cl 证据诊断映射

## LSP providers

- `service.ts` — 注册中心，re-export 全部 provider
- `completions.ts` — 指令/伪指令/寄存器/标签/宏/`.eqv` 补全
- `hover.ts` — 指令/寄存器/伪指令/宏/syscall/CP0 说明（中文，不回显冗余上下文）
- `navigation.ts` — 定义跳转、引用查找、文档符号
- `formatting.ts` — 4 空格缩进、逗号空格、注释列对齐
- `signatureHelp.ts` — 指令格式与宏参数签名
- `folding.ts` — 通过 LSP 折叠 `.macro`，并处理 `#region` 标记（语言配置只保留 region 标记，避免宏名被 VS Code 提升为 minimap 区域标题）
- `rename.ts` — 标签/数据符号/`.eqv`/宏重命名
- `semanticTokens.ts` — 只输出上下文 semantic token（指令类别/寄存器/宏/符号）；词法类别交给 TextMate
- `inlayHints.ts` — syscall 服务名/CP0 名/分支目标
- `codeActions.ts` — `pseudo-instruction:*` QuickFix
- `display.ts` — hover/inlay 的 Markdown 文案（syscall 详情、CP0 描述、宏体预览）
- `queries.ts` — 宏重载查找与宏调用参数提取

## 基础设施

- `parseCache.ts` — diagnostics/semantic 共享解析缓存
- `state.ts` — MipsServerState（忽略伪指令告警的文件/助记符）
- `commands.ts` — 内部命令 ID（忽略伪指令告警）
- `text.ts` — 词范围与字符分类工具

## Trace

- `traceParser.ts` — 解析 coL1/coL2 为 `CpuTraceEvent[]`；legacy MARS oracle 固定用 coL2（支持停机尾证明与动态兼容检查），默认 builtin TS oracle 不经过此解析器
- `traceCompare.ts` — 事件对比引擎

# mips-lsp | src/language/mips/ | 33 files

MIPS汇编(.asm/.s/.mips) LSP: 解析->AST->语义->诊断->补全/hover/跳转/格式化/高亮/签名/折叠/重命名/内联提示/代码操作 + MARS trace解析对比

数据流: Text -> syntax.ts(词法行) -> ast.ts -> semantic.ts -> parser.ts(编排) -> diagnostics -> service.ts
  LSP层: service.ts -> parseCache.ts -> completions/hover/navigation/formatting/signatureHelp/folding/rename/semanticTokens/inlayHints/codeActions
  Trace: traceParser.ts(MARS coL1/coL2；课程 oracle 固定 coL2) -> traceCompare.ts(事件对比)

core:
  parser.ts — 解析编排: source->parsed lines->AST->semantic model->diagnostics | exports: parseMips
  syntax.ts — 词法解析/格式化API, deprecated parseOperands/Cst*兼容 | exports: parseMipsSourceDocument, parseMipsFormatDocument, printMipsFormatDocument
  ast.ts — 类型化AST: MipsOperandAst(register/symbol/memory/immediate/string/labelPlusImmediate), .eqv/.macro头 | exports: buildMipsAst, MipsAstDocument, MipsOperandAst
  semantic.ts — 语义: 符号收集/作用域/引用, 跳转定义/查找引用查询 | exports: buildMipsSemanticModel, resolveMipsSemanticTarget, mipsSemanticReferenceRanges
  model.ts — MipsSymbol, MipsMacro, MipsParseResult

ast-helpers:
  operandAst.ts — 内存操作数解析, 格式值提取, signed32
  operandReferences.ts — 递归操作数AST访问, 引用收集
  literals.ts — 字面量扫描: 字符串/数字/字符范围, 解析
  instructionValidation.ts — 纯AST指令校验: 操作数数量/寄存器类型/立即数范围/内存对齐/CP0权限 | 被 parser.ts 调用

resources:
  resources.ts — ISA静态资源加载: instructions/registers/cp0/directives/syscalls/pseudo/meta；真实指令的 type/delay/read-write/memory facts 合并自 generated/isaDisplayCatalog（由唯一 isa.json 生成） | exports: instructions, registers, cp0Registers, mipsSemanticTokenTypes
  generated/isaDisplayCatalog.ts — 与 core catalog 同 schema revision/SHA 的 LSP 结构事实生成物（勿手改）
  marsArgs.ts — MARS 命令行参数构造: run/dumpText/dumpKernel, P7 efc/p7irq/cl 参数, 内存配置常量
  legacyMarsPolicy.ts — 稳定版 MARS 兼容内存配置/异常入口策略（大文本段容纳 0x3000→0x4180 handler）
  legacyMarsDiagnostics.ts — 稳定版 MARS 兼容诊断映射：coL1/coL2/efc/p7irq/cl 组合与原始输出归一化；被多个子系统复用

display:
  display.ts — hover/inlay Markdown: syscall详情, CP0寄存器, 宏体/展开预览
  queries.ts — 宏重载查找, 宏调用参数提取

lsp-providers:
  service.ts — 注册中心, re-export全部provider, 诊断委托parseCache | exports: 全部LSP函数, MipsServerState, clearMipsParseCache
  completions.ts — 指令/伪指令/寄存器(含浮点/CP0)/标签/宏/EQV补全
  hover.ts — 指令详情/寄存器描述/伪指令/宏/syscall/CP0 hover
  navigation.ts — 跳转定义/查找引用/文档符号
  formatting.ts — 4空格缩进, 逗号空格, 32列注释对齐
  signatureHelp.ts — 指令格式(rd,rs,rt)+类型标签, 宏参数, 自动高亮当前操作数
  folding.ts — .macro/.end_macro, #region/#endregion
  rename.ts — 标签/数据符号/EQV/宏重命名
  semanticTokens.ts — 仅输出上下文 semantic token（指令类别/寄存器/宏/符号）, 支持 instructionTokenMode；词法类别由 TextMate 提供，颜色由 VS Code 决定
  inlayHints.ts — syscall服务名/CP0寄存器名/分支目标 inlay
  codeActions.ts — pseudo-instruction:* QuickFix

infra:
  parseCache.ts — diagnostics/semantic 共享解析；每 URI/设置只保留最新一代，跨 version 精确文本复用
  state.ts — MipsServerState: ignoredPseudoInstructionFiles/Mnemonics
  commands.ts — 内部命令ID: co.server.mips.ignorePseudoWarningsForFile/ForMnemonic
  text.ts — getMipsWordRange, 字符分类

trace:
  traceParser.ts — 解析 coL1 写回行及 coL2 动态指令块为 CpuTraceEvent[]；legacy MARS oracle 固定使用 coL2，以支持停机尾证明、SWL/SWR 合并、REGIMM 分支事件修复/后续状态限制和动态兼容检查，coL1 仅用于工具链能力探针；默认 builtin TS oracle 不经过该文本解析器
  traceCompare.ts — 事件对比引擎, TraceDiffResult

迁移状态: 已从CST完全迁移到AST, Cst*和parseOperands为deprecated. 详见 ARCHITECTURE_REVIEW.md

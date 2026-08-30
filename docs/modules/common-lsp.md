# common-lsp | src/language/common/ | 6 files

各语言共用基础设施: 配置合并、诊断过滤、LSP 辅助、缓存

settings:
  settings.ts — CoSettings接口/默认值/mergeCoSettings/诊断禁用键；外部 Verilog 检查使用 backend-neutral external mode/timeout，ISE warning suppression 独立保留 | exports: CoSettings, defaultCoSettings, mergeCoSettings, isVerilogLintRuleEnabled, diagnosticCodeKey, diagnosticFileCodeKey, isDiagnosticCodeDisabledForFile

diagnostic-actions:
  diagnosticActions.ts — 诊断过滤和QuickFix生成 | exports: filterDisabledDiagnostics, getDiagnosticSuppressActions

lsp-helpers:
  lsp.ts — Position/Range辅助: lineAt, containsPosition, rangesEqual, makeDiagnostic | exports: lineAt, containsPosition, rangesEqual, makeDiagnostic
  semanticTokens.ts — SemanticTokenCollector: 单行边界校验、去重、排序、重叠保护和 LSP 相对位置编码 | exports: SemanticTokenCollector

utilities:
  util.ts — rangeKey(去重键), escapeRegExp, escapeHtml, createMipsTokenRegex | exports: rangeKey, escapeRegExp, escapeHtml, createMipsTokenRegex

parse-cache:
  documentResultCache.ts — 每个 URI/discriminator 仅保留最新一代；跨 version 精确文本复用；LRU 16条目 | exports: DocumentResultCache

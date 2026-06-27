# common-lsp | src/language/common/ | 5 files

各语言共用基础设施: 配置合并、诊断过滤、LSP 辅助、缓存

settings:
  settings.ts — CoSettings接口/默认值/mergeCoSettings/诊断禁用键 | exports: CoSettings, defaultCoSettings, mergeCoSettings, isVerilogLintRuleEnabled, diagnosticCodeKey, diagnosticFileCodeKey, isDiagnosticCodeDisabledForFile

diagnostic-actions:
  diagnosticActions.ts — 诊断过滤和QuickFix生成 | exports: filterDisabledDiagnostics, getDiagnosticSuppressActions

lsp-helpers:
  lsp.ts — Position/Range辅助: lineAt, containsPosition, rangesEqual, makeDiagnostic | exports: lineAt, containsPosition, rangesEqual, makeDiagnostic

utilities:
  util.ts — rangeKey(去重键), escapeRegExp, escapeHtml, createMipsTokenRegex | exports: rangeKey, escapeRegExp, escapeHtml, createMipsTokenRegex

parse-cache:
  documentResultCache.ts — 文档版本感知通用缓存，含文本content shortcut，LRU 16条目 | exports: DocumentResultCache
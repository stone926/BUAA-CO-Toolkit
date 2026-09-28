# common-lsp | src/language/common/ | 6 files

各语言共用的 LSP 基础设施：配置合并、诊断过滤与快速修复、位置/语义 token 辅助、解析缓存。

- `settings.ts` — `CoSettings` 接口、默认值与 `mergeCoSettings`；诊断禁用键解析
- `diagnosticActions.ts` — 诊断过滤（按 code / 按文件 code）与 QuickFix 生成
- `lsp.ts` — Position/Range 辅助（`lineAt`、`containsPosition`、`rangesEqual`、`makeDiagnostic` 等）
- `semanticTokens.ts` — `SemanticTokenCollector`：单行边界校验、去重、排序、重叠保护与 LSP 相对位置编码
- `util.ts` — `rangeKey`（去重键）、`escapeRegExp`、`escapeHtml`、`createMipsTokenRegex`
- `documentResultCache.ts` — 每个 URI/discriminator 只保留最新一代，跨 version 精确文本复用，LRU 16 条目

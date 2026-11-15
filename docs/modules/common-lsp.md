# common-lsp | src/language/common/ | 6 files

各语言共用的 LSP 基础设施：配置合并、位置/语义 token 辅助、解析缓存。

- `settings.ts` — `CoSettings` 接口、默认值与 `mergeCoSettings`
- `lsp.ts` — Position/Range 辅助（`lineAt`、`containsPosition`、`rangesEqual`、`makeDiagnostic` 等）
- `semanticTokens.ts` — `SemanticTokenCollector`：单行边界校验、去重、排序、重叠保护与 LSP 相对位置编码
- `util.ts` — `rangeKey`（去重键）、`escapeRegExp`、`escapeHtml`、`createMipsTokenRegex`
- `documentResultCache.ts` — 每个 URI/discriminator 只保留最新一代，跨 version 精确文本复用，LRU 16 条目
- `formattingRequest.ts` — 格式化请求生命周期：配置等待前后核验取消、文档存续与版本，避免应用过期编辑

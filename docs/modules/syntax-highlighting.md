# syntax-highlighting | syntaxes/ + scripts/generate-syntaxes.mjs

MIPS、Verilog 与 SystemVerilog 的 TextMate 词法高亮，以及与 LSP semantic tokens 的分层契约。

## 职责边界

- TextMate — 注释、字符串/字符/转义、数字、关键字、directive、系统任务、操作符、标点，以及可由局部语法确定的名称
- Semantic — 指令类别、寄存器、宏/符号引用，以及 Verilog 模块/端口/信号/参数/实例/task/function 等上下文角色
- MIPS macro bodies — each physical body line gets the same instruction/directive/operand scopes as top-level code; `%parameter:` label placeholders retain parameter coloring, while real macro-local labels remain symbol-colored
- 约束 — semantic provider 不重复发送整段注释、字符串、数字或关键字，避免覆盖主题的嵌套 TextMate scope
- Verilog/SystemVerilog 编译指令与宏引用将反引号和名称作为完整 token 着色，后方参数保留各自类别；Verilog 宏的 semantic token 同样覆盖反引号。

## 单一事实源

- `resources/co/languages.json` — 语言 ID/扩展名/grammar 路径与 scope/LSP 能力；`scripts/generate-languages.mjs` 生成 package 语言贡献与 `src/language/generated/languages.ts`（勿手改）
- `src/language/languageRegistry.ts` — 从目录派生 client/格式化 selector、watcher glob、文件谓词与 service 路由
- `resources/mips/{instructions,directives,registers}.json`、`resources/verilog/{keywords,systemverilog}.json` — 词法目录
- `scripts/generate-syntaxes.mjs` — 从目录确定性生成 grammar，`npm run check:syntaxes` 检查提交产物漂移

## Language IDs

- `mipsasm` — `.asm` / `.s` / `.mips`，TextMate + LSP semantic
- `verilog` — `.v` / `.vh`，TextMate + LSP semantic
- `systemverilog` — `.sv` / `.svh`，**仅 TextMate**；刻意不接 Verilog LSP，避免 unsupported SV AST 产生误诊断

Grammar 分别由 `syntaxes/mips.tmLanguage.json`、`verilog.tmLanguage.json`（复用 Verilog 底层并增加课程所需 SV 关键字、assignment pattern 与 wildcard port 的 `systemverilog.tmLanguage.json`）生成。主题所有权与 semantic token 分类见 `docs/semantic-colors.md`；插件不包含也不写入任何颜色。

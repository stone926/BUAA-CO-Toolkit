# logisim-lsp | src/language/logisim/ | 2 files

Logisim `.circ` 文件支持：XML 解析、诊断与 ROM 注入。

- `service.ts` — 解析 circuit XML，诊断组件属性，提供 hover 与文档符号
- `rom.ts` — 定位 ROM 组件并把机器码写入 circuit XML；由 `src/logisim.ts` 调用

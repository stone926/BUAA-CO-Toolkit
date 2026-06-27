# logisim-lsp | src/language/logisim/ | 2 files

Logisim .circ 文件语言支持: XML解析、诊断、ROM注入

lsp-service:
  service.ts — 解析circuit XML, 诊断(组件属性), hover, document symbols | exports: getLogisimDiagnostics, getLogisimHover, getLogisimDocumentSymbols

rom-injection:
  rom.ts — ROM组件定位、机器码写入circuit XML | 被 src/logisim.ts 调用
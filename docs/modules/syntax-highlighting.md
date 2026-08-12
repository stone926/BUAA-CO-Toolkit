# syntax-highlighting | syntaxes/ + scripts/generate-syntaxes.mjs

MIPS、Verilog 与 SystemVerilog 的 TextMate 词法高亮，以及和 LSP semantic tokens 的分层契约。

职责边界:
  TextMate — 注释、字符串/字符/转义、数字、关键字、directive、系统任务、操作符、标点和可由局部语法确定的名称
  Semantic — 指令类别、寄存器、宏/符号引用，以及 Verilog 模块/端口/信号/参数/实例/task/function 等上下文角色
  约束 — semantic provider 不重复发送整段注释、字符串、数字或关键字，避免覆盖主题的嵌套 TextMate scope

single source of truth:
  resources/mips/instructions.json + directives.json + registers.json — MIPS 指令/directive/寄存器目录
  resources/verilog/keywords.json — Verilog keyword group、compiler directive、system task 和 operator 目录
  resources/verilog/systemverilog.json — SystemVerilog 专用 keyword/operator 目录
  scripts/generate-syntaxes.mjs — 从目录确定性生成 grammar，`--check` 检查提交产物是否漂移

grammars:
  syntaxes/mips.tmLanguage.json — MIPS，支持大小写无关指令、同一行 label 后正文、参数/无参宏、字符、FPR、浮点与通用未知 dot-directive
  syntaxes/verilog.tmLanguage.json — Verilog，支持预处理器宏、compiler directive、escaped identifier、系统标识符、数字进制/下划线/unknown digit、字符串续行边界
  syntaxes/systemverilog.tmLanguage.json — 复用 Verilog 底层并增加课程所需 SystemVerilog 关键字、assignment pattern 和 wildcard port

language ids:
  mipsasm — `.asm` / `.s` / `.mips`，TextMate + LSP semantic
  verilog — `.v` / `.vh`，TextMate + LSP semantic
  systemverilog — `.sv` / `.svh`，当前仅 TextMate；刻意不接 Verilog LSP，避免 unsupported SV AST 产生误诊断

主题协作和可选预设见 `docs/semantic-colors.md`。

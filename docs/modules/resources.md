# resources | resources/ + syntaxes/ + snippets/ + language-configuration/ | ~40 files

静态资产, 编译打包进VSIX

resources/mips/:
  instructions.json — 指令元数据(助记符/类型R-I-J-special-pseudo/格式/操作数/描述/延迟槽/Profile)
  instructionMeta.json — 指令附加元数据, projects字段按Profile过滤
  generatorProfiles.json — 内置 ASM 生成器默认指令集、分类、访存对齐、MDU延迟
  pseudoExpansions.json — 伪指令展开模板
  pseudoForms.json — 伪指令操作数形式
  registers.json — 寄存器表(编号/名称/用途)
  cp0Registers.json — CP0寄存器(编号/sel/名称/用途)
  directives.json — 汇编器指令描述+常用值
  syscalls.json — 系统调用表(调用号->服务名/参数/描述)
  加载: src/language/mips/resources.ts

resources/verilog/:
  keywords.json — Verilog保留字(IEEE 1364-2001, 1365+词条)
  lintRules.json — Verilog course lint 规则 catalog: id/title/severity/default/configurable/quickFix

resources/co/:
  configDefaults.json — co.* 配置默认值单一资源, package manifest 与运行时默认值对齐
  configManifest.json — co.* VS Code settings schema 源: 分组/类型/描述/枚举/范围, default 由 configDefaults.json 注入
  courseConfig.json — Profile定义(P0-P7): 名称/描述/能力矩阵/默认项/语言/目录/工具/端口/内存/教程/指令描述/Profile推断hints
  p7Hardware.json — P7 课程硬件布局: 文本段/异常入口/probe/Timer/CP0/中断确认/testbench容量
  加载: courseConfig loader, P7 hardware loader

配置资源维护:
  源文件: resources/co/configManifest.json + resources/co/configDefaults.json + courseConfig/p7Hardware/generatorProfiles/lintRules 等派生输入
  派生产物: package.json contributes.configuration 与 resources/co/configDefaults.json 中的派生默认值
  命令: npm run generate:manifest-config 生成, npm run check:manifest-config 检查, npm run sync:manifest-config 生成后检查
  自动流程: compile/watch/test/test:coverage/test:watch/package:vsix/deploy/publish/release CI 都会先运行 sync:manifest-config
  规则: 不手写 package.json contributes.configuration; 修改配置资源后提交生成结果

resources/templates/verilog/:
  basic_testbench.v — 通用 Verilog testbench shell
  external_memory_testbench.v — P6-style 外部指令/数据存储器 testbench shell
  p7_official_testbench.v — P7 official-style testbench shell
  p7_interrupt_block*.v — P7 external interrupt主动/注释模板
  p7_probe_block.v — P7 probe interrupt/MMIO观测模板
  加载: templateRegistry 受控占位替换

resources/templates/isim/:
  project.prj — ISE PRJ 文件模板
  run.tcl — ISim 批处理运行 TCL 模板
  wave.tcl — ISim GUI 波形 TCL 模板
  vcd.tcl — ISim VCD 导出 TCL 模板
  加载: templateRegistry 受控占位替换

resources/templates/webview/:
  report_page.html — 报告 Webview 页面 shell
  report.css — 报告 Webview 共享 CSS
  加载: templateRegistry 受控占位替换

resources/templates/wizard/:
  p2_main.asm — 项目向导生成的 P2 初始汇编入口
  verilog_top.v — 项目向导生成的 Verilog 顶层模块
  basic_testbench.v — 项目向导解析失败时的基础 testbench fallback
  加载: templateRegistry 受控占位替换

resources/templates/asm/:
  p7_exception_handler*.asm — P7 anchor/hybrid 异常处理模板
  p7_probe_prologue.asm — P7 probe 用户段初始化指令模板, 逐行 emit 保持 PC/预算计数
  p7_probe_handler.asm — P7 probe kernel handler 模板
  加载: templateRegistry 受控占位替换

syntaxes/:
  mips.tmLanguage.json — TextMate语法: MIPS标记分类
  verilog.tmLanguage.json — TextMate语法: Verilog标记分类

snippets/:
  mipsasm.json — MIPS代码片段(指令/模板/syscall)
  verilog.json — Verilog代码片段(always/case/for/if-else/module/testbench)

language-configuration/:
  mipsasm.json — 括号配对/#注释/自动闭合
  verilog.json — 括号配对///和/**/注释/自动闭合

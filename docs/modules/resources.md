# resources | resources/ + syntaxes/ + snippets/ + language-configuration/ | ~15 files

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
  courseConfig.json — Profile定义(P0-P7): 名称/描述/能力矩阵/默认项/语言/目录/工具/端口/内存/教程/指令描述/Profile推断hints
  p7Hardware.json — P7 课程硬件布局: 文本段/异常入口/probe/Timer/CP0/中断确认/testbench容量
  加载: courseConfig loader, P7 hardware loader

resources/templates/verilog/:
  p7_official_testbench.v.tmpl — P7 official-style testbench shell
  p7_interrupt_block*.v.tmpl — P7 external interrupt主动/注释模板
  p7_probe_block.v.tmpl — P7 probe interrupt/MMIO观测模板
  加载: templateRegistry 受控占位替换

resources/templates/wizard/:
  p2_main.asm.tmpl — 项目向导生成的 P2 初始汇编入口
  verilog_top.v.tmpl — 项目向导生成的 Verilog 顶层模块
  basic_testbench.v.tmpl — 项目向导解析失败时的基础 testbench fallback
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

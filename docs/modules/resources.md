# resources | resources/ + syntaxes/ + snippets/ + language-configuration/ | ~40 files

静态资产, 编译打包进VSIX

resources/mips/:
  isa.json — versioned 真实指令唯一 catalog：encoding/runtime/canonical/effects/control/profile，以及 generator 稳定顺序和安全策略
  instructions.json — 指令元数据(助记符/类型R-I-J-special-pseudo/格式/操作数/描述/延迟槽/Profile)
  instructionMeta.json — pseudo/非 catalog 指令及 parser directive 的附加元数据；真实指令 read-write/alignment facts 由 isa.json 生成，不在此重复
  generatorProfiles.json — 从 isa.json 生成的内置 ASM generator 投影（勿手改）：默认指令集、分类、访存对齐、MDU延迟
  pseudoExpansions.json — 伪指令展开模板
  pseudoForms.json — 伪指令操作数形式
  registers.json — 寄存器表(编号/名称/用途)
  cp0Registers.json — CP0寄存器(编号/sel/名称/用途)
  directives.json — 汇编器指令描述+常用值
  syscalls.json — 系统调用表(调用号->服务名/参数/描述)
  加载: src/language/mips/resources.ts

resources/verilog/:
  keywords.json — Verilog keyword group、compiler directive、system task、operator 单一目录，供 lexer/TextMate generator 共用
  systemverilog.json — 独立 SystemVerilog TextMate keyword/operator 目录；不进入 Verilog parser
  lintRules.json — Verilog course lint 规则 catalog: id/title/severity/default/configurable/quickFix

resources/co/:
  configDefaults.json — co.* 配置默认值单一资源, package manifest 与运行时默认值对齐；`co.mips.engine=auto`；外部 Verilog 检查默认 onSave
  configManifest.json — co.* VS Code settings schema 源: 分组/类型/描述/枚举/范围, default 由 configDefaults.json 注入；Verilog 外部检查键为 `syntax.external.mode/timeoutMs`
  courseConfig.json — Profile定义(P0-P7): 名称/描述/能力矩阵/默认项/语言/目录/无条件工具/端口；P1/P4–P7 声明逻辑 `verilogSimulator` 而非固定 ISE，P4–P7 不再声明 MARS/Java，legacy lane 依赖由 toolchainPolicy 动态追加；外置测试台 IM=4096 words、DM=3072 words；指令描述/Profile推断hints
  p7Hardware.json — P7 课程硬件布局: 0x3000 起 4096-word IM、3072-word DM、0x4180 异常入口/probe/Timer/CP0/中断确认/testbench容量
  加载: courseConfig loader, P7 hardware loader

配置资源维护:
  源文件: resources/co/configManifest.json + resources/co/configDefaults.json + courseConfig/p7Hardware/generatorProfiles/lintRules 等派生输入
  派生产物: package.json contributes.configuration 与 resources/co/configDefaults.json 中的派生默认值
  命令: npm run generate:manifest-config 生成, npm run check:manifest-config 检查, npm run sync:manifest-config 生成后检查
  自动流程: compile/test/test:coverage/package:vsix 都会先运行 sync:generated（manifest config + syntaxes）
  规则: 不手写 package.json contributes.configuration; 修改配置资源后提交生成结果

ISA 生成维护:
  源文件: resources/mips/isa.json
  派生产物: src/mips/core/generated/isaCatalog.ts、src/language/mips/generated/isaDisplayCatalog.ts、resources/mips/generatorProfiles.json
  命令: npm run generate:isa-catalog / npm run check:isa-catalog；CI clean checkout 可用 npm run verify:generated-tree-clean 证明 compile 后 tree clean

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

vendor/iverilog/win32-x64/:
  bin/ + lib/ivl/ — 固定的 MSYS2 UCRT64 Icarus 13.0 可执行文件、目标与运行依赖
  THIRD_PARTY_NOTICES.md + licenses/ — 实际分发组件的许可、版权、二进制来源与对应源码说明
  CORRESPONDING_SOURCES.json — 7 个精确 source-only archive 的 URL、大小与 SHA-256

vendor/iverilog/darwin-arm64/ + darwin-x64/:
  bin/ + lib/ivl/ + include/ + share/ — 固定的 Homebrew Icarus 13.0 Sonoma bottle 完整 prefix；分别面向 Apple Silicon 与 Intel，binary deployment target 为 macOS 14
  THIRD_PARTY_NOTICES.md + licenses/ — bottle URL/SHA、Homebrew formula revision、Icarus 许可与上游 v13.0 source URL；运行时不依赖 Homebrew，也不额外携带 dylib
  Git 保留 `bin/iverilog`、`bin/vvp`、`lib/ivl/ivl`、`lib/ivl/ivlpp` 等入口的 executable bit；release workflow 还会在原生 macOS runner 打包前显式恢复并从解包 VSIX 验收

vendor/iverilog/CORRESPONDING_SOURCES.json:
  macOS 两个架构共享的 Icarus v13.0 上游源码清单；release fetch 按 URL/SHA 与 Windows 清单合并去重，GitHub Release 同时附加 `*.src.tar.zst`、`*.tar.gz` 和统一 `SHA256SUMS`

resources/templates/asm/:
  p7_exception_handler*.asm — P7 anchor/hybrid 异常处理模板
  p7_probe_prologue.asm — P7 probe 用户段初始化指令模板, 逐行 emit 保持 PC/预算计数
  p7_probe_handler.asm — P7 probe kernel handler 模板
  加载: templateRegistry 受控占位替换

syntaxes/:
  mips.tmLanguage.json — 从 MIPS 资源生成的 TextMate grammar
  verilog.tmLanguage.json — 从 Verilog catalog 生成的 TextMate grammar
  systemverilog.tmLanguage.json — 复用/扩展 Verilog 的 SystemVerilog 词法 grammar
  维护: npm run generate:syntaxes 生成，npm run check:syntaxes 检查漂移

snippets/:
  mipsasm.json — MIPS代码片段(指令/模板/syscall)
  verilog.json — Verilog代码片段(always/case/for/if-else/module/testbench)

language-configuration/:
  mipsasm.json — 括号配对/#注释/自动闭合
  verilog.json — 括号配对///和/**/注释/自动闭合

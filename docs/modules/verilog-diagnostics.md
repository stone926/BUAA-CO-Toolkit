# verilog-diagnostics | src/language/verilog/ | 14 files | parent: verilog-lsp.md

多类型诊断系统: 语法错误/课程Lint(VC-001~022)/数据流宽度/实例连接/usage/赋值分析/跨文件/外部 Icarus

调度: diagnostics.ts -> syntaxDiag + lintDiag(implicitNet/courseStyle/synthesizable/explicitPortNetType/assignment) + dataflowDiag + instanceConnectionDiag + usageDiag + workspaceDiag + driverDiag

diagnostics-orchestrator:
  diagnostics.ts — collectVerilogModuleDiagnostics: 聚合所有诊断类型

syntax:
  syntaxDiagnostics.ts — 语法错误: 缺失分号/括号不匹配/generate/模块配对, 模块项发现从AST

lint:
  lintDiagnostics.ts — VC-001~022: implicitNet(可配置忽略正则), magicNumber(AST), synthOperator(AST), clockAsData(AST), caseDefault, blockingAssign, nonSynth, courseOutTypes, explicitPortNetType. VC-006/009/011/012/014用block AST sensitivity

dataflow:
  dataflowDiagnostics.ts — 位宽不匹配(width-mismatch), 基于widthOfDecl/widthOfExpressionAst

instance-connection:
  instanceConnectionDiagnostics.ts — 端口连接: 缺失/多余/未连接/宽度不匹配(port-width-mismatch)

usage:
  usageDiagnostics.ts — 未使用信号/参数：Hint + Unnecessary 淡化标记，基于 AST assignment uses+semantic references

driver:
  driverDiagnostics.ts — 多驱动检测：generate 块内声明的同名信号分开统计，同一条件 generate 的不同 if/else 分支互斥不算冲突（generateScopes.ts）

assignment:
  assignmentAnalysis.ts — 从连续/过程赋值提取AssignmentUse(name/operator/range/blockIndex)

workspace:
  workspaceDiagnostics.ts — 跨文件: 模块重复定义/接口一致性；独立模块和替代顶层不再报未实例化提示

external-compiler:
  externalSyntaxProject.ts — 发现与排序外部检查使用的工作区 Verilog 源文件；触发保存的 `.co/tb` testbench 追加在末尾
  externalSyntaxCheck.ts — 通用/on-save 检查固定使用 bundled Icarus
  iverilogSyntaxCheck.ts — bundled Icarus `-tnull -i` 检查与最小 stderr 诊断解析

触发设置: `co.verilog.syntax.external.mode`(`off|onSave|commandOnly`) 与 `co.verilog.syntax.external.timeoutMs`。

迁移: 多数规则基于AST/model, token回退仅限语法错误边界. ARCHITECTURE_REVIEW.md

默认降噪：VC 规则仅开启 005（多 always 驱动）、007（组合非阻塞赋值）、010（时序阻塞赋值）。其余命名/敏感列表偏好/边沿/复位/格式等规则保留显式启用能力；综合建议 `co.verilog.lint.synthesizableHints` 默认关闭。删除每文件 `default_nettype none` 建议及通用 testbench 的 timescale/reset/code.txt 模板提示；时钟诊断仅检查确实声明了时钟的 testbench。VC-010 每块最多一条，混合赋值检查不把 initial 初始化或连续赋值算作过程赋值风格冲突。发布前按 code/range/severity/message 去重。

# verilog-diagnostics | src/language/verilog/ | 10 files | parent: verilog-lsp.md

多类型诊断系统: 语法错误/课程Lint(VC-001~022)/数据流宽度/实例连接/usage/赋值分析/跨文件/ISE

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
  usageDiagnostics.ts — 未使用信号, 基于AST assignment uses+semantic references

driver:
  driverDiagnostics.ts — 多驱动检测

assignment:
  assignmentAnalysis.ts — 从连续/过程赋值提取AssignmentUse(name/operator/range/blockIndex)

workspace:
  workspaceDiagnostics.ts — 跨文件: 模块重复定义/缺失模块/接口一致性

ise:
  iseSyntaxCheck.ts — ISE fuse集成: 调用fuse语法检查, 解析错误输出为Diagnostic[], 支持off/onSave/commandOnly

迁移: 多数规则基于AST/model, token回退仅限语法错误边界. ARCHITECTURE_REVIEW.md
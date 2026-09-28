# verilog-diagnostics | src/language/verilog/ | 12 files | parent: verilog-lsp.md

多类型诊断调度层。`diagnostics.ts` 是唯一入口，按类别分发给各子系统：语法错误、课程 lint、实例连接、usage、驱动冲突、跨文件与外部 Icarus

调度: `diagnostics.ts` → syntaxDiag + lintDiag + instanceConnectionDiag + usageDiag + driverDiag + workspaceDiag（external compiler 见下）

- `diagnostics.ts` — 聚合所有诊断类型
- `syntaxDiagnostics.ts` — 语法错误：缺失分号/括号不匹配/generate/模块配对，模块项从 AST 发现
- `lintDiagnostics.ts` — 未声明标识符、`default_nettype none` 下的隐式 wire、testbench 时钟生成检查
- `instanceConnectionDiagnostics.ts` — 端口连接：缺失/多余/未连接/宽度不匹配
- `usageDiagnostics.ts` — 未使用信号与参数（Hint + Unnecessary 淡化标记）
- `driverDiagnostics.ts` — 多驱动检测；`generateScopes.ts` 让条件 generate 的 if/else 分支互斥，同名信号按作用域分开统计
- `assignmentAnalysis.ts` — 从连续/过程赋值提取 `AssignmentUse`
- `workspaceDiagnostics.ts` — 跨文件：模块重复定义/接口一致性
- `externalSyntaxProject.ts` — 有界发现与排序参与外部检查的 Verilog 源
- `externalSyntaxCheck.ts` — 通用/on-save 检查固定使用 bundled Icarus
- `iverilogSyntaxCheck.ts` — bundled Icarus `-tnull -i` 检查与最小 stderr 诊断解析

**情况说明**

- 绝大多数规则基于 AST / 语义模型；token 回退仅限语法错误边界。发布前按 code/range/severity/message 去重。
- 课程接口检查由 `co.verilog.lint.courseRules` 开关控制；外部检查触发时机由 `co.verilog.syntax.external.mode`（`off` / `onSave` / `commandOnly`）控制。

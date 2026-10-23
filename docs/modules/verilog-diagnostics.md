# verilog-diagnostics | src/language/verilog/ | 14 files | parent: verilog-lsp.md

多类型诊断调度层。`diagnostics.ts` 是唯一入口，按类别分发给各子系统：语法错误、课程 lint、实例连接、usage、驱动冲突、跨文件与外部 Icarus

调度: `diagnostics.ts` → syntaxDiag + lintDiag + instanceConnectionDiag + usageDiag + driverDiag + workspaceDiag（external compiler 见下）

- `diagnostics.ts` — 聚合所有诊断类型
- `syntaxDiagnostics.ts` — 语法错误：缺失分号/括号不匹配/generate/模块配对，模块项从 AST 发现
- `lintDiagnostics.ts` — 未声明标识符、`default_nettype none` 下的隐式 wire、testbench 时钟生成检查
- `instanceConnectionDiagnostics.ts` — 端口连接：缺失/多余/未连接/宽度不匹配
- `usageDiagnostics.ts` — 未使用信号与参数（Hint + Unnecessary 淡化标记）
- `driverDiagnostics.ts` — 多驱动检测；`generateScopes.ts` 让条件 generate 的 if/else 分支互斥，同名信号按作用域分开统计
- `assignmentAnalysis.ts` — 从连续/过程赋值提取 `AssignmentUse`
- `accessPaths.ts` — 声明身份、词法绑定、unpacked 索引与 packed 位区间；宏体在使用位置绑定，层次化成员不冒充本地实例名
- `assignmentTypeDiagnostics.ts` — 左值语法及 parameter/net/variable 赋值目标约束；原调用范围用于宏及实例连接诊断
- `workspaceDiagnostics.ts` — 跨文件：模块重复定义/接口一致性
- `externalSyntaxProject.ts` — 有界发现与排序参与外部检查的 Verilog 源
- `externalSyntaxCheck.ts` — 通用/on-save 检查固定使用 bundled Icarus
- `iverilogSyntaxCheck.ts` — bundled Icarus `-tnull -i` 检查与最小 stderr 诊断解析

**情况说明**

- 绝大多数规则基于 AST / 语义模型；token 回退仅限语法错误边界。发布前按 code/range/severity/message 去重。
- input/output 按实际数据方向判断截断；实例数组接受单实例宽度广播或总宽度分摊。同文件与跨文件复用同一检查。驱动比较保留位区间和数组元素，包含声明初始化、门原语和实例 output 连接；动态索引保守处理，合法 resolved net 不作普通多驱动误报。
- 常量合法性与数值能否求出分开；合法 X/Z 和 constant function 不因求值未知而误报。数组选择逐维检查，保留范围方向并检查 indexed-select 正宽度。
- 课程接口检查由 `co.verilog.lint.courseRules` 开关控制；外部检查触发时机由 `co.verilog.syntax.external.mode`（`off` / `onSave` / `commandOnly`）控制。

# verilog-diagnostics | src/language/verilog/ | 15 files | parent: verilog-lsp.md

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
- `externalDiagnosticLocations.ts` — 基于源码 token 的外部诊断范围映射，以及保留本地精确诊断的合并

**情况说明**

- 绝大多数规则基于 AST / 语义模型；token 回退仅限语法错误边界。发布前按 code/range/severity/message 去重。
- input/output 按实际数据方向判断截断；实例数组接受单实例宽度广播或总宽度分摊。同文件与跨文件复用同一检查。驱动比较保留位区间和数组元素，包含声明初始化、门原语和实例 output 连接；动态索引保守处理，合法 resolved net 不作普通多驱动误报。
- 常量合法性与数值能否求出分开；合法 X/Z 和 constant function 不因求值未知而误报。数组选择逐维检查，保留范围方向并检查 indexed-select 正宽度。
- 课程接口检查由 `co.verilog.lint.courseRules` 开关控制；外部检查触发时机由 `co.verilog.syntax.external.mode`（`off` / `onSave` / `commandOnly`）控制。
- Icarus 行号与显式列号保留不同来源标记。只有行号的通用语法错误，若同一行存在唯一的本地语法错误范围，则保留本地诊断及其代码操作，并将编译器消息关联到该范围；已知消息中唯一出现的标识符定位到源码 token。其余情况标记该行有效代码范围，不猜测前一行或某个运算符。复用全文缓存 token，避免将跨行注释中的名字误认作代码。
- 编辑源码时取消并丢弃受影响工作区的外部检查结果；通过既有输入防抖重发受影响的已打开文档诊断，避免将旧行号映射到新源码。watcher 按索引修订判断实际变化，首次打开文件与内容未变的保存回声不使结果失效。

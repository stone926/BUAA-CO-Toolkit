# verilog-diagnostics | src/language/verilog/ | 22 files | parent: verilog-lsp.md

多类型诊断调度层。生产入口为 diagnosticProvider，复用解析缓存；本地规则由 `diagnostics.ts` 调度，跨文件与预处理检查使用工作区快照。

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
- `constantContextDiagnostics.ts` — 声明/数组/参数/部分选择/重复次数/实例数组/generate 的常量上下文；区分确定运行时依赖、合法常量与未知依赖
- `parameterDependencies.ts` — 按声明身份构建初始化及类型范围依赖，包含常量函数捕获；有界迭代检测循环并报告依赖链
- `concatenationDiagnostics.ts` — 不定宽操作数、负重复次数和最终零宽度结果；允许非零宽度拼接中的零次重复，宏绑定在使用位置
- `declarationDiagnostics.ts` — 从原始声明记录与词法作用域检查名称/方向/范围冲突、重复实例和命名块、旧式端口缺方向；允许合法补充声明和遮蔽
- `declarationDependencies.ts` — 共享未展开 include/声明宏的未知依赖判断；不把缺失模型信息当成确定语义错误
- `subroutineDiagnostics.ts` — 公共签名绑定、实参数量和输出左值，以及 Verilog-2005 函数方向/input/body、时序控制、非阻塞赋值和 task 调用限制
- `preprocessorDiagnostics.ts` — 基于索引 include 快照和宏生命周期发布原始位置诊断；按文档文本及索引修订缓存
- `externalSyntaxProject.ts` — 有界发现与排序参与外部检查的 Verilog 源
- `externalSyntaxCheck.ts` — 通用/on-save 检查固定使用 bundled Icarus
- `iverilogSyntaxCheck.ts` — bundled Icarus `-tnull -i` 检查与最小 stderr 诊断解析
- `externalDiagnosticLocations.ts` — 基于源码 token 的外部诊断范围映射，以及保留本地精确诊断的合并

**情况说明**

- 绝大多数规则基于 AST / 语义模型；token 回退仅限语法错误边界。发布前按 code/range/severity/message 去重。
- input/output 按实际数据方向判断截断；实例数组接受单实例宽度广播或总宽度分摊。同文件与跨文件复用同一检查。驱动比较保留位区间和数组元素，包含声明初始化、门原语和实例 output 连接；动态索引保守处理，合法 resolved net 不作普通多驱动误报。
- 常量合法性与数值能否求出分开；合法 X/Z 和 constant function 不因求值未知而误报。数组选择逐维检查，保留范围方向并检查 indexed-select 正宽度。
- 函数/任务形参按变量建模并保留顺序、方向和类型；旧式 output 的独立 wire/reg 补充声明必须兼容，已知范围按两个端点比较。generate-for 控制使用 genvar，生成体中的迭代值是只读隐式 localparam；显式块和单项生成体各自保留作用域。
- 动态位索引及 indexed part-select 起点合法；声明范围、普通 part-select 两端和 indexed part-select 宽度要求常量。参数初始化在声明位置绑定依赖，宏表达式在使用位置绑定。数学/转换系统函数的常量合法性与数值折叠能力分开。
- 课程接口检查由 `co.verilog.lint.courseRules` 开关控制；外部检查触发时机由 `co.verilog.syntax.external.mode`（`off` / `onSave` / `commandOnly`）控制。
- Icarus 行号与显式列号保留不同来源标记。只有行号的通用语法错误，若同一行存在唯一的本地语法错误范围，则保留本地诊断及其代码操作，并将编译器消息关联到该范围；已知消息中唯一出现的标识符定位到源码 token。其余情况标记该行有效代码范围，不猜测前一行或某个运算符。复用全文缓存 token，避免将跨行注释中的名字误认作代码。
- 编辑源码时取消并丢弃受影响工作区的外部检查结果；通过既有输入防抖重发受影响的已打开文档诊断，避免将旧行号映射到新源码。watcher 按索引修订判断实际变化，首次打开文件与内容未变的保存回声不使结果失效。

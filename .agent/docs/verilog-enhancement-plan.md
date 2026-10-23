# Verilog 语言支持：待完成分析与修复计划

本文件只保留尚未完成的工作。修复或实现并通过回归验证后删除对应条目；实现与验证记录保留在 Conventional Commit 和正式模块文档中。

## 调研依据

2026-10-23 检查了插件 parser、AST、语义模型、诊断、工作区索引和 LSP。现有 Verilog 测试 46 个文件、636 项通过。CPU 主线语料包含 stone P0/P1/P4–P7、alh P4–P7、gyc P1/P4–P7，共 205 个 .v；另有 120 个独立练习变体。均未产生 syntax-*，但主语料没有 function、generate、条件编译和实例参数覆盖，不能据此认为语言覆盖完整。P2/P3 没有 Verilog 源。

代表性回归素材：cpu/stone/p6/MDU.v 的 signed 运算和拼接左值；cpu/stone/p7/CP0.v 的位域宏与宏左值；cpu/stone/p0/v/elevator_tb.v 的 include、延时及 testbench 时钟；cpu/gyc/P5/cpu/cputest.v 的 task 和层次内存访问。

## 已复现、必须修复

1. **工程和符号身份**：工作区不同工程的同名模块被按首个定义解析；P7 alu 实例可能跳到 P4，并产生错误端口宽度告警。模块/端口/宏引用和重命名存在按名称跨工程混合的风险。独立练习合并索引产生 duplicate-module、unknown-port 和 port-width-mismatch。
2. **类型化常量求值**：signed [7:0] S=8'shff 被求成 255，S<0 为 0、S>>>1 为 127；正确为 -1、1、-1。localparam [3:0] P=4'hf+4'h1 被求成 16，正确为 0。time 参数宽度被算成 32 而非 64。$signed/$unsigned 不能作为恒等函数处理。
3. **常量合法性与数值可求值性**：合法 X/Z 常量参数和 constant function 参数被误报 parameter-not-constant。4'd16 的溢出产生“4 bits 与 4 bits”矛盾宽度文案。
4. **作用域与数组**：命名块局部 32 位 x 遮蔽模块 8 位 x，仍按模块类型诊断；二维 unpacked 数组 a[i][j] 被推成 1 位而非元素位宽。mem[4]、mem[0][8]、逆序 part-select 和零宽 indexed-select 漏检。
5. **端口方向**：8 位 output 接父模块 4 位信号漏报截断，反方向却报警；同文件/跨文件应共享检查。
6. **驱动访问路径**：不重叠切片被误报多驱动；实例 output 的切片/拼接、net 初始化和门原语驱动未完整计入。必须保留符号身份、位区间、数组维度和 generate 互斥，兼顾合法 tri/inout。
7. **预处理状态**：ifdef 的失活分支仍参与隐式 net 和多驱动检查；default_nettype none 恢复为 wire 后仍影响后续声明。宏续行、宏参数和宏表达式需要一致的源位置模型。
8. **合法 Verilog-2005 构造**：隐式 generate、实例数组 sub u[3:0](...)、属性 (* keep="true" *) 被拒绝或丢失声明；无名 generate-for 的旧课程限制应放宽为合法语法。
9. **非法语法与赋值目标**：assign a+b=c、空 function 头漏检；parameter 赋值、过程写 wire、Verilog-2005 连续 assign 写 reg、output 连接常量缺少内置诊断。左值语法与类型合法性须分层。
10. **有界求值与错误恢复**：超大字面量按位取反触发 Maximum BigInt size exceeded；缺失模块头分隔符时模块模型可能整体丢失。所有计算应统一限制结果位数/深度/步骤，并保留可恢复节点。
11. **重命名安全**：允许改成关键字 wire 或同作用域已有 b，拒绝合法 a$valid；需要复用词法标识符规则、作用域冲突和目标歧义检查。

## 后续能力（不等同于已复现缺陷）

- 组合逻辑 must-write 路径分析与 latch 提示；敏感列表漏读信号；重复、覆盖和不可达 case 项。不能把缺 else/default 直接当作错误。
- signed/X/Z 风险提示、未驱动信号、可选组合环路分析；黑盒、tri/inout 和有意悬空连接必须可表达。
- function/task 参数数量和方向检查，系统任务格式串和参数验证，testbench 零时间循环分析。
- 作用域与期待类型驱动的补全；function/task/$display/$readmemh 签名；语义选区；解释 signedness/类型转换/参数来源的 hover。
- 更广仿真与库语法：fork/join、event、disable、specify、UDP、defparam。先明确支持与恢复边界。
- SystemVerilog 应独立规划；不能简单让 .sv/.svh 进入现有 Verilog 子集 parser。

## 架构方向

统一工程配置与不可变源码快照，包含源码入口及顺序、include-only 文件、include 路径、宏、方言、顶层、库/黑盒和未保存文档。解析、预处理、符号绑定/类型、参数与 generate 展开、诊断、FS 和 LSP 分层。语法验证消费统一节点，避免模块/过程声明和表达式重复解析。诊断、导航、重构共用符号身份；外部检查使用相同工程输入，按项目修订号丢弃过期结果。

VIDE（本地 e44d7f0f）值得借鉴 CompilationPlan、include_only、分析快照和异步诊断 freshness。它是 Rust LSP + C++ slang + 自有语义层，依赖 pascal-lab/slang 的 vide 分支；Salsa 缓存并不保证每次只增量解析少量 token。未编译/性能验证，需评估方言、多平台打包、FFI/源码映射和分支维护成本。

技术路线：保留 bundled Icarus 的 Verilog-2005 编译/仿真契约；长期重点评估 slang/VIDE 进程后端；Tree-sitter 可用于编辑语法层但不能代替类型与展开；Verible 可辅助语法/格式化，其预处理器并非完整；Verilator 可作为可选深度 lint。不要让多个后端各自猜测工程输入后简单合并告警。

## 产品边界与验收

- 保留明确移除 vc-*、synth-*、mixed-assignment 的产品取舍，不恢复强制风格告警。课程推荐规范不等于语法约束。
- 回归矩阵包括端口方向×宽度×参数、驱动来源×访问路径×作用域、预处理状态序列、真实课程语料、未完成编辑、Windows 空格/中文路径和多工程同名模块。
- 不仅检查语法接受，还检查符号绑定、类型/常量、diagnostic code/range/severity、导航和安全重构。
- 加入冷启动、单字符编辑、跨文件更新延迟和内存基线。Icarus 用于合法性/数值对照，不能作为 latch/竞争不存在的证明。

## 参考

- [VIDE 诊断](https://vide.pascal-lab.net/user-guide/features/diagnostics/)、[项目配置](https://vide.pascal-lab.net/user-guide/project-configuration/)、[Qihe](https://vide.pascal-lab.net/user-guide/features/qihe/)
- [slang parsing](https://www.sv-lang.com/parsing.html)、[slang 方言边界](https://www.sv-lang.com/command-line-ref.html)
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)、[Verible](https://github.com/chipsalliance/verible)、[Verilator warnings](https://verilator.org/guide/latest/warnings.html)、[sv-tests](https://github.com/chipsalliance/sv-tests)

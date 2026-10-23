# Verilog 语言支持：待完成分析与修复计划

本文件只保留尚未完成的工作。修复或实现并通过回归验证后删除对应条目；实现与验证记录保留在 Conventional Commit 和正式模块文档中。

## 调研依据

2026-10-23 检查了插件 parser、AST、语义模型、诊断、工作区索引和 LSP。调研时的 Verilog 测试基线为 46 个文件、636 项通过。CPU 主线语料包含 stone P0/P1/P4–P7、alh P4–P7、gyc P1/P4–P7，共 205 个 .v；另有 120 个独立练习变体。均未产生 syntax-*，但主语料没有 function、generate、条件编译和实例参数覆盖，不能据此认为语言覆盖完整。P2/P3 没有 Verilog 源。

代表性回归素材：cpu/stone/p6/MDU.v 的 signed 运算和拼接左值；cpu/stone/p7/CP0.v 的位域宏与宏左值；cpu/stone/p0/v/elevator_tb.v 的 include、延时及 testbench 时钟；cpu/gyc/P5/cpu/cputest.v 的 task 和层次内存访问。

## 后续能力（不等同于已复现缺陷）

- 组合逻辑 must-write 路径分析与 latch 提示；敏感列表漏读信号；重复、覆盖和不可达 case 项。不能把缺 else/default 直接当作错误。
- signed/X/Z 风险提示、未驱动信号、可选组合环路分析；黑盒、tri/inout 和有意悬空连接必须可表达。
- function/task 参数数量和方向检查，系统任务格式串和参数验证，testbench 零时间循环分析。
- 执行合法 constant function 的函数体；完整展开 include、递归对象宏和函数宏；建立宏生命周期引用后支持含 undef/重定义的安全重命名。
- 作用域与期待类型驱动的补全；function/task/$display/$readmemh 签名；语义选区；解释 signedness/类型转换/参数来源的 hover。
- 更广仿真与库语法：fork/join、event、disable、specify、UDP、defparam。先明确支持与恢复边界。
- SystemVerilog 应独立规划；不能简单让 .sv/.svh 进入现有 Verilog 子集 parser。

## 架构方向

在源集合基础上进一步统一仿真/课程测试的编译上下文，补充 include-only 文件、include 路径、配置宏、方言、顶层、库/黑盒和未保存文档快照。补全按实例参数/generate 的展开图和层次化绑定，使跨层次驱动/引用可精确追踪；继续减少语法验证对表达式的重复解析。外部分析按项目修订号丢弃过期结果，并量测依赖闭包更新成本。

VIDE（本地 e44d7f0f）值得借鉴 CompilationPlan、include_only、分析快照和异步诊断 freshness。它是 Rust LSP + C++ slang + 自有语义层，依赖 pascal-lab/slang 的 vide 分支；Salsa 缓存并不保证每次只增量解析少量 token。未编译/性能验证，需评估方言、多平台打包、FFI/源码映射和分支维护成本。

技术路线：保留 bundled Icarus 的 Verilog-2005 编译/仿真契约；长期重点评估 slang/VIDE 进程后端；Tree-sitter 可用于编辑语法层但不能代替类型与展开；Verible 可辅助语法/格式化，其预处理器并非完整；Verilator 可作为可选深度 lint。不要让多个后端各自猜测工程输入后简单合并告警。

## 产品边界与验收

- 保留明确移除 vc-*、synth-*、mixed-assignment 的产品取舍，不恢复强制风格告警。课程推荐规范不等于语法约束。
- 后续新诊断继续增加可编译反例和真实工具对照，特别覆盖有意 latch、优先 case、黑盒、动态索引和不完整工程，防止恢复已移除的风格噪声。
- 不仅检查语法接受，还检查符号绑定、类型/常量、diagnostic code/range/severity、导航和安全重构。
- 加入冷启动、单字符编辑、跨文件更新延迟和内存基线。Icarus 用于合法性/数值对照，不能作为 latch/竞争不存在的证明。

## 参考

- [VIDE 诊断](https://vide.pascal-lab.net/user-guide/features/diagnostics/)、[项目配置](https://vide.pascal-lab.net/user-guide/project-configuration/)、[Qihe](https://vide.pascal-lab.net/user-guide/features/qihe/)
- [slang parsing](https://www.sv-lang.com/parsing.html)、[slang 方言边界](https://www.sv-lang.com/command-line-ref.html)
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)、[Verible](https://github.com/chipsalliance/verible)、[Verilator warnings](https://verilator.org/guide/latest/warnings.html)、[sv-tests](https://github.com/chipsalliance/sv-tests)

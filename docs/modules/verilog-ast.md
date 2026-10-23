# verilog-ast | src/language/verilog/ | 15 files | parent: verilog-lsp.md

递归下降解析器的 AST 构建层：表达式 AST、过程语句 AST、always/initial 块 AST，加遍历/匹配/赋值分析工具。全部基于 token 与语义模型构建，token 回退仅用于语法错误边界。

- `exprAst.ts` — 递归下降表达式解析与整数常量求值
- `typedConstants.ts` — 位宽、signed 与 X/Z 掩码的四态整数模型；运算上下文传播、packed 索引映射、常量观察器与统一计算预算
- `constantFunctions.ts` — 基于局部作用域、引用及过程控制判断函数的常量表达式合法性；不执行用户函数体
- `constantFunctionCaptures.ts` — 常量函数按绑定声明记录参数捕获和调用依赖；静态不可达分支可裁剪，未知分支保留依赖
- `systemFunctionConstants.ts` — 数学/转换常量系统函数、确定运行时函数和未知系统调用的共享分类
- `expressionTraversal.ts` — 模块、作用域声明、实例、生成控制和过程树的统一表达式根遍历
- `generateControls.ts` — generate if/case/for 的条件、标签、初始化、更新及生成体范围；保留内联 genvar 和隐式迭代参数
- `generateBoundary.ts` — 单个生成项的有界边界解析，支持无 begin/end 的嵌套 if/for 和过程项
- `proceduralAst.ts` — 过程语句 AST（block/if/case/loop/assign/声明/控制/systemTask/子程序调用），malformed 时有 token fallback
- `blockAst.ts` — always/initial 块：sensitivity list、header control 与内部语句树
- `exprAstUtils.ts` — AST 遍历与"最小包含表达式"定位
- `assignmentAst.ts` — 从连续赋值与过程赋值收集 `AssignmentUse`
- `astTokens.ts` — code tokens / statement tokens 提取
- `gatePrimitives.ts` — 内建门级原语关键字集
- `ast.ts` — `VerilogAstDocument` / `VerilogModuleAst` 顶层结构与 generate 控制表达式（排除过程块与子程序）

**AST 类型层级**

- 表达式：number/string literal、identifier、select（位选择与 `[+:-]`）、call、member、concatenation、multiple concatenation、unary/binary/conditional、parenthesized、mintypmax
- 过程语句：block（begin-end / fork-join）、if、case（casex/casez）、loop（for/forever/repeat/while）、assignment（`=`/`<=`）、localDeclaration、control（delay/event/wait）、systemTask、subroutineCall
- 块：alwaysBlock / initialBlock + header（sensitivity + event/delay control）

**情况说明**

- 连续赋值节点使用 `assignments[]` 保留同句中每个 lvalue/RHS，诊断、引用、驱动分析与表达式提取共享此模型。
- wait 有独立条件和受控语句树；命名块标签在共享语句入口规范化，生成体首项不会被标签遮挡。单项 generate 保留隐式作用域和叶子模块项。
- `(min:typ:max)` 保留三个表达式分支；默认 bundled Icarus 配置下的整数求值采用 typical 分支。子程序签名、原始声明记录与可查找名称索引分离，保留重复声明证据。
- 实数字面量进入 `numberLiteral`，但不参与整数常量折叠或位宽推断。
- 缺失 `endmodule` 或闭合分隔符时在下一个 module 恢复，不吞掉后续模块。
- 解析和求值对深表达式、巨型结果位数及运算步数设置预算；超限返回未知值或恢复节点，不向上抛出 BigInt/递归异常。
- 赋值、比较、条件和嵌套移位按共同上下文计算；位选择保留声明坐标和方向，越界位为 X。重构和 hover 复用完整表达式求值时的子节点结果。

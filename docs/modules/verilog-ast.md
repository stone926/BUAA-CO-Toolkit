# verilog-ast | src/language/verilog/ | 10 files | parent: verilog-lsp.md

递归下降解析器的 AST 构建层：表达式 AST、过程语句 AST、always/initial 块 AST，加遍历/匹配/赋值分析工具。全部基于 token 与语义模型构建，token 回退仅用于语法错误边界。

- `exprAst.ts` — 递归下降表达式解析与整数常量求值
- `typedConstants.ts` — 位宽、signed 与 X/Z 掩码的四态整数模型；运算上下文传播、packed 索引映射、常量观察器与统一计算预算
- `constantFunctions.ts` — 基于局部作用域、引用及过程控制判断函数的常量表达式合法性；不执行用户函数体
- `proceduralAst.ts` — 过程语句 AST（block/if/case/loop/assign/声明/控制/systemTask/子程序调用），malformed 时有 token fallback
- `blockAst.ts` — always/initial 块：sensitivity list、header control 与内部语句树
- `exprAstUtils.ts` — AST 遍历与"最小包含表达式"定位
- `assignmentAst.ts` — 从连续赋值与过程赋值收集 `AssignmentUse`
- `astTokens.ts` — code tokens / statement tokens 提取
- `gatePrimitives.ts` — 内建门级原语关键字集
- `ast.ts` — `VerilogAstDocument` / `VerilogModuleAst` 顶层结构与 generate 控制表达式（排除过程块与子程序）

**AST 类型层级**

- 表达式：number/string literal、identifier、select（位选择与 `[+:-]`）、call、member、concatenation、multiple concatenation、unary/binary/conditional、parenthesized、assignment pattern
- 过程语句：block（begin-end / fork-join）、if、case（casex/casez）、loop（for/forever/repeat/while）、assignment（`=`/`<=`）、localDeclaration、control（delay/event/wait）、systemTask、subroutineCall
- 块：alwaysBlock / initialBlock + header（sensitivity + event/delay control）

**情况说明**

- 连续赋值节点使用 `assignments[]` 保留同句中每个 lvalue/RHS，诊断、引用、驱动分析与表达式提取共享此模型。
- 实数字面量进入 `numberLiteral`，但不参与整数常量折叠或位宽推断。
- 缺失 `endmodule` 或闭合分隔符时在下一个 module 恢复，不吞掉后续模块。
- 解析和求值对深表达式、巨型结果位数及运算步数设置预算；超限返回未知值或恢复节点，不向上抛出 BigInt/递归异常。
- 赋值、比较、条件和嵌套移位按共同上下文计算；位选择保留声明坐标和方向，越界位为 X。重构和 hover 复用完整表达式求值时的子节点结果。

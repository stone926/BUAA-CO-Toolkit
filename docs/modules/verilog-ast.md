# verilog-ast | src/language/verilog/ | 8 files | parent: verilog-lsp.md

递归下降解析器的 AST 构建层：表达式 AST、过程语句 AST、always/initial 块 AST，加遍历/匹配/赋值分析工具。全部基于 token 与语义模型构建，token 回退仅用于语法错误边界。

- `exprAst.ts` — 递归下降表达式解析与整数常量求值
- `proceduralAst.ts` — 过程语句 AST（block/if/case/loop/assign/声明/控制/systemTask/子程序调用），malformed 时有 token fallback
- `blockAst.ts` — always/initial 块：sensitivity list、header control 与内部语句树
- `exprAstUtils.ts` — AST 遍历与"最小包含表达式"定位
- `assignmentAst.ts` — 从连续赋值与过程赋值收集 `AssignmentUse`
- `astTokens.ts` — code tokens / statement tokens 提取
- `gatePrimitives.ts` — 内建门级原语关键字集
- `ast.ts` — `VerilogAstDocument` / `VerilogModuleAst` 顶层结构

**AST 类型层级**

- 表达式：number/string literal、identifier、select（位选择与 `[+:-]`）、call、member、concatenation、multiple concatenation、unary/binary/conditional、parenthesized、assignment pattern
- 过程语句：block（begin-end / fork-join）、if、case（casex/casez）、loop（for/forever/repeat/while）、assignment（`=`/`<=`）、localDeclaration、control（delay/event/wait）、systemTask、subroutineCall
- 块：alwaysBlock / initialBlock + header（sensitivity + event/delay control）

**情况说明**

- 连续赋值节点使用 `assignments[]` 保留同句中每个 lvalue/RHS，诊断、引用、驱动分析与表达式提取共享此模型。
- 实数字面量进入 `numberLiteral`，但不参与整数常量折叠或位宽推断。
- 缺失 `endmodule` 或闭合分隔符时在下一个 module 恢复，不吞掉后续模块。

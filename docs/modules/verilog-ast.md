# verilog-ast | src/language/verilog/ | 8 files | parent: verilog-lsp.md

递归下降解析器AST构建层: 表达式AST(40+节点)/过程块AST/block AST + 遍历/匹配/赋值分析工具

AST类型层级:
  VerilogExpressionAst: numberLiteral/stringLiteral/identifier/selectExpression(位选择/部分选择[+:-])/callExpression/memberExpression/concatenation/multipleConcatenation/unaryExpression/binaryExpression/conditionalExpression/parenthesizedExpression/assignmentPattern
  VerilogProceduralStatementAst: block(begin-end/fork-join)/if/case(casex/casez)/loop(for/forever/repeat/while)/assignment(=/<=)/localDeclaration/control(delay/event/wait)/systemTask/subroutineCall
  VerilogBlockAst: alwaysBlock/initialBlock, header(sensitivity+event/delay control)

expr-ast:
  exprAst.ts — 递归下降表达式解析器(1265行), parseVerilogExpression, evalVerilogIntegerConstant

procedural-ast:
  proceduralAst.ts — 过程语句AST(632行), parseVerilogProceduralStatement, VerilogCaseStatementAst. Malformed有token fallback

block-ast:
  blockAst.ts — always/initial块解析: sensitivity list AST(显式信号/*/posedge/negedge), header control AST, 内部语句树

expr-ast-utils:
  exprAstUtils.ts — walkVerilogExpression, findSmallestVerilogExpressionAtOffset, findSmallestVerilogExpressionMatchAtOffset

assignment-ast:
  assignmentAst.ts — collectAssignmentUsesFromModuleAst: 从连续+过程赋值收集AssignmentUse

ast-tokens:
  astTokens.ts — verilogAstCodeTokens(过滤排序), verilogAstStatementTokens(枚举)

gate-primitives:
  gatePrimitives.ts — 内建门级原语关键字集(and/or/not/buf/...)

ast:
  ast.ts — VerilogAstDocument/VerilogModuleAst/VerilogStatementAst(详见verilog-lsp.md core)
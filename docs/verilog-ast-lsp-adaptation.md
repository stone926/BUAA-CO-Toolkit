# Verilog AST Parser 与 LSP/VSCode 插件适配分析

## 当前适配关系

BUAA CO Toolkit 的 VSCode 客户端只负责启动 `out/server.js` 并注册标准 LSP 能力；Verilog 语言功能主要集中在 `src/language/verilog/service.ts`。因此 AST parser 不需要直接依赖 VSCode API，只要在 server 侧的 parse result 中提供结构化数据，hover、diagnostics、code action、signature help、inlay hint、semantic tokens 都能消费。

当前 Verilog 管线是：

```text
VSCode document
  -> LSP server.ts
  -> getCachedVerilogParse()
  -> parseVerilog()
  -> CST + module model + VerilogAstDocument + semantic model
  -> service.ts providers
```

表达式 AST 已挂在 `VerilogStatementAst.expressions` 和 `VerilogStatementAst.assignment` 上。`expressions.ts` 的位宽推断也已经改为 AST 遍历，而不是 token 串模式匹配。新增的 `exprAstUtils.ts` 提供表达式子节点、遍历和按 offset 查找最小表达式节点的能力，避免各个 LSP provider 重复写递归逻辑。

## AST Parser 已能提供的 LSP 能力

1. 表达式级 hover
   - 光标在运算符或表达式范围内时，LSP 可以找到最小 AST 节点。
   - 当前 hover 显示表达式文本、AST 节点类型、推断宽度和可求值常量。

2. 参数化位宽诊断
   - `parameter/localparam` initializer 会保存到声明模型中。
   - 常量求值支持参数依赖，例如 `WIDTH - 1`。
   - 本文件和跨文件端口宽度检查可以解析 `[WIDTH-1:0]`。
   - 连续赋值和过程块内赋值复用 `VerilogStatementAst.assignment`，声明初始化也使用 AST width inference。
   - 赋值、声明初始化和实例连接中的常量除零/取模零会通过 AST walker 诊断。
   - 实例 `#(...)` 参数 override 会参与同文件和跨文件端口宽度推断，并重新求值依赖参数的 `localparam`。

3. 声明 hover 增强
   - 参数声明 hover 除了显示声明详情和宽度，还能显示已求值的常量值。

4. 表达式重构 code action
   - 可求值且非平凡的表达式可以折叠为常量值。
   - 连续赋值 RHS 中的可求值常量表达式可以提取为唯一命名的 `localparam`。
   - 对 `(a)`、`(bus[0])`、`((a))` 这类语义明确安全的场景提供去除冗余括号动作。
   - 对 `(a + b) * c` 这类依赖括号保持优先级的表达式保持静默。

5. 后续重构基础
   - 已有 AST 节点包含一元、二元、三目、拼接、重复拼接、选择、调用和成员访问。
   - Code action 可以基于 AST 做精确范围替换，而不用重新猜运算符优先级。

## 适合继续基于 AST 推进的功能

中期可做：

- AST 驱动引用收集：semantic model 逐步从 token 扫描迁移到 expression walker。
- 表达式 refactor：提取表达式为 wire/localparam、转换有序连接中的复杂表达式。

## 设计边界

- AST parser 保持在语言服务器内部，不直接调用 VSCode API。
- VSCode 插件无需新增客户端协议；标准 LSP provider 已足够承载这些能力。
- 对不完整或无法求值表达式保持静默返回，不生成误导性诊断。
- 参数常量求值仅解析 `parameter/localparam` 的纯表达式依赖；遇到 `$clog2`、未知标识符或循环引用时返回 unknown。

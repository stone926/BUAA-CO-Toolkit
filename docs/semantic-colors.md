# 语法高亮与语义分类

插件采用两层高亮，职责刻意分离：

- TextMate 提供始终可用的词法分类：注释、字符串及转义、字符、数字进制、关键字、编译指令、系统任务、操作符和标点。
- LSP semantic tokens 只补充必须理解上下文才能确定的角色：指令类别、寄存器、标签、宏、模块、端口、信号、参数、实例、task 和 function。

即使关闭 VS Code semantic highlighting，源码仍有完整的词法高亮；开启后，语义层也不会用整段字符串或注释覆盖主题已有的细粒度 TextMate scope。

## 颜色完全由 VS Code 管理

插件不包含深色、浅色或高对比度配色表，不注册颜色预设，也不监听主题变化。升级时，一次性迁移只删除旧版本曾自动写入、且当前值仍与旧记录完全相同的全局规则；用户修改过的规则会保留。迁移状态清除后，插件不再读取或写入 `editor.semanticTokenColorCustomizations`。

插件只声明 token 的语义身份：

- 每个自定义 semantic token 都有 VS Code 标准 `superType`，例如 `macro`、`function`、`variable`、`parameter`、`property` 和 `class`。
- 每个 token 都有 TextMate scope fallback，供没有直接识别自定义 token 的主题匹配。
- 最终前景色、字体样式及高对比度表现均由 VS Code 当前主题和用户自己的编辑器设置决定。

## Semantic token 分类

MIPS：

- `mipsInstruction` / `mipsRealInstruction`
- `mipsRInstruction` / `mipsIInstruction` / `mipsJInstruction`
- `mipsSpecialInstruction` / `mipsPseudoInstruction`
- `mipsRegister` / `mipsCp0Register`
- `mipsMacro` / `mipsMacroParameter`
- `mipsLabel` / `mipsDataSymbol` / `mipsEqvSymbol`

Verilog：

- `verilogModule` / `verilogInstance`
- `verilogPort` / `verilogSignal` / `verilogParameter`
- `verilogMacro`
- `verilogTask` / `verilogFunction`

`co.mips.instructionTokenMode` 只控制 MIPS 指令 semantic token 的分类粒度，不包含或选择任何颜色。设置变化后 LSP 会清理对应 token 缓存并请求 VS Code 刷新，具体显示仍完全由主题决定。

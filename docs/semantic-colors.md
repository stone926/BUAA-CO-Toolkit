# 语法高亮与语义着色

插件采用两层高亮，职责刻意分离：

- TextMate 提供始终可用的词法底色：注释、字符串及转义、字符、数字进制、关键字、编译指令、系统任务、操作符和标点。
- LSP semantic tokens 只补充必须理解上下文才能确定的角色：指令类别、寄存器、标签、宏、模块、端口、信号、参数、实例、task 和 function。

这样即使关闭 VS Code semantic highlighting，源码仍有完整、稳定的词法高亮；开启后，语义层也不会用整段字符串或注释覆盖主题已有的细粒度 TextMate scope。

## 默认主题行为

`co.semanticColors.preset` 默认为 `off`。插件不再默认修改全局 `editor.semanticTokenColorCustomizations`，而是让当前主题通过 semantic token 的标准 `superType` 和 TextMate scope fallback 决定颜色。

可选值：

- `off`：不写入 CO 配色；同时安全清理插件以前写入且用户未改动的规则。
- `auto`：普通深色/浅色主题分别使用插件预设；高对比度主题保持由主题控制。
- `dark`：显式使用深色预设。
- `light`：显式使用浅色预设。

`auto`、`dark` 和 `light` 是显式 opt-in，会修改全局用户配置，但不会覆盖已经由用户修改的同名 token 规则。读取和写入只针对 Global 层，不会把 Workspace、Remote 或 Profile 层的合并结果复制到全局。

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

所有自定义 token 都在 `package.json` 声明了标准 `superType`，例如 macro、function、variable、parameter、property 和 class。主题无需认识本插件的 token 名也能给出合理底色。

## 手动自定义示例

```jsonc
{
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "mipsRInstruction": "#9CDCFE",
      "mipsIInstruction": "#4EC9B0",
      "mipsJInstruction": "#569CD6",
      "mipsCp0Register": "#B8D7FF",
      "verilogModule": "#4EC9B0",
      "verilogPort": "#9CDCFE",
      "verilogParameter": "#D7BA7D",
      "verilogMacro": "#C586C0"
    }
  }
}
```

MIPS 指令语义分类由 `co.mips.instructionColorMode` 控制。设置变化后 LSP 会清理对应 token 缓存并请求 VS Code 立即刷新，无需重新打开文件。

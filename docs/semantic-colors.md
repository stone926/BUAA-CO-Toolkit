# 语义着色配色预设

插件默认对 MIPS ASM 和 Verilog 开启 semantic highlighting，并根据当前 VS Code 主题明暗自动写入 CO 自定义 semantic token 的深色或浅色配色。

自动配色只管理本插件自己的 token（例如 MIPS R/I/J 型指令、CP0 寄存器、Verilog 模块/端口），并且不会覆盖你已经手动修改过的同名 token 规则。可以用 `co.semanticColors.preset` 控制行为：

- `auto`：默认，根据当前主题明暗自动选择深色或浅色预设。
- `dark`：始终使用深色预设。
- `light`：始终使用浅色预设。
- `off`：清理插件上次自动写入且你未改动的 CO token 规则，之后完全交给主题和用户配置。

下面是自动预设使用的颜色；也可以手动复制到 VS Code `settings.json` 自定义。

## 深色主题预设

```jsonc
{
  "[mipsasm]": {
    "editor.semanticHighlighting.enabled": true
  },
  "[verilog]": {
    "editor.semanticHighlighting.enabled": true
  },
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "mipsDirective": "#C586C0",
      "mipsInstruction": "#9CDCFE",
      "mipsRealInstruction": "#9CDCFE",
      "mipsRInstruction": "#9CDCFE",
      "mipsIInstruction": "#4EC9B0",
      "mipsJInstruction": "#569CD6",
      "mipsSpecialInstruction": "#F44747",
      "mipsPseudoInstruction": "#D7BA7D",
      "mipsRegister": "#4FC1FF",
      "mipsCp0Register": "#B8D7FF",
      "mipsMacro": "#569CD6",
      "mipsMacroParameter": "#FFCB6B",
      "mipsLabel": "#C586C0",
      "mipsDataSymbol": "#DCDCAA",
      "mipsEqvSymbol": "#C3E88D",
      "mipsNumber": "#B5CEA8",
      "mipsString": "#CE9178",
      "mipsComment": "#6A9955",
      "mipsPunctuation": "#D4D4D4",
      "verilogModule": "#4EC9B0",
      "verilogPort": "#9CDCFE",
      "verilogSignal": "#9CDCFE",
      "verilogParameter": "#D7BA7D",
      "verilogInstance": "#DCDCAA",
      "verilogMacro": "#C586C0",
      "verilogSystemTask": "#D7BA7D",
      "verilogNumber": "#B5CEA8",
      "verilogKeyword": "#569CD6",
      "verilogComment": "#6A9955",
      "verilogString": "#CE9178",
      "verilogFormatSpecifier": "#D7BA7D",
      "verilogPunctuation": "#D4D4D4"
    }
  }
}
```

## 浅色主题预设

```jsonc
{
  "[mipsasm]": {
    "editor.semanticHighlighting.enabled": true
  },
  "[verilog]": {
    "editor.semanticHighlighting.enabled": true
  },
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "mipsDirective": "#AF00DB",
      "mipsInstruction": "#001080",
      "mipsRealInstruction": "#001080",
      "mipsRInstruction": "#001080",
      "mipsIInstruction": "#267F99",
      "mipsJInstruction": "#0000FF",
      "mipsSpecialInstruction": "#A31515",
      "mipsPseudoInstruction": "#795E26",
      "mipsRegister": "#0070C1",
      "mipsCp0Register": "#0451A5",
      "mipsMacro": "#0000FF",
      "mipsMacroParameter": "#B000B0",
      "mipsLabel": "#AF00DB",
      "mipsDataSymbol": "#795E26",
      "mipsEqvSymbol": "#098658",
      "mipsNumber": "#098658",
      "mipsString": "#A31515",
      "mipsComment": "#008000",
      "mipsPunctuation": "#000000",
      "verilogModule": "#267F99",
      "verilogPort": "#001080",
      "verilogSignal": "#001080",
      "verilogParameter": "#795E26",
      "verilogInstance": "#795E26",
      "verilogMacro": "#AF00DB",
      "verilogSystemTask": "#795E26",
      "verilogNumber": "#098658",
      "verilogKeyword": "#0000FF",
      "verilogComment": "#008000",
      "verilogString": "#A31515",
      "verilogFormatSpecifier": "#795E26",
      "verilogPunctuation": "#000000"
    }
  }
}
```

## 主题协作规则

- 主题直接定义了这些 semantic token 颜色时，使用主题颜色。
- 主题只定义标准 token（如 `function`、`variable`、`class`）时，本插件 token 通过 `superType` 继承基础颜色。
- 主题开启 semantic highlighting 但没有匹配规则时，VS Code 使用插件声明的 `semanticTokenScopes` 回退到 TextMate scope。
- 主题未开启 semantic highlighting 时，只使用 TextMate grammar；MIPS 指令类型、CP0 等语义差异不会显示为不同颜色。

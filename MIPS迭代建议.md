# MIPS ASM 语言支持迭代建议

## 语法检查增强

### `.data`/`.text` 段地址验证

课程固定使用 MARS 的 `CompactDataAtZero` 内存配置，地址布局如下：

| 区域 | 地址范围 | 容量 |
|------|----------|------|
| `.data` (DM) | `0x0000_0000 ~ 0x0000_2FFF` | 12 KiB (3072 字) |
| `.text` (IM) | `0x0000_3000 ~ 0x0000_6FFF` | 16 KiB (4096 字) |
| `.ktext` 异常入口 | `0x0000_4180` | 在 IM 范围内 |
| PC 初始值 | `0x0000_3000` | — |

课程 P2 明确要求：**测试平台使用 `CompactDataAtZero` 参数，如果 `.data` 指令后面带有参数，程序会编译错误**。因此课程中不允许 `.data`/`.text` 带地址参数

**建议**：
- 当 `.data` 或 `.text` 带地址参数时，给出 error："课程要求使用默认段地址（CompactDataAtZero），不允许自定义段地址"
- 当 `.data` 中的地址超出 `0x0000_0000 ~ 0x0000_2FFF` 范围时，给出 warning
- 当 `.text` 中的地址超出 `0x0000_3000 ~ 0x0000_6FFF` 范围时，给出 warn

### 未初始化寄存器使用警告

**建议**：在 P2 profile 下，检测 `$v0` 在 `syscall` 前是否被赋值

### `.space` 对齐提示

课程教程明确指出：".space 应使用 4 的倍数以确保字对齐"

## LSP 功能增强

### syscall 编号

当前 `getMipsCompletions` 在 `li $v0, ` 后不提供 syscall 编号提示

**建议**：

1. 检测 `li $v0, ` 模式后，补全列表中添加系统调用相关提示

2. 在 hover 和 Inlay Hint 显示 syscall 对应哪个调用

### CP0 寄存器名

1. 在 `mfc0 $rt, ` 或 `mtc0 $rt, ` 后，补全常用 CP0 寄存器相关提示

2. 在 hover 和 Inlay Hint 显示 CP0 寄存器的名称，hover 中额外显示寄存器说明和各字段含义

### 宏展开预览

当前宏 hover 显示宏体源码。可以在 hover 中添加展开预览，展示宏调用时参数替换后的展开结果

### 引用查找增强

#### 数据段符号的内存引用

确保以下形式都被正确追踪：
- `.word label` - 数据段中的 label 引用
- `la $a0, label` - 伪指令加载地址
- `lw $t0, label` - 伪指令形式加载（MARS 展开为 `lui $at, upper; lw $t0, lower($at)`）
- `sw $t0, label` - 伪指令形式存储

### MARS 伪指令展开提示

**建议**：hover 展示伪指令展开后的结果

**示例**：
```
li $t0, 0x12345678
```
展开为：
```
lui $at, 0x1234
ori $t0, $at, 0x5678
```
### 缺失的高亮

- CP0 寄存器名（如 `$12`、`$13`、`$14`）可以与普通寄存器不同高亮
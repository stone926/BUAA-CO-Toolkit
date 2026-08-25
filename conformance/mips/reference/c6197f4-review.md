# c6197f4 课程语义修复审查结论

> 审查日期：2026-08-25
> 审查对象：`Mars-with-BUAA-CO-extension` 的 `c6197f433e20ac0800a48ea1255053147ade5a77`
> （tag `v0.6.3` = `8b53a492dddc4fe1c62a7a02c55bea6fc4fb49d8` 之后一个 commit）
> 结论：**接受**，作为 `legacy-course-executor` 角色归档，发布新 tag `v0.6.3-course1`
> （见 `legacy-executor-build.md`）。该结论已登记为 ledger 决策（本文件被
> `reference-manifest.json` 的 `legacy-course-executor` 条目引用）。

## 1. 审查范围

`git diff 8b53a49..c6197f4` 共 39 个文件，+1104/−45：

| 文件 | 改动 | 分类 |
| --- | --- | --- |
| `mars/simulator/Simulator.java` | +328：courseHalt 检测状态机、P7 fetch 域检查（对齐 + `0x3000` 下界 + 上界/未加载区域）、P7 kernel text 快照、IG 精确应答契约 `0xa0007f20` | P7 契约 |
| `mars/mips/hardware/Memory.java` | +51：`validateCourseDataAddress`（DM `0..0x2fff` + P7 Timer/IG 窗口）、segment 上界从排他改含端点（课程模式） | 地址域 |
| `mars/mips/instructions/InstructionSet.java` | +74：`effectiveAddress` 增加 length 参数并接入课程地址校验 | 地址域 |
| `mars/mips/hardware/RegisterFile.java` | +14：`resetGeneralPurposeRegisters`（全部 GPR 复位为 0） | 复位态 |
| `mars/MarsLaunch.java` | +100：CLI 参数 `coHalt=<addr>` / `coZeroGpr` / `coStrictData`；课程调用自动启用 efc/p7irq；coHalt 目标必须是标准 beq-self+nop 环 | CLI |
| `mars/ProcessingException.java` | +27：`courseContractViolation` 工厂 | P7 契约 |
| `mars/Settings.java` | +13：新设置项 | CLI |
| `README.md`、`help/MarsHelpCommand.html` | 文档同步 | 文档 |
| `test/` | 新增 `course_halt/`（13 个停机尾向量）、`p7/`（数据地址映射回归）、`strict_data/`（4 个地址域向量） | 测试 |

## 2. 逐项审查

### 2.1 停机尾验证（coHalt）

`configureCourseHalt` 快照课程文本边界与 P7 kernel 前缀；执行到目标 beq-self 且在 nop 延迟槽成功提交后报告
`Program reached course halt loop at <pc>`，否则按三类失败（提前终止 / 步数耗尽 / 非法目标）拒绝。

**与插件对照**：插件 `marsStepLimit.ts` 的 `courseTraceMarsHaltError` 同时识别该 marker（正则
`Program reached course halt loop at`）与旧 coL2 路径（`0x1000ffff` 指令头），即插件已兼容
c6197f4 与 v0.6.3 两种构建。c6197f4 使停机判定从"插件解析 trace"变为"MARS 原生裁决 + 插件复核"的双保险。

### 2.2 课程数据地址域（coStrictData / validateCourseDataAddress）

限制模拟 load/store 有效地址到课程数据映射（DM `0..0x2fff`；efc 模式下另加
Timer0 `0x7f00..0x7f0b`、Timer1 `0x7f10..0x7f1b`、IG `0x7f20..0x7f23`）。

**与插件对照**：插件 `marsOracleCompatibility.ts` 的 `stableMarsCourseAddressError` 在 TS 侧
实现同样的拒绝（并额外覆盖 EA 加法溢出、SWL/SWR 跨度、P7 只有 word 宽 Timer 访问）。
二者互为双保险，行为方向一致（拒绝 MARS-only 段访问作为 oracle）。

### 2.3 课程复位态（coZeroGpr）

全部 GPR 复位值改 0，消除 `$gp=0x1800/$sp=0x2ffc` 的 Compact 播种。

**与插件对照**：插件不依赖该参数——`courseTestToolchain.ts` 探针校验 Compact 初值存在、
`marsDetailedUndefinedBehaviorError` 动态拒绝首次初始化前的 `$gp/$sp` 读取。若 legacy executor
切换为 coZeroGpr 运行，该初态差异将不再存在，但 TS 侧检查保持兼容两种构建。

### 2.4 P7 fetch 域与 IG 契约

fetch 检查：PC 对齐 + `>=0x3000` + 上界（halt 延迟槽 / kernel 快照 / 合法 IM 末端）。
IG 访问：仅允许已装载 handler 内的精确 `0xa0007f20`（`sb $0,0x7f20($0)`）作为应答。

**与插件对照**：插件 `marsImageCompatibility.ts` 已在 TS 侧完整实现 fetch 域校验
（`dynamicFetchImageError`）、IG 精确应答与静态兜底（`unobservableP7InterruptGeneratorError`）。
c6197f4 的 JVM 侧实现与之等价，且直接产生 ProcessingException 而非事后 trace 校验。

### 2.5 Segment 上界含端点

课程模式下 `inTextSegment` 等把配置上界从排他改为含端点——修复
`MARS-DIV-COMPACT-001`（4095-word 上界）的 JVM 侧行为。

**与插件对照**：插件 `machineCodeValidation.ts` 仍按 v0.6.3 行为执行 4095-word 校验；
若 conformance 使用 legacy-course-executor，该差异条目需按执行 reference 角色重核。

## 3. 结论

- 全部改动方向与课程契约（`contracts.json`）一致，无逆向改动；新增测试向量覆盖停机尾、
  P7 数据地址映射与 strict data 边界。
- 发布：以 `c6197f4` 打 tag `v0.6.3-course1`，构建产物作为不可变 `legacy-course-executor` 资产。
- 归档：`reference-manifest.json` 已记录 release 资产的精确字节数与 SHA-256；
  `MARS-DIV-COMPACT-001` 与 `MARS-DIV-GPSP-001` 在 legacy-course-executor 上的表现变化
  仍须在 assembly/execution differential lane 中重核。

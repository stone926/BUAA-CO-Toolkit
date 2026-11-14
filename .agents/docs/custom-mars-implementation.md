# 自定义指令接入与验证记录

日期：2026-11-14。

## 实施决定

- 公开 Jar 设置统一为 `co.toolchain.mars`，删除旧 MarsP7、engine、extraArgs、延迟槽/内存布局兼容配置。标准 ASM 不依赖 Java；未知指令通过结构化诊断触发切换。
- 普通运行/导出、P3–P7 用户文件/目录测试共用冻结的 Jar/class/Java 桥；目录不递归。CPU 资源、原 ASM 引擎配置、源闭包根分别传递，历史保留这三个上下文。
- 外部汇编返回真实段、符号和 include 源位置，重汇编必须与 DUT 物理机器码一致。最终参考计划在执行前绑定；重跑核实原 Jar/class/bridge 指纹。
- Java 8 桥随包发布。使用固定 ASM 9.11.1 字节码库分析 `simulate` 可达方法的控制转移意图，为声明 I 格式的课程自定义分支也补齐 P7 延迟槽异常标志；不依赖助记符猜测。自定义编码优先，按最终二进制解码重新绑定 statement，保证同一机器字具有相同参考语义。
- HI/LO 实际读写按 API 观察，未定义读取、原生除零及非法延迟槽等情况作为参考/用例错误。P7 syscall、CP0 复位、BD/EPC、中断及 IG 应答符合课程策略。
- Timer 不禁用。现有时钟级黑盒 probe 路径保持不变；外部参考记录 Timer 时序观察，相关差异不直接误报为 CPU 错误。报告明确实际参考引擎和比较范围。
- Java 源码、构建脚本、依赖来源/校验和及 BSD 许可入库；VSIX 只包含桥 fatjar、许可和依赖说明，不需要用户 javac。

## 已通过的验证

- 最终全量 Vitest：300 个测试文件通过，2 个真实工具可选文件默认跳过；4193 项通过，19 项跳过。
- 真实工具可选集成：配置 Mars.jar、课程 class 目录、两套 P5 CPU 和 stone/p7 后共 18 项通过。
- 课程实际 class：P3 addm、P4 pcadd、P5 addei；同一真实指令通过 P6/P7 策略执行。测试覆盖普通 stdin/交互/相对文件 I/O、步数耗尽、include/symbol、替换 class 后旧快照不变、重跑拒绝版本漂移、非零 DM 拒绝。
- 真实 P5 `p5_blztal_1047`、`p5_bonall_1046`：原 RTL 写回对拍通过；隔离副本故意改错写回后被检测。用户 CPU 源码未改动。
- 真实 `stone/p7`：Timer 12/12、MMIO 26/26、eret 返回后二次 IRQ 2/2 通过；Timer 启用，使用生产私有 TB 与 checker。证据位于 `.co/verification/p7-stone-live-probes`。
- 自定义汇编 + P7 Timer：用测试专用 coori.class 替换一个 ORI 助记符，经外部 Mars 汇编后机器码与内置原程序逐字一致；真实 stone/p7 的 12 项 Timer probe 全部通过。
- 独立桥验证器：`MARS bridge contract checks passed.`；覆盖真实 blztal/bonall 的 P7 BD/EPC、同字异名/重载语义一致、继承/私有/伴随类可达性、Timer 保持可用、HI/LO/除零、稀疏映像、超时/停机边界及官方 Mars 能力错误。两个干净构建字节一致，64 个 class 均兼容 Java 8。
- 严格 typecheck、compile、生成物检查、模块边界检查通过；索引没有新增孤儿文件。真实 Worker 的内部 MARS 17 项端到端验证通过。
- 真实 VS Code 1.146.0 扩展宿主的 29 个 smoke 检查通过，覆盖激活、LSP、普通 MARS、P3–P7 命令导出、持续测试及历史失败诊断/重跑/波形。该工具环境的 C 盘临时目录对子进程不可写，测试使用隔离的工作区 user-data/tool-temp；未改用户正常 VS Code 配置。
- Win32-x64 VSIX 已生成到 `.co/verification/buaa-co-custom-mars.vsix`。随包包含桥和许可，开发源码及重复 ASM 依赖 Jar 不进入 VSIX。
- 自定义存储编码优先于原生 opcode 推断，包括显式重载 SB；全局地址、PC、有效 mask 和启用字节数据检查保留。相关真实 Icarus 回归 368 项通过，P7 三个真实探针再次全部通过。
- `check:mars-bridge` 校验固定依赖、规范化源码/构建输入及桥 Jar 指纹，不启动 Java；接入常规 compile/test/check:generated，防止发布陈旧二进制。

## 复现命令

```powershell
$env:CO_MARS_JAR = 'D:\Program FIles\Mars\Mars.jar'
$env:CO_CUSTOM_INSTRUCTION_FIXTURES = 'E:\VSCode\BUAA-CO\cscore\加指令练习'
$env:CO_CUSTOM_CPU_ROOT = 'E:\VSCode\BUAA-CO\cpu\stone'
$env:CO_P7_CPU_ROOT = 'E:\VSCode\BUAA-CO\cpu\stone\p7'
npx vitest run src/test/mipsProviders/customMarsIntegration.test.ts src/test/courseTesting/customMarsP7ProbeIntegration.test.ts
node resources/mars/bridge/verify.mjs --mars $env:CO_MARS_JAR --official 'D:\Program FIles\Mars\Mars4_5.jar' --course-root $env:CO_CUSTOM_INSTRUCTION_FIXTURES
```

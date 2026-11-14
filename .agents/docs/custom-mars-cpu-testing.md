# 自定义 MIPS 指令：运行、导出与 CPU 对拍设计

日期：2026-11-14。状态：已实施并完成真实指令/CPU 集成验证；本次采用公开 `co.toolchain.mars`，删除 Mars 旧配置。验证结果见 `custom-mars-implementation.md`。此设计取代最初仅针对普通命令的方案。

## 用户确认的范围

- 普通 ASM 运行和机器码导出：内置汇编器遇到未知指令时，自动使用用户配置的魔改 Mars，并加载 `.co/custom-instructions/` 的指令类。
- CPU 测试统一接受一个 ASM 文件或一个目录；目录只枚举直属 ASM，不递归。自定义指令同时用于汇编和 Mars 参考执行，再和用户 Verilog CPU 对拍。
- 内置随机生成器适配自定义指令后置；本次支持用户提供的测试程序，不宣称标准随机测试覆盖了 custom 指令。

## 实施前核实的链路与兼容事实

1. `src/mips.ts` 的普通运行、stdin 文件和伪终端调用 `mips/host/marsService.ts`；Worker 先汇编再执行，未知指令失败时尚未产生程序副作用。
2. `src/mipsCommands.ts` 的 P2–P7 导出经 BuiltinTsAssemblerProvider；课程导出额外合并内核、补空洞及停机尾，失败须保留旧产物。
3. 课程链路是 CourseTracePipeline → prepareAsmCaseMachineCode → assembler → ProgramImage → oracle → Icarus DUT → Trace 比较；assembler/oracle 由不可变 CourseEnginePlan 绑定。只在命令层 fallback 无法覆盖对拍。
4. `machineCodeValidation.ts` 只接受内置 ISA，成功外部汇编的 custom 机器码仍会被拦截。`caseRerun.ts` 重跑也固定重新选择 builtin，需要一并修改。
5. 当前公共课程测试入口只有内置随机持续测试、停止和历史；用户自备 ASM 文件/目录需要一个可见的统一入口。
6. 本地魔改 Mars 的 `mars/MarsLaunch.java` 支持重复 `cl <文件>`；LoadInstruction 要求实现 InstructionLoad 并反射实例化。加载异常可能伴随退出码 0，不能仅检查退出码。
7. 对 `D:/Program FIles/Mars/Mars.jar`（显示扩展版本 0.5）及仓库 `test/behlbal.class` 实测：直接 `-jar ... cl <绝对路径>` 失败；将 class 所在目录加入 `-cp` 后加载成功。旧加载器用 class 文件 URL 而非目录构造 URLClassLoader，需要父 classpath 补充。
8. 课程 P4/P4-7.md 要求 PC=0x3000、GRF/DM 全零；P7/implement/P7-2-6.md 要求 CP0 初始零、异常入口 0x4180。Mars Compact 布局默认 gp/sp 非零，“支持 cl”并不等于“可直接作为课程参考”。旧 CLI 没有统一的课程复位和精确停机接口。
9. Mars 原生 dump 在首个未写 word 处结束，不能无损重建稀疏映像；直接拼两个 HexText 文件不足以适配 ProgramImage。

## 核心决定：绑定完整参考引擎

```text
捕获 ASM/include/stdin 不可变闭包
  → 内置汇编能力判定（不执行、不发布产物）
  → 选定并冻结此 case 的 CourseEnginePlan
      ├─ builtin-ts：复用汇编结果和现有课程执行器
      └─ custom-mars：冻结 jar/class，外部汇编和外部 oracle
  → 校验 ProgramImage 与 DUT 输入一致
  → 参考 Trace 与用户 CPU Trace
  → 共用比较、报告、历史、波形与重跑
```

- 自动选择只由结构化 `asm.instruction.unknown` 触发，不匹配 stderr。普通语法/操作数/include/布局错误、取消、超时和执行错误不触发。未知也可能是拼写错误，外部汇编仍失败时应明确报告。
- 最终 plan 在任何参考/DUT 执行前确定，禁止外部汇编后交给 TS 执行，也不在程序产生副作用后切换。
- builtin 成功后复用已得结果，避免双重汇编。外部使用新的 custom-mars 身份，不冒充 builtin 或历史 pinned legacy。
- 测试请求保留显式 custom-mars 选择，以支持 class 重载已有助记符/编码的情况；默认 auto。不能因目录里存在 class 就改变普通程序语义。
- 内置标准随机点维持 builtin 策略；用户文件/目录测试共用上述选择机制。

## 外部适配分层

1. 配置/UI：使用公开 `co.toolchain.mars`（machine-overridable，默认空），Java 复用 `co.toolchain.java`；删除旧 engine、MarsP7、extraArgs、延迟槽/布局设置，不做兼容迁移。相对 jar 路径以原始 ASM 所属 workspace 为根，无 workspace 则按 ASM 所在目录。
2. 文件系统：只枚举原 workspace 的 `.co/custom-instructions/` 顶层 class，稳定排序；`$` 内部类作为依赖，不单独加载。限制数量/字节，不扫描整个 workspace。必须保留原项目上下文，不能从 `.co/cases` 快照位置推断根目录。
3. 快照：执行前将 jar、顶层及内部 class 保存到不可变 engine registry，记录 SHA-256、长度、文件名和加载顺序；assembler/oracle 使用同一私有物化目录。运行中替换工作区 class 不影响当前 case。
4. Java bridge：打包一个预编译的小型适配桥，classpath 使用配置的 jar 与 class 目录。桥只调用 Mars 的加载、汇编、复位、读取段/符号/源位置、受控执行与事件输出；custom 语义仍完全来自原 class。用户仅需 JRE，不要求 javac，不修改用户 jar。
5. 结构化协议：bridge 输出有版本的消息，明确表示加载结果、真实段地址、复位、停机和错误，避免靠 CLI 文本/退出码猜测。普通控制台能力与课程 oracle 能力分开检测，分别给出不兼容原因。
6. TS adapter：独立 CustomMarsAssemblerProvider / CustomMarsExecutionProvider 适配现有 contracts。复用进程输出上限、超时、AbortSignal、整树终止和 UTF-8 解码；VS Code handler 只负责输入/UI。

## ProgramImage 与对拍正确性

- 从 Mars 汇编后的真实 statement 地址和机器码构造权威 ProgramImage，保留稀疏 text/ktext、data、符号及可获取的源位置；复用 fingerprint、序列化及 DUT 投影。
- 将合法性分为硬件结构和 ISA 来源：所有引擎检查地址、对齐、重叠、容量、DM 全零初态和停机；builtin 保持原 ISA 白名单，custom 根据实际加载的注册表识别编码。不能无条件放行所有未知机器码，也不要求 TS decoder 理解 custom 语义。
- 普通导出按现有规则补停机尾；测试采用明确且验证过的停机契约。外部执行必须核实实际取指映像与 DUT 文件一致，不能悄悄重新汇编成另一份机器码。
- 课程运行 PC=0x3000、全部 GPR/DM 清零、延迟槽按阶段；P7 进一步检查 CP0、异常和 IRQ 能力。普通运行保留现有普通 Mars 布局/syscall，不误启用 P7 异常语义。
- 参考结果归一化为现有 PC、GPR/DM 目标和值事件，复用比较器。外部 Trace 不伪装成 builtin CommitEvent、coverage 或逐字节 store evidence。class 必须通过 Mars 规定的寄存器/内存 API 更新可观察状态。
- 超时、预算耗尽、异常退出、落出装载文本和输出截断是工具/用例错误，不能当作 CPU 通过或直接判 CPU 功能错误。正常完成须有已验证停机证明。
- P7 Timer 保持可用，复用现有 DUT probe 验证实际时钟级 Timer/MMIO/IRQ；自定义指令汇编也能进入同一 probe 路径。普通参考 Trace 允许实际 Timer 操作，并记录 Timer 活动/时序观察；涉及 Timer 时序的写回差异归为参考不可直接判定，而非直接归为 CPU 功能失败。不把 Mars 每指令时间冒充 RTL 时钟。

## 统一的文件/目录测试入口

- 一个公共命令接受 URI 参数；无参数时选择文件或目录。目录只收集直属 `.asm/.s/.mips` 普通文件、稳定排序、空目录提示；不递归，也不因 include 依赖额外创建测试点。
- 每个根文件独立捕获 include/stdin；测试输入目录与被测 Verilog 工程上下文分开，不能把 ASM 目录误认成 CPU 根目录。
- 共用 batch 执行器、会话租约、进度/停止、私有 TB、Icarus、case store、差异报告、波形与历史。与随机持续测试互斥，复用有界调度和失败 drain，每点保存明确终态。
- 生成器适配后置：class 的模板/编码无法表达安全操作数、读写集合、访存和控制流约束；将来需额外的生成描述。当前报告不能将标准随机覆盖称为 custom 覆盖。

## 历史、重跑与提示

- manifest 保存实际 assembler/oracle id、jar/class 依赖指纹、bridge/Java 版本及课程参数，报告说明使用何种参考。
- 重跑沿用原始输入和原参考依赖版本，不重新选择 builtin、不静默采用目录里更新的 class；缺版本时明确报告，主动用新版本属于新测试点。
- 保持 engine registry 执行授权边界：当前显式配置的依赖可注册；旧 manifest 或 registry 元数据本身不产生执行授权。跨会话验证当前配置与记录身份相同，或通过明确的受信任依赖导入流程恢复。
- 提示区分缺配置、jar 不存在、Java 不可用、无加载接口、无 class、class 版本/依赖异常、加载后仍未知、普通模式可用但课程模式不兼容；给出配置键及目标目录。
- 产物先在临时目录验证，再原子发布；失败保留原机器码。普通运行继续支持文件 stdin、交互终端、取消及输出限制。

## 实施顺序与验证要求

1. Java bridge、配置和依赖快照；真实 behlbal.class 验证加载与中文空格路径。
2. providers、最终 plan 选择、ProgramImage/ISA 校验；普通运行和导出复用同一外部适配。
3. 文件/目录测试入口接现有 Icarus/比较/报告；同步 manifest、重跑与停止。
4. 回归覆盖 builtin 不依赖 Java、精准切换、单文件/目录非递归、缺配置/旧官方 Mars/加载失败（含退出码 0）、故意错误的 custom DUT、class 并发替换和历史版本、P7 段/复位/停机、取消/超时/旧产物保留。
5. 完成 typecheck、相关 Vitest、真实 Java/Icarus 集成和生成物/模块边界/索引门禁后创建 Conventional Commit。实现和验证结果另行记录，不将本设计描述当作已实现行为。

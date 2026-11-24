# mips-providers | src/mips/providers/ | 10 files

Provider-neutral 引擎契约与解析。数据契约（SourceUnit / ProgramImage 等）在 mips-core，本模块只持有扩展侧（`vscode.Uri`）类型。

不可变 `CourseEnginePlan` 原子绑定 assembler 与 executor。手动或用户 ASM 在汇编前通过 `customInstructionService.ts` 绑定工作区指令。JS/TS 使用 `builtin-ts`，只有 `.class` 时使用 `custom-mars`，空注册表使用标准内置指令集。后续 oracle 复用最终 plan。随机生成点使用 builtin 与可选的冻结 JS/TS 定义。P2 采用普通 MARS 布局，P3–P7 采用课程布局。

- `contracts.ts` — EngineDescriptor、capabilities、Assemble/Execute 请求结果、preflight 诊断
- `courseEnginePolicy.ts` — 纯函数的 profile/capability/mode 决策
- `providerResolver.ts` — provider 解析唯一入口：按计划的稳定 id 精确选中并贯穿一次 case；preflight 在副作用前完成，运行开始后禁止 fallback；provider 注册数组顺序不参与生产决策
- `builtinAssemblerProvider.ts` — P2–P7 统一纯 TS 汇编器；生产路径走 Worker `assembler-assemble`，输出含 text/ktext/data/sourceMap 的 ProgramImage；明确区分 Worker 取消与真实引擎错误，避免并发首失败取消污染统计
- `builtinExecutionProvider.ts` — P3–P7 默认 TS executor：只消费 ProgramImage，产出 raw trace、canonical CommitEvent、coverage 与原子 event artifact；生产路径走懒启动 Worker
- `fixedMarsReference.ts` — 显式开发者验证的固定 reference gate：只信插件编译内置的 `legacy-course-executor`，用同一 FileHandle 校验普通文件、精确 bytes 与 SHA-256
- `customMarsCommon.ts` — 魔改 Mars 描述及真实段、符号、include 源位置到 ProgramImage 的映射
- `customMarsAssemblerProvider.ts` — 冻结 Jar/class/Java bridge 依赖，校验汇编结果及停机尾，返回源码/映像/版本绑定；命令可延迟发布最终文件
- `customMarsExecutionProvider.ts` — 复用汇编依赖与源码，执行前核实相同物理机器码及课程初态，返回真实规范写回 Trace；不伪造 builtin 结构化 CommitEvent

- `scriptInstructionProviders.ts` — builtin 脚本适配器：预检可取消、绑定冻结 ISA、编码授权、image/执行身份及引擎依赖

`co.toolchain.mars` 提供 `.class` 所需的 JAR，缺少配置或能力不符时返回诊断。历史用例重放核实原引擎身份和闭包。

# mips-providers | src/mips/providers/ | 9 files

Provider-neutral 引擎契约与解析。数据契约（SourceUnit / ProgramImage 等）在 mips-core，本模块只持有扩展侧（`vscode.Uri`）类型。

不可变 `CourseEnginePlan` 原子绑定 assembler 与 executor。P2–P7 默认使用 `builtin-ts`；手动/用户 ASM 的 auto 仅在结构化未知指令汇编失败、尚未执行程序时切换到 `custom-mars`，后续 oracle 复用最终 plan。随机生成点固定 builtin。P2 采用普通 MARS 布局，P3–P7 采用课程布局。历史 legacy 身份只用于识别旧证据，不读取旧配置。

- `contracts.ts` — EngineDescriptor、capabilities、Assemble/Execute 请求结果、preflight 诊断
- `courseEnginePolicy.ts` — 纯函数的 profile/capability/mode 决策
- `providerResolver.ts` — provider 解析唯一入口：按计划的稳定 id 精确选中并贯穿一次 case；preflight 在副作用前完成，运行开始后禁止 fallback；provider 注册数组顺序不参与生产决策
- `builtinAssemblerProvider.ts` — P2–P7 统一纯 TS 汇编器；生产路径走 Worker `assembler-assemble`，输出含 text/ktext/data/sourceMap 的 ProgramImage；明确区分 Worker 取消与真实引擎错误，避免并发首失败取消污染统计
- `builtinExecutionProvider.ts` — P3–P7 默认 TS executor：只消费 ProgramImage，产出 raw trace、canonical CommitEvent、coverage 与原子 event artifact；生产路径走懒启动 Worker
- `fixedMarsReference.ts` — 显式开发者验证的固定 reference gate：只信插件编译内置的 `legacy-course-executor`，用同一 FileHandle 校验普通文件、精确 bytes 与 SHA-256
- `customMarsCommon.ts` — 未知指令切换判定、custom 描述及真实段/符号/include 源位置到 ProgramImage 的映射
- `customMarsAssemblerProvider.ts` — 冻结 Jar/class/Java bridge 依赖，校验汇编结果及停机尾，返回源码/映像/版本绑定；命令可延迟发布最终文件
- `customMarsExecutionProvider.ts` — 复用汇编依赖与源码，执行前核实相同物理机器码及课程初态，返回真实规范写回 Trace；不伪造 builtin 结构化 CommitEvent

**选择语义**：auto 内置优先，未知指令时在执行前绑定完整 custom 栈；builtin 禁止切换；公开用户测试入口的显式 Mars 选项直接选择 custom。`co.toolchain.mars` 是唯一公开 Jar 路径；旧 engine、MarsP7、extraArgs、延迟槽/布局配置不再读取或迁移。普通控制台 syscall 与 P7 CPU 异常语义分开，运行开始后的失败不切换引擎。

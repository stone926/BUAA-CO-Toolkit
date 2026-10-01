# mips-providers | src/mips/providers/ | 9 files

Provider-neutral 引擎契约与解析。数据契约（SourceUnit / ProgramImage 等）在 mips-core，本模块只持有扩展侧（`vscode.Uri`）类型。

不可变 `CourseEnginePlan` 原子绑定 assembler 与 executor。P3–P7 固定使用 `builtin-ts`；P2 汇编使用 `official-mars-configured`。`legacy-mars-configured` 仅用于识别已有归档，生产注册表不再注册该 provider。

- `contracts.ts` — EngineDescriptor、capabilities、Assemble/Execute 请求结果、preflight 诊断
- `courseEnginePolicy.ts` — 纯函数的 profile/capability/mode 决策
- `providerResolver.ts` — provider 解析唯一入口：按计划的稳定 id 精确选中并贯穿一次 case；preflight 在副作用前完成，运行开始后禁止 fallback；provider 注册数组顺序不参与生产决策
- `builtinAssemblerProvider.ts` — P3–P7 默认纯 TS 课程汇编器；生产路径走 Worker `assembler-assemble`，输出含 text/ktext/data/sourceMap 的 ProgramImage
- `builtinExecutionProvider.ts` — P3–P7 默认 TS executor：只消费 ProgramImage，产出 raw trace、canonical CommitEvent、coverage 与原子 event artifact；生产路径走懒启动 Worker
- `officialMarsProvider.ts` — P2 原版 MARS 标准汇编适配；不声称具备课程 ProgramImage 执行/Trace 能力
- `fixedMarsReference.ts` — 显式开发者验证的固定 reference gate：只信插件编译内置的 `legacy-course-executor`，用同一 FileHandle 校验普通文件、精确 bytes 与 SHA-256
- `legacyMarsLaunch.ts` — 原版 MARS 启动预检与配置快照；普通 ASM 与 Profile 无关，在副作用前拒绝显式课程 Trace、RI/class/IRQ 扩展
- `legacyMarsProvider.ts` — 历史 adapter 与证据兼容实现，生产解析器不注册

**选择语义**：P3–P7 的 `auto`/`builtin` 均选 `builtin-ts`；旧 `mars`/`verify-both` 归 `auto`，不启动魔改 reference。课程 stdin/交互请求在 builtin preflight 报能力错误；普通控制台用独立的原版 MARS 命令。选中后的 preflight/运行失败一律 fail closed。

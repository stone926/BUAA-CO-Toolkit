# mips-providers | src/mips/providers/ | 8 files

Provider-neutral 引擎契约与解析。数据契约（SourceUnit / ProgramImage 等）在 mips-core，本模块只持有扩展侧（`vscode.Uri`）类型。

**核心设计决策：不可变 `CourseEnginePlan`。** 一个 plan 原子绑定 assembler 与 executor，因此单次 case 内不可能出现"用 A 汇编、用 B 执行"的错配。稳定 engine id 只有两个：`builtin-ts` 与 `legacy-mars-configured`。

- `contracts.ts` — EngineDescriptor、capabilities、Assemble/Execute 请求结果、preflight 诊断
- `courseEnginePolicy.ts` — 纯函数的 profile/capability/mode 决策
- `providerResolver.ts` — provider 解析唯一入口：按计划的稳定 id 精确选中并贯穿一次 case；preflight 在副作用前完成，运行开始后禁止 fallback；provider 注册数组顺序不参与生产决策
- `builtinAssemblerProvider.ts` — P3–P7 默认纯 TS 课程汇编器；生产路径走 Worker `assembler-assemble`，输出含 text/ktext/data/sourceMap 的 ProgramImage
- `builtinExecutionProvider.ts` — P3–P7 默认 TS executor：只消费 ProgramImage，产出 raw trace、canonical CommitEvent、coverage 与原子 event artifact；生产路径走懒启动 Worker
- `fixedMarsReference.ts` — 显式开发者验证的固定 reference gate：只信插件编译内置的 `legacy-course-executor`，用同一 FileHandle 校验普通文件、精确 bytes 与 SHA-256
- `legacyMarsLaunch.ts` — 副作用前一次性解析 profile、内存布局、Java/MARS、P7 RI class、超时与安全参数
- `legacyMarsProvider.ts` — 包装 `runMarsFile` 的完整 legacy MARS 行为

**选择语义**：P3–P7 的 `auto` 默认选 `builtin-ts`；`mars` 选 `legacy-mars-configured`；`verify-both` 以 builtin 为主路径并独立启动固定 legacy full stack。stdin/交互能力在 P7 前由 `auto` 明确留在 legacy。显式 `builtin` 不会偷偷回退；选中后的 preflight/运行失败一律 fail closed。

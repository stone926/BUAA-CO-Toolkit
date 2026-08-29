# mips-providers | src/mips/providers/ | 8 files

Provider-neutral 引擎契约与解析。阶段 6 用一个不可变 `CourseEnginePlan` 同时绑定 assembler/executor：P3–P7 的 `auto` 默认选择 `builtin-ts`，`mars` 选择 `legacy-mars-configured`，`verify-both` 以 builtin 为主路径并独立启动固定 legacy full stack。stdin/交互能力在阶段 7 前由 `auto` 明确留在 legacy；显式 `builtin` 不会偷偷回退。选择后的 preflight/运行失败均 fail closed，provider 注册数组顺序不参与生产决策。数据契约（SourceUnit/ProgramImage 等）在 mips-core 模块，本模块只持有扩展侧（vscode.Uri）类型。

- contracts.ts — EngineDescriptor、capabilities、AssembleRequest/Result、ExecuteRequest/Result、preflight 诊断
- providerResolver.ts — provider 解析唯一入口：按 AppServices 隔离默认 registry；按计划的稳定 engine id 精确选中 assembler/executor，并把同一计划贯穿一次 case；显式 by-id 仅用于独立 shadow/full-stack reference；preflight 在副作用前完成，运行开始后禁止 fallback
- courseEnginePolicy.ts — 纯函数的 profile/capability/mode 决策；稳定 id 为 `builtin-ts` 与 `legacy-mars-configured`，一个计划原子覆盖汇编与执行
- fixedMarsReference.ts — 显式开发者验证的固定 reference gate：只信插件编译内置 `legacy-course-executor` 角色，使用同一 FileHandle 校验普通文件、精确 bytes、SHA-256 及读取前后身份，不信路径、文件名或工作区 manifest
- legacyMarsLaunch.ts — 在副作用前一次性解析 profile、内存布局、Java/MARS、P7 RI class、超时、DB 与安全 extra args；生产与 replay 使用同一固定课程 launch policy
- legacyMarsProvider.ts — 完整包装现有 runMarsFile 行为；
- builtinExecutionProvider.ts — P3–P7 默认 TS executor：只消费 ProgramImage，产出 raw trace、canonical CommitEvent、coverage、checkpoint 与原子 event artifact；生产路径通过 `AppServices.mipsRuntime` 走懒启动 Worker，测试/无 runtime 路径每 128 条指令异步 yield，stdin 和缺失 Timer cycle schedule 均 fail closed；preflight 在第一个 await 前指纹化请求、await 后复核，并在执行前消费同一 immutable launch snapshot，拒绝 during/after-preflight mutation、ProgramImage 和无界 course run。实际 executor artifact identity、resolved run、AbortSignal 与停止原因随 result 返回
- builtinAssemblerProvider.ts — P3–P7 默认纯 TS 课程汇编器：消费调用方已验证的 source graph，或有界捕获 root/include 原始 blobs；生产路径通过同一 `assembler-assemble` Worker DTO，返回含 text/ktext/data/sourceMap 的 ProgramImage。课程 DUT HexText 将所有非 data 段按绝对地址投影到完整 4096-word IM（空洞补零），另保留 kernel dump；course-trace 验证标准停机自环并绑定独立 assembler artifact

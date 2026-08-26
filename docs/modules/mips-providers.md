# mips-providers | src/mips/providers/ | 4 files

Provider-neutral 引擎契约与解析。阶段 1 只注册 legacy；builtin-ts 在对应阶段 gate 通过后按 profile/capability 分项注册。数据契约（SourceUnit/ProgramImage 等）在 mips-core 模块，本模块只持有扩展侧（vscode.Uri）类型。

- contracts.ts — EngineDescriptor、capabilities、AssembleRequest/Result、ExecuteRequest/Result、preflight 诊断
- providerResolver.ts — provider 解析唯一入口：按 AppServices 隔离默认 registry，选择第一个 preflight-capable provider；preflight 在副作用前完成，运行开始后禁止 fallback
- legacyMarsLaunch.ts — 在副作用前一次性解析 profile、内存布局、Java/MARS、P7 RI class、超时、DB 与安全 extra args；生产与 replay 使用同一固定课程 launch policy
- legacyMarsProvider.ts — 完整包装现有 runMarsFile 行为；preflight 在第一个 await 前指纹化请求、await 后复核，并在执行前消费同一 immutable launch snapshot，拒绝 during/after-preflight mutation、ProgramImage 和无界 course run。实际 artifact identity、resolved run、AbortSignal 与停止原因随 result 返回

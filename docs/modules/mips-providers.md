# mips-providers | src/mips/providers/ | 5 files

Provider-neutral 引擎契约与解析。默认执行仍是 legacy MARS；builtin-ts 已在阶段 4 作为 executor-only provider 注册到第二位，只能通过显式 shadow/verify-both 解析。数据契约（SourceUnit/ProgramImage 等）在 mips-core 模块，本模块只持有扩展侧（vscode.Uri）类型。

- contracts.ts — EngineDescriptor、capabilities、AssembleRequest/Result、ExecuteRequest/Result、preflight 诊断
- providerResolver.ts — provider 解析唯一入口：按 AppServices 隔离默认 registry，选择第一个 preflight-capable provider；preflight 在副作用前完成，运行开始后禁止 fallback
- legacyMarsLaunch.ts — 在副作用前一次性解析 profile、内存布局、Java/MARS、P7 RI class、超时、DB 与安全 extra args；生产与 replay 使用同一固定课程 launch policy
- legacyMarsProvider.ts — 完整包装现有 runMarsFile 行为；
- builtinExecutionProvider.ts — phase-2/3 TS executor 的显式 shadow/verify-both provider：只消费 ProgramImage，产出 raw trace、canonical CommitEvent、coverage、checkpoint 与原子 event artifact；生产路径通过 `AppServices.mipsRuntime` 走懒启动 Worker，测试/回退路径每 128 条指令异步 yield，stdin 和缺失 Timer cycle schedule 均 fail closed；preflight 在第一个 await 前指纹化请求、await 后复核，并在执行前消费同一 immutable launch snapshot，拒绝 during/after-preflight mutation、ProgramImage 和无界 course run。实际 artifact identity、resolved run、AbortSignal 与停止原因随 result 返回

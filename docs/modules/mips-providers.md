# mips-providers | src/mips/providers/ | 6 files

Provider-neutral 引擎契约与解析。普通 assembler/executor 解析都仍固定选择 legacy MARS；阶段 4 executor 与阶段 5 assembler 以同一 `builtin-ts` id、不同角色 descriptor 注册在第二位，只能通过显式 by-id、shadow/verify-both 或 full-stack 路径选择。preflight 失败或运行开始后的错误都禁止隐式 fallback。数据契约（SourceUnit/ProgramImage 等）在 mips-core 模块，本模块只持有扩展侧（vscode.Uri）类型。

- contracts.ts — EngineDescriptor、capabilities、AssembleRequest/Result、ExecuteRequest/Result、preflight 诊断
- providerResolver.ts — provider 解析唯一入口：按 AppServices 隔离默认 registry；普通解析只查看首个 legacy provider，显式 `resolve*ProviderById`/`resolveBuiltin*Provider` 才选择 builtin；preflight 在副作用前完成，运行开始后禁止 fallback
- legacyMarsLaunch.ts — 在副作用前一次性解析 profile、内存布局、Java/MARS、P7 RI class、超时、DB 与安全 extra args；生产与 replay 使用同一固定课程 launch policy
- legacyMarsProvider.ts — 完整包装现有 runMarsFile 行为；
- builtinExecutionProvider.ts — phase-2/3 TS executor 的显式 shadow/verify-both provider：只消费 ProgramImage，产出 raw trace、canonical CommitEvent、coverage、checkpoint 与原子 event artifact；生产路径通过 `AppServices.mipsRuntime` 走懒启动 Worker，测试/无 runtime 路径每 128 条指令异步 yield，stdin 和缺失 Timer cycle schedule 均 fail closed；preflight 在第一个 await 前指纹化请求、await 后复核，并在执行前消费同一 immutable launch snapshot，拒绝 during/after-preflight mutation、ProgramImage 和无界 course run。实际 executor artifact identity、resolved run、AbortSignal 与停止原因随 result 返回
- builtinAssemblerProvider.ts — phase-5 纯 TS 课程汇编器 provider：消费调用方已验证的 source graph，或有界捕获 root/include 原始 blobs；生产路径通过同一 `assembler-assemble` Worker DTO，测试/无 runtime 路径直接调用同一 core service，返回含 text/ktext/data/sourceMap 的 ProgramImage。它写出请求目标的课程 HexText/kernel dump，course-trace user-text 模式验证标准停机自环，并绑定独立的 assembler artifact（当前 assembler semantics revision 2）；与 executor 同 id 注册在 legacy 之后，仅供显式 full-stack/shadow/replay 选择，阶段 6 才可能切换默认

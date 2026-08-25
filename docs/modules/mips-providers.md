# mips-providers | src/mips/providers/ | 3 files

Provider-neutral 引擎契约与解析。阶段 1 只注册 legacy；builtin-ts 在对应阶段 gate 通过后按 profile/capability 分项注册。数据契约（SourceUnit/ProgramImage 等）在 mips-core 模块，本模块只持有扩展侧（vscode.Uri）类型。

- contracts.ts — EngineDescriptor、capabilities、AssembleRequest/Result、ExecuteRequest/Result、preflight 诊断
- providerResolver.ts — provider 解析唯一入口：preflight 在副作用前完成，禁止半途 fallback
- legacyMarsProvider.ts — 完整包装现有 runMarsFile 行为（dumpText/dumpKernel/run 三模式与课程 Trace 选项）

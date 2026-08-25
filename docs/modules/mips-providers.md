# mips-providers | src/mips/providers/ | 3 files

Provider-neutral 引擎契约与解析。阶段 1 只注册 legacy；builtin-ts 在对应阶段 gate 通过后按 profile/capability 分项注册。数据契约（SourceUnit/ProgramImage 等）在 mips-core 模块，本模块只持有扩展侧（vscode.Uri）类型。

- contracts.ts — EngineDescriptor、capabilities、AssembleRequest/Result、ExecuteRequest/Result、preflight 诊断
- providerResolver.ts — provider 解析唯一入口：按 AppServices 隔离默认 registry，选择第一个 preflight-capable provider；preflight 在副作用前完成，运行开始后禁止 fallback
- legacyMarsProvider.ts — 完整包装现有 runMarsFile 行为（dumpText/dumpKernel/run 三模式与课程 Trace 选项）；descriptor 明确标为用户配置构建，每次运行由 runMarsFile 在进程前后复核同一路径 SHA-256 并把实际 artifact identity 随 result 返回；拒绝 ProgramImage/无界 course run，并转发 AbortSignal/停止原因

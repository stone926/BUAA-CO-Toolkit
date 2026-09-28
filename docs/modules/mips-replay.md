# mips-replay | src/mips/replay/ | 9 files

用例证据基础设施：源码快照、ProgramImage 序列化、有界文件校验与不可变引擎注册表。持续测试、MARS 运行与开发验证脚本共用这些模块；未接入任何用户/CLI 入口的 exact replay / re-evaluate 服务已移除。

- `canonical.ts` — canonical JSON 与 SHA-256
- `atomicFile.ts` — 跨平台原子文件替换
- `boundedFile.ts` — 同句柄有界读取与输入/产物大小上限
- `sourceBundle.ts` — SourceUnit/include graph 捕获、验证与确定性物化
- `programImage.ts` — ProgramImage/observability 序列化与 oracle evidence digest
- `engineRegistry.ts` — 不可变 engine artifact registry 及执行 staging
- `builtinEngineArtifact.ts` — builtin executor 的逻辑 artifact 身份
- `builtinAssemblerEngineArtifact.ts` — 独立的 builtin assembler artifact 身份
- `structuredExecutionEvidence.ts` — builtin event count/digest/engine/image/profile/stop envelope 校验

## 核心设计决策

**bundle 闭包。** 递归发现 MARS `.include`，把 root 与全部 include 的原始 bytes 存入 `source/blobs/<sha256>.bin`，记录 canonical edge/offset 与 graph fingerprint；后续汇编与 oracle 只读从 blobs 确定性重建的只读 materialization，不再读原工作区。v2 manifest 同时绑定 source graph、serialized image、observability、DUT exact bytes、stdin、完整执行 options/device timeline/cycle/stop/seed/resource policy 与 assembler/oracle 全部 evidence revision。所有相对路径只接受 canonical `/`；大小写碰撞、symlink、非普通文件与 containment escape 一律 fail closed。早期 v2 与 v1 仍可读，v1 永久只读。

**引擎授权 = 身份 + 显式信任。** registry 以 `role + SHA-256` 为唯一键，`stageForExecution` 只接受两种授权根：当前进程通过 `registerFile/registerBytes` 绑定的可信输入，或编译进插件的 `EngineArtifactTrustManifest`（固定 MARS v0.6.3 / course1 的 SHA-256、大小与角色）。**磁盘上"恰好有该 digest"只证明身份，不证明信任**——`.co`、case 目录与 artifact 邻近位置可被工作区写入，伪造 receipt JSON 不增加任何执行权限。若将来增加动态 approval receipt，必须先用插件内嵌公钥验签再转成内部 trust identity。保留策略固定为 `retain-until-explicit-live-manifest-gc`。

**Workspace Trust。** 扩展声明 `untrustedWorkspaces.supported=false`，由 VS Code Restricted Mode 禁用。若改为 `limited` / `true`，必须同时给 MARS 执行入口加函数级 Workspace Trust gate，并把 Java/JAR/RI 工具链列入 `restrictedConfigurations`；registry 的 role+digest 授权不替代发行方真实性或工作区信任。

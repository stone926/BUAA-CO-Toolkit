# mips-replay | src/mips/replay/ | 11 files

用例证据基础设施：源码快照、ProgramImage 序列化、有界文件校验与不可变引擎注册表。持续测试、MARS 运行与开发验证脚本共用这些模块；未接入任何用户/CLI 入口的 exact replay / re-evaluate 服务已移除。

- `canonical.ts` — canonical JSON 与 SHA-256
- `atomicFile.ts` — 跨平台原子文件替换
- `boundedFile.ts` — 同句柄有界读取与输入/产物大小上限
- `jsonStorage.ts` — 程序映像与内置引擎事件 JSON 达到 4 KiB 且压缩可节省空间时，以 gzip 保存。读取兼容原始 JSON，解压时强制执行原始大小上限
- `sourceBundle.ts` — SourceUnit/include graph 捕获、验证与确定性物化
- `programImage.ts` — ProgramImage/observability 序列化与 oracle evidence digest
- `engineRegistry.ts` — 不可变 engine artifact registry 及执行 staging
- `builtinEngineArtifact.ts` — builtin executor 的逻辑 artifact 身份
- `builtinAssemblerEngineArtifact.ts` — 独立的 builtin assembler artifact 身份
- `structuredExecutionEvidence.ts` — builtin event count/digest/engine/image/profile/stop envelope 校验

## 核心设计决策

**源码闭包。** 递归捕获 MARS `.include` 的原始字节、路径拼写和偏移，记录源码图指纹。用例内相同的原始内容和汇编输入可共用同一文件。带 include 的源文件按需保存改写路径后的汇编视图。重跑直接使用已验证的原始闭包。v2 manifest 绑定源码图、程序映像、DUT 输入、stdin、运行配置与引擎证据。固定观测规则按内容哈希标识，旧用例的规则文件仍按快照校验。文件快照的 SHA-256 覆盖实际落盘字节，映像指纹与事件摘要继续覆盖原始内容。所有相对路径均使用规范的 `/` 分隔符，校验拒绝大小写碰撞、符号链接、非普通文件和目录越界。v1 用例保持只读。

**引擎授权 = 身份 + 显式信任。** registry 以 `role + SHA-256` 为唯一键，`stageForExecution` 只接受两种授权根：当前进程通过 `registerFile/registerBytes` 绑定的可信输入，或编译进插件的 `EngineArtifactTrustManifest`（固定 MARS v0.6.3 / course1 的 SHA-256、大小与角色）。**磁盘上"恰好有该 digest"只证明身份，不证明信任**——`.co`、case 目录与 artifact 邻近位置可被工作区写入，伪造 receipt JSON 不增加任何执行权限。若将来增加动态 approval receipt，必须先用插件内嵌公钥验签再转成内部 trust identity。保留策略固定为 `retain-until-explicit-live-manifest-gc`。

**Workspace Trust。** 扩展声明 `untrustedWorkspaces.supported=false`，由 VS Code Restricted Mode 禁用。若改为 `limited` / `true`，必须同时给 MARS 执行入口加函数级 Workspace Trust gate，并把 Java/JAR/RI 工具链列入 `restrictedConfigurations`；registry 的 role+digest 授权不替代发行方真实性或工作区信任。

- `scriptInstructionArtifact.ts` — JS/TS 闭包的 canonical artifact 和 builtin 引擎依赖一致性检查

脚本快照随 case 源输入保存；重跑核实闭包哈希和 assembler/oracle 依赖，不读取后来修改的工作区定义。空注册表也固定。

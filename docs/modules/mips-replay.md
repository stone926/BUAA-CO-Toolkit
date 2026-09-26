# mips-replay | src/mips/replay/ | 9 files

用例证据基础设施：源码快照、ProgramImage 序列化、有界文件校验与不可变引擎注册表。持续测试、MARS 运行和开发验证脚本共同依赖这些模块。未接入任何用户/CLI 入口的 exact replay / re-evaluate 服务、适配器及 facade 已移除。

- canonical.ts — canonical JSON 与 SHA-256。
- atomicFile.ts — 跨平台原子文件替换。
- boundedFile.ts — 同句柄有界读取与输入/产物大小上限。
- sourceBundle.ts — SourceUnit/include graph 捕获、验证和确定性物化。
- programImage.ts — ProgramImage/observability 序列化和 oracle evidence digest。
- engineRegistry.ts — 不可变 engine artifact registry 及执行 staging。
- builtinEngineArtifact.ts — 当前 builtin executor 的逻辑 artifact 身份。
- builtinAssemblerEngineArtifact.ts — 独立的 builtin assembler artifact 身份。
- structuredExecutionEvidence.ts — builtin event count/digest/engine/image/profile/stop envelope 校验。

## Bundle closure

- `sourceBundle.ts`：递归发现 MARS `.include "..."`，保存 root 和所有 include 的原始 UTF-8 bytes 到 `source/blobs/<sha256>.bin`，记录稳定 SourceUnit id、canonical edge/offset、显示用 provenance URI、捕获限额和 graph fingerprint。scanner 使用常量状态，先限制 directive 数量，再按 offset 线性重写；执行使用从 blobs/edges 确定性重建的只读 materialization，不再读取原工作区。
- `programImage.ts`：严格解析 HexText；在构建 Set、交叉引用或 fingerprint 前限制 segment、course words、symbol/sourceMap/inputGraph 基数；序列化/校验领域 `ProgramImage`（含空而诚实的 legacy source map）、保存 observability schema，并在 canonical event 扩张前限制 step/event/target 数量、流式计算 raw/event/final-state digest。
- v2 manifest 同时绑定 source graph、serialized image、observability、DUT exact bytes、stdin、完整执行 options/device timeline/cycle/stop/halt/step/seed/resource policy，以及 assembler/oracle 的全部 evidence revision。
- bundle 内所有相对路径只接受 canonical `/`；反斜杠、大小写折叠碰撞、symlink/junction、非普通文件和 containment escape 均 fail closed。
- 早期 v2 和 v1 仍可读取；缺少任一闭包字段只能得到明确 issue，不能充当完整验证证据。v1 永久只读。

## Immutable engine registry

`engineRegistry.ts` 以 `role + SHA-256` 为唯一键，流式/原子写入 `.co/engine-registry/<role>/<digest>/`，artifact 上限 256 MiB、metadata 上限 16 KiB，并拒绝路径逃逸、symlink、metadata/bytes/hash/运行中漂移。`runMarsFile` 每次先将用户配置的 JAR（以及需要时的 P7 RI class）捕获到 registry，然后只执行私有 staged copy。

磁盘中“恰好具有某 digest”的文件只证明身份，不证明信任。`stageForExecution` 接受两种授权根：当前进程通过 `registerFile/registerBytes` 绑定的可信输入，或编译进插件的版本化 `EngineArtifactTrustManifest`。默认静态清单固定了已审查的 MARS v0.6.3 / course1 release SHA-256、大小和规范角色，以及插件自带 P7 RI class；同一 release SHA 还可匹配历史 case 使用的 `user-configured-mars` 角色。因而 fresh registry 可校验并 stage 保留的固定 artifact。

registry **不会**从 `.co`、case 目录或 artifact 邻近位置自动发现 authorization/receipt。那些目录可由工作区写入，`artifact.json` 只描述并约束字节身份；伪造一个叫 receipt/approval 的 JSON 不会增加执行权限。编译态清单在构造时严格校验 schema、role、SHA-256、大小、文件名和重复 key。当前没有接收任意外部 manifest 的 API；将来若增加动态 approval receipt，必须先用插件内嵌公钥验签，再转换为内部 trust identity。非固定的用户 JAR 在新进程中仍须重新绑定其原始可信文件，不能仅凭 archive 自授权。

Registry artifact 不按时间自动过期。保留策略固定为 `retain-until-explicit-live-manifest-gc`；未来 GC 必须先扫描所有保留 case，建立完整 live role+digest 集合，禁止仅按 mtime 清理。

一次已存在的非固定 artifact 运行仍会读取并哈希用户配置文件以确定 digest，再完整校验 registry entry，因此成本约为两次 JAR 顺序读取；固定清单命中则不依赖原配置路径，但仍完整哈希 registry entry 和私有 staged copy。不会重复启动额外 JVM。MARS JAR 约数 MiB，通常远低于 JVM 启动成本。若以后成为批量热路径，可增加“文件身份 + size/mtime 的保守缓存”，但命中前后仍须防止内容漂移，不能退回路径信任。

当前扩展在 manifest 中显式声明 `untrustedWorkspaces.supported=false`，由 VS Code 在 Restricted Mode 禁用。若以后改为 `limited` 或 `true`，必须同时给 MARS 执行入口增加函数级 Workspace Trust gate，并把 Java/JAR/RI 等工具链配置列入 `restrictedConfigurations`；registry 的 role+digest 授权只证明本次绑定的字节身份，不替代发行方真实性或工作区信任。

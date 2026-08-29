# mips-replay | src/mips/replay/ | 15 files

阶段 1 的离线 case closure。这里负责把“工作区路径 + 用户配置工具”转换为可验证的不可变输入，并提供 exact replay / re-evaluate API；不负责 VS Code 命令 UI。

- `canonical.ts`：递归 key 排序的 canonical JSON 与 SHA-256 helper。
- `atomicFile.ts`：跨平台原子文件替换（Windows 备份/回滚语义），供 builtin artifact 与 shadow bundle 共用。
- `boundedFile.ts`：对不可信 bundle 使用同一 FileHandle 的 stat/read/extra-byte/stat 有界读取，以及 manifest/source/image/trace/stdin/机器码/运行时硬上限。
- `sourceBundle.ts`：SourceUnit/include graph 捕获、验证与重建；扫描和重写均受 directive/bytes/unit 上限约束。
- `programImage.ts`：有基数上限的 ProgramImage/observability 序列化，以及流式 oracle evidence digest。
- `engineRegistry.ts`：不可变 engine artifact registry。
- `types.ts`：adapter context/result/selection 契约和 adapter registry。
- `legacyMarsAdapter.ts`：无 VS Code 依赖的真实 Java/MARS adapter。
- `builtinEngineArtifact.ts`：builtin executor 的逻辑不可变 artifact（revision 元组 + ISA catalog SHA-256）；当前编译版本可按该身份物化到 registry，身份不匹配时拒绝 exact replay。
- `builtinAssemblerEngineArtifact.ts`：builtin assembler 的独立逻辑 artifact；assembler semantics revision 与 catalog hash 参与身份，避免 executor-only 修改错误作废汇编证据，反之亦然。
- `builtinExecutionAdapter.ts`：`builtin-ts` 的双角色 exact replay/re-evaluate adapter；assembler 角色只从已验证的原始 source graph 重汇编，executor 角色直接执行 ProgramImage，两条路径分别校验 staged assembler/executor artifact。它不读取原 workspace；assembler 缺失 source graph、executor 收到 stdin，或任一角色 artifact 不匹配时均 fail closed。
- `../providers/fixedMarsReference.ts`：阶段 6 显式 fixed-reference gate；从编译态 trust manifest 只选择唯一 `legacy-course-executor` 身份，并对用户配置路径用同一 FileHandle 做普通文件/bytes/SHA-256/前后 stat 校验。它不会把相邻 receipt、工作区 manifest 或文件名当成授权。
- `structuredExecutionEvidence.ts`：严格解析 builtin event artifact，复核 event count、canonical event digest 与 engine/image/profile/stop envelope；final-state digest 由 bundle closure 和 replay 结果交叉绑定。
- `legacyMarsContract.ts`：legacy adapter 自有的机器码与 oracle 兼容检查 hook，避免 orchestration 假定未来引擎都使用 MARS 文本。
- `replayService.ts`：exact replay 与 append-only re-evaluate orchestration。
- `index.ts`：公开 facade 和默认 adapter registry。

## Bundle closure

- `sourceBundle.ts`：递归发现 MARS `.include "..."`，保存 root 和所有 include 的原始 UTF-8 bytes 到 `source/blobs/<sha256>.bin`，记录稳定 SourceUnit id、canonical edge/offset、显示用 provenance URI、捕获限额和 graph fingerprint。scanner 使用常量状态，先限制 directive 数量，再按 offset 线性重写；执行使用从 blobs/edges 确定性重建的只读 materialization，不再读取原工作区。
- `programImage.ts`：严格解析 HexText；在构建 Set、交叉引用或 fingerprint 前限制 segment、course words、symbol/sourceMap/inputGraph 基数；序列化/校验领域 `ProgramImage`（含空而诚实的 legacy source map）、保存 observability schema，并在 canonical event 扩张前限制 step/event/target 数量、流式计算 raw/event/final-state digest。
- v2 manifest 同时绑定 source graph、serialized image、observability、DUT exact bytes、stdin、完整执行 options/device timeline/cycle/stop/halt/step/seed/resource policy，以及 assembler/oracle 的全部 evidence revision。
- bundle 内所有相对路径只接受 canonical `/`；反斜杠、大小写折叠碰撞、symlink/junction、非普通文件和 containment escape 均 fail closed。
- 早期 v2 和 v1 仍可读取；缺少任一闭包字段只能得到明确 issue，不能 exact replay。v1 永久只读。

## Immutable engine registry

`engineRegistry.ts` 以 `role + SHA-256` 为唯一键，流式/原子写入 `.co/engine-registry/<role>/<digest>/`，artifact 上限 256 MiB、metadata 上限 16 KiB，并拒绝路径逃逸、symlink、metadata/bytes/hash/运行中漂移。`runMarsFile` 每次先将用户配置的 JAR（以及需要时的 P7 RI class）捕获到 registry，然后只执行私有 staged copy。

磁盘中“恰好具有某 digest”的文件只证明身份，不证明信任。`stageForExecution` 接受两种授权根：当前进程通过 `registerFile/registerBytes` 绑定的可信输入，或编译进插件的版本化 `EngineArtifactTrustManifest`。默认静态清单固定了已审查的 MARS v0.6.3 / course1 release SHA-256、大小和规范角色，以及插件自带 P7 RI class；同一 release SHA 还可匹配历史 case 使用的 `user-configured-mars` 角色。因而 fresh registry 能在原工具链路径消失后执行保留的固定 artifact。

registry **不会**从 `.co`、case 目录或 artifact 邻近位置自动发现 authorization/receipt。那些目录可由工作区写入，`artifact.json` 只描述并约束字节身份；伪造一个叫 receipt/approval 的 JSON 不会增加执行权限。编译态清单在构造时严格校验 schema、role、SHA-256、大小、文件名和重复 key。当前没有接收任意外部 manifest 的 API；将来若增加动态 approval receipt，必须先用插件内嵌公钥验签，再转换为内部 trust identity。非固定的用户 JAR 在新进程中仍须重新绑定其原始可信文件，不能仅凭 archive 自授权。

Registry artifact 不按时间自动过期。保留策略固定为 `retain-until-explicit-live-manifest-gc`；未来 GC 必须先扫描所有保留 case，建立完整 live role+digest 集合，禁止仅按 mtime 清理。

一次已存在的非固定 artifact 运行仍会读取并哈希用户配置文件以确定 digest，再完整校验 registry entry，因此成本约为两次 JAR 顺序读取；固定清单命中则不依赖原配置路径，但仍完整哈希 registry entry 和私有 staged copy。不会重复启动额外 JVM。MARS JAR 约数 MiB，通常远低于 JVM 启动成本。若以后成为批量热路径，可增加“文件身份 + size/mtime 的保守缓存”，但命中前后仍须防止内容漂移，不能退回路径信任。

当前扩展在 manifest 中显式声明 `untrustedWorkspaces.supported=false`，由 VS Code 在 Restricted Mode 禁用。若以后改为 `limited` 或 `true`，必须同时给 MARS 执行入口增加函数级 Workspace Trust gate，并把 Java/JAR/RI 等工具链配置列入 `restrictedConfigurations`；registry 的 role+digest 授权只证明本次绑定的字节身份，不替代发行方真实性或工作区信任。

## Replay modes

- `exactReplayCase`：执行前后均以 `case.json before → 完整 bundle closure → case.json after` 复核，assembler/executor adapter 各自使用独立 source/config/stdin/engine stage；逐项核对 image、DUT bytes、stop reason、raw output、event、final state、steps 和 event count。builtin assembler exact replay 使用 bundle 中的原始 blobs/include edges，不依赖重写后的 materialized include 文本。
- `reEvaluateCase`：在第一个 `await` 前快照调用方选择、路径、时间和 signal，再使用显式选择的当前 assembler/oracle 与原始 run input；发布前后都复核完整原 bundle，失败删除 pending/published 结果。成功结果只追加到 `re-evaluations/<timestamp>-<id>/`，旧裁决永不覆盖。
- execution adapter 明确接收 assembler 的 `ProgramImage`/DUT bytes。legacy MARS 不能直接加载 image，因此会在隔离目录重新汇编并先证明 fingerprint/bytes 完全相同，再运行源文件。
- full-stack shadow 不复用主路径 image：它从 case 的已验证 source blobs 在 bundle 内二次 materialize，分别运行 builtin assembler→builtin executor 与 fixed legacy assembler→legacy 自身 image/executor；两端 input graph、legacy dump/image/binding、reference 前后 hash 和跨阶段 artifact continuity 都闭合后才允许分类。每次结论都保存 bundle，inconclusive/not-comparable 阻断。
- assembler 结果先 canonical serialize/deserialize、重算 fingerprint 并形成权威深冻结副本；execute、validation hook 和最终比较只消费该副本及独立 DUT byte copy。adapter 另收到深克隆/冻结的配置和 input graph、独立 stdin copy、独立 materialized source；返回后 source tree 与 executable byte copy 都会复核，避免跨 stage 污染。
- stock/legacy MARS 没有可信的“因 max-step 耗尽退出”信号；因此 replay 只有在 trace 证明标准自分支+nop halt-loop 时接受正常停止，记录为 `step-limit` 的 legacy case 会在启动 JVM 前 fail closed。
- `index.ts`：公开 facade；`createDefaultReplayAdapterRegistry()` 注册 legacy MARS 与一个同时支持 builtin assembler/executor artifact role 的 `BuiltinTsReplayAdapter`。

外部工具真实回归默认跳过，可显式运行：

```powershell
$env:CO_REAL_MARS_JAR='D:\Program FIles\Mars\Mars.jar'
npx vitest run src/test/mipsReplay/realLegacyMarsReplay.integration.test.ts
```

该用例先用真实 MARS 建立 bundle，删除原 workspace，再从保留的 case + engine registry exact replay。单元回归另用 fresh registry（不继承会话授权）证明静态 trust manifest 闭包，并证明工作区自造 authorization 文件不能授权执行。

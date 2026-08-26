# mips-replay | src/mips/replay/ | 10 files

阶段 1 的离线 case closure。这里负责把“工作区路径 + 用户配置工具”转换为可验证的不可变输入，并提供 exact replay / re-evaluate API；不负责 VS Code 命令 UI。

- `canonical.ts`：递归 key 排序的 canonical JSON 与 SHA-256 helper。
- `boundedFile.ts`：对不可信 bundle 使用同一 FileHandle 的 stat/read/extra-byte/stat 有界读取，以及 manifest/source/image/trace/stdin/机器码/运行时硬上限。
- `sourceBundle.ts`：SourceUnit/include graph 捕获、验证与重建；扫描和重写均受 directive/bytes/unit 上限约束。
- `programImage.ts`：有基数上限的 ProgramImage/observability 序列化，以及流式 oracle evidence digest。
- `engineRegistry.ts`：不可变 engine artifact registry。
- `types.ts`：adapter context/result/selection 契约和 adapter registry。
- `legacyMarsAdapter.ts`：无 VS Code 依赖的真实 Java/MARS adapter。
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

磁盘中“恰好具有某 digest”的文件只证明身份，不证明信任。`stageForExecution` 还要求当前 registry 实例已通过 `registerFile/registerBytes` 对可信输入显式授权同一 role+digest；新实例不能直接执行工作区预置条目。调用方需要在本次会话重新绑定用户/发行资产后再 replay。

Registry artifact 不按时间自动过期。保留策略固定为 `retain-until-explicit-live-manifest-gc`；未来 GC 必须先扫描所有保留 case，建立完整 live role+digest 集合，禁止仅按 mtime 清理。

一次已存在 artifact 的运行仍会读取并哈希用户配置文件以确定 digest，再完整校验 registry entry，因此成本约为两次 JAR 顺序读取；不会重复复制/启动额外 JVM。MARS JAR 约数 MiB，通常远低于 JVM 启动成本。若以后成为批量热路径，可增加“文件身份 + size/mtime 的保守缓存”，但命中前后仍须防止内容漂移，不能退回路径信任。

当前扩展在 manifest 中显式声明 `untrustedWorkspaces.supported=false`，由 VS Code 在 Restricted Mode 禁用。若以后改为 `limited` 或 `true`，必须同时给 MARS 执行入口增加函数级 Workspace Trust gate，并把 Java/JAR/RI 等工具链配置列入 `restrictedConfigurations`；registry 的 role+digest 授权只证明本次绑定的字节身份，不替代发行方真实性或工作区信任。

## Replay modes

- `exactReplayCase`：执行前后均以 `case.json before → 完整 bundle closure → case.json after` 复核，两个 adapter 各自使用独立 source/config/stdin/engine stage；逐项核对 image、DUT bytes、stop reason、raw output、event、final state、steps 和 event count。
- `reEvaluateCase`：在第一个 `await` 前快照调用方选择、路径、时间和 signal，再使用显式选择的当前 assembler/oracle 与原始 run input；发布前后都复核完整原 bundle，失败删除 pending/published 结果。成功结果只追加到 `re-evaluations/<timestamp>-<id>/`，旧裁决永不覆盖。
- execution adapter 明确接收 assembler 的 `ProgramImage`/DUT bytes。legacy MARS 不能直接加载 image，因此会在隔离目录重新汇编并先证明 fingerprint/bytes 完全相同，再运行源文件。
- assembler 结果先 canonical serialize/deserialize、重算 fingerprint 并形成权威深冻结副本；execute、validation hook 和最终比较只消费该副本及独立 DUT byte copy。adapter 另收到深克隆/冻结的配置和 input graph、独立 stdin copy、独立 materialized source；返回后 source tree 与 executable byte copy 都会复核，避免跨 stage 污染。
- stock/legacy MARS 没有可信的“因 max-step 耗尽退出”信号；因此 replay 只有在 trace 证明标准自分支+nop halt-loop 时接受正常停止，记录为 `step-limit` 的 legacy case 会在启动 JVM 前 fail closed。
- `index.ts`：公开 facade；`createDefaultReplayAdapterRegistry()` 当前注册 legacy MARS，builtin-ts 在后续 assembler/executor 阶段注册。

外部工具真实回归默认跳过，可显式运行：

```powershell
$env:CO_REAL_MARS_JAR='D:\Program FIles\Mars\Mars.jar'
npx vitest run src/test/mipsReplay/realLegacyMarsReplay.integration.test.ts
```

该用例先用真实 MARS 建立 bundle，删除原 workspace，再从保留的 case + engine registry exact replay。

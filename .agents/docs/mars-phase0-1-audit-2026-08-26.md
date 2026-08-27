# MARS TypeScript Core 阶段 0/1 审计（2026-08-26）

> 审计范围：`6da4674` 起至本报告所在提交，包含其间所有提交和审计修复集。
>
> 结论：阶段 0/1 的计划内基础实现已经落地并通过本机验证；两个阶段都**尚未正式过门**。剩余阻断是 GitHub protected-branch/code-owner enforcement、人工 expected-data 审批、Timer official-RTL required evidence、固定 runner benchmark 审批和 Windows/Linux 远端 portability evidence，不是继续把候选数据自动写成 approved。

## 1. 审查口径与已确认决策

本轮逐提交检查了以下演进链，而非只审查最终快照：

| 提交 | 审查主题 |
| --- | --- |
| `6da4674` | 课程 contract、decision、divergence ledger |
| `1b71543` | 三种角色的 MARS reference 固定与 fail-closed 下载 |
| `044bab0` | 独立 conformance runner、初始 corpus/seeds/sentinels |
| `6f67c42` | provider-neutral contracts |
| `175d1e2` | manifest v2 与 v1 只读兼容 |
| `71e5d93` | 唯一 ISA catalog/generator |
| `3833015` | lazy Worker host 与模块边界 |
| `3406d0e`、`76845dd` | 文档索引与过时文档清理 |
| `f91da9a` | legacy course executor reference artifact |
| `d24a6dd` | 阶段 0/1 第一轮安全与正确性加固 |
| 本报告所在提交 | corpus/expected/benchmark/CLI/Worker/replay/equivalence 的补齐及第二轮对抗性审计修复 |

状态定义：

- **实现完成**：代码、测试和本地可复核证据已经存在。
- **本地验证通过**：下文列出的命令在本机实际成功。
- **正式过门**：所有计划 required gate 都有指定环境与审批主体的证据。它不会由“本地测试全绿”自动推出。

用户确认的治理决策：

- expected data 与 benchmark 采用同一套 candidate → diff/review → approve → protected baseline 模型。
- 审阅者字段使用 GitHub 用户名 `stone926`。
- 固定 benchmark runner 只认 `windows-2025` 与 `ubuntu-24.04`，不得用本机标签或近似系统冒充。
- 本轮没有执行任何 approve 命令，没有自动批准 `courseVector`、ISA golden 或 benchmark baseline。

## 2. 总体结论

| 阶段 | 实现状态 | 正式 gate | 结论 |
| --- | --- | --- | --- |
| 阶段 0 | contract/reference/corpus/runner/expected candidate/fixed benchmark harness/formal gate 均已落地 | GitHub branch protection、expected 人工审批、Timer RTL、两平台 benchmark candidate+approval 尚缺 | **实现完成，未正式过门** |
| 阶段 1 | provider/ISA CLI/Worker/process/replay/equivalence/portability workflow 均已落地 | GitHub Actions 两平台真实证据尚未产生 | **本地实现通过，未正式过门** |

legacy MARS 仍是当前默认 provider。本轮没有提前宣称阶段 2–7 的 TypeScript 汇编器或执行器完成，也没有改变默认课程语义。

## 3. 阶段 0 逐项审计

| 门槛 | 当前证据 | 状态 |
| --- | --- | --- |
| P3–P7 contract/decision/divergence 有稳定 ID、来源和裁决 | 73 contracts、10 frozen decisions、12 divergences；本地核对 152 个来源实例 | 实现完成 |
| reference 角色唯一、hash 固定、fail closed | stock assembler、frozen regression、legacy course executor 三项资产逐字节验证；9/9 regression 通过 | 实现完成 |
| 独立 conformance runner 只经 CLI/JSONL 调生产 TS ISA 服务 | versioned JSONL CLI、严格 schema/UTF-8/行长/背压；expected-data 文件系统闭包阻断 direct/dynamic production catalog/contracts 读取 | 实现完成 |
| P3–P7 课程语料与固定随机输入 | 7 个 spec microprogram、9 个 challenge、每 profile 50 个 seed；250 个唯一 source/image、共 5,000 words 由固定 MARS image 与 TS CLI encode/decode 双重核对；20 个手写 feature、4 个组合 gate | 实现完成 |
| evidence capability/bin/fingerprint 冻结 | 4 个 evidence kind、22 个 P3–P7 capability scope、589 个稳定 bin ID；逐 bin minimum；kind-specific required/forbidden fingerprint fields | 实现完成 |
| `courseVector` 与 ISA golden 独立管理 | 10 个 courseVector、33 条 ISA golden；候选刷新会撤销旧审批，MARS golden 不引用 courseVector | candidate 可复核，未批准 |
| planted mutants/sentinels 能使 harness 失败 | 错 expected、额外/遗漏写、provenance 漂移、required skip、错误 fingerprint、伪 runner 标签等负向测试通过 | 实现完成 |
| 固定 runner benchmark policy/harness | 冻结 workload/lifecycle/sample/statistics/CPU/RSS/CI schema；只接受 Windows 2025 与 Ubuntu 24.04 成对 candidate/approval | harness 完成，远端数据未批准 |
| Timer official RTL required lane | 缺 Icarus 时明确失败，不允许 skip 伪通过 | 本机 unavailable，等待 CI |
| candidate/formal gate 与 reviewer 治理 | candidate summary 固定 `required:false`；formal 聚合 ISA/course/TS-CLI/benchmark approval；集中 reviewer policy 与 CODEOWNERS | 仓库内实现完成，外部 branch protection 待配置/核验 |

阶段 0 的红灯是有意保留的治理门：`run:candidate` 可执行但不能自称 required；`run:required` 已改为 formal alias，`verify:formal` 聚合全部批准证据并当前必须失败；benchmark approved gate 当前必须报告四个 runner candidate/approval 文件缺失。

## 4. 阶段 1 逐项审计

| 门槛 | 当前实现/证据 | 状态 |
| --- | --- | --- |
| provider-neutral contracts/resolver | capability/preflight/稳定诊断、按 services 隔离 registry、运行开始后不 fallback | 本地通过 |
| legacy launch 一致且不可竞态修改 | profile/memory/Java/JAR/RI class/timeout/extra args 一次解析；请求与 launch 快照化并在 await 边界复核 | 本地通过 |
| 唯一 ISA catalog + CLI | 生成 catalog、encode/decode service、versioned bounded JSONL batch CLI | 本地通过 |
| Worker lazy start、slice cancellation、backpressure | protocol v2；真实 encode/decode job；128 项 slice；从 0 连续 sequence、单个未 ACK batch、consumer 成功后才 ACK；崩溃 generation 恢复 | 本地通过 |
| 外部进程监督 | Abort/timeout 整棵进程树、pipe close、单次 settle、stdout/stderr raw-byte ceiling | Windows 真实 JVM fixture 通过 |
| v2 replay closure | 完整 SourceUnit/include graph、ProgramImage、observability、DUT bytes、stdin、run input、engine identity 和 evidence digest | 本地通过 |
| immutable engine registry | role+SHA-256、同句柄流式复制/复核、会话绑定或插件编译态固定信任根、每次执行独占 stage、256 MiB artifact/16 KiB metadata 上限 | 本地通过 |
| exact replay | 脱离原 workspace；assembler/oracle 独立 materialization/config/stdin/stage；前中后完整 closure 复核 | 本地与真实 MARS 通过 |
| re-evaluate | caller selection 快照化；append-only 发布；失败删除 pending/published；原裁决不覆盖 | 本地通过 |
| 旧/新 legacy 等价 | 真正的 provider 迁移前父提交 `044bab0` direct `runMarsFile` 对当前 provider；P3/P5/P7 × success/assembly-failure × 两种 reference role；逐字节 machine code/trace + verdict/halt PC | 12/12 本地通过 |
| 两平台 portability | workflow 固定 Node 24、Java 25，并运行 CLI/Worker/process/MARS replay/equivalence | workflow 已落地，远端尚未执行 |

## 5. 审计发现与修复

下列问题均在本轮通过恶意/竞态输入复现后修复，并补了定向测试。

### 5.1 身份、信任与 TOCTOU

- provider preflight 在第一个 `await` 前对请求取指纹，返回后再次核对；真正执行只消费不可变语义快照。
- 用户配置 JAR 与 P7 RI companion 先注册为 role+digest，再复制到本次运行的独占 stage；Java 不直接打开 workspace registry 路径。
- registry 磁盘中存在相同 digest 不代表可信。执行授权只能来自本进程的 `registerFile/registerBytes` 显式绑定，或编译进插件并与 reviewed reference manifest 保持同步的 role+SHA-256+size 清单；工作区自造 metadata/receipt 不会获得权限。固定 MARS release 和插件 P7 class 因而可由 fresh registry 复核并 stage，其他用户 JAR 仍须在新进程重新绑定。
- artifact、source graph、manifest、stdin、ProgramImage 和 trace 均在关键外部调用前后复核；re-evaluate 在发布前后再次核对原 bundle。
- extension manifest 显式声明 `untrustedWorkspaces.supported=false`，因此 VS Code Restricted Mode 不会激活可执行外部工具的扩展入口；若未来放宽，必须同时增加函数级 trust gate 与 restricted toolchain configurations。

### 5.2 Replay stage 隔离与权威数据

- assembler 返回后立即结构校验并重算 ProgramImage fingerprint，随后建立权威深克隆/冻结副本；execute、validation hook 和最终比较只使用该副本及独立 byte copy。
- assembler/oracle 使用不同的 source materialization、configuration clone、stdin copy 和 engine stage，adapter 无法通过修改共享对象污染下一阶段。
- `ReplayEngineAdapter.execute` 显式接收 ProgramImage/DUT bytes。legacy MARS 需在隔离 proof 目录重新汇编并先证明 fingerprint/bytes 相同，才运行源文件。
- re-evaluate 的 assembler/oracle selection 在入口深克隆/冻结，结果 provenance 不会被 callback 后改写。

### 5.3 不可信输入与资源上限

- manifest/source/image/trace/stdin/machine-code/engine artifact 使用同 FileHandle 的 stat/read/extra-byte/stat 有界读取，拒绝非普通文件、symlink、大小/identity 漂移和非无损 UTF-8。
- SourceUnit scanner 为常量状态流式解析；directive 数量先限额，include 重写按 offset 一次排序/chunk join，避免 token/directive bomb 和二次重拼。
- ProgramImage 在任何 Set、交叉引用和 fingerprint 前限制 segment、4096 course words、symbol/sourceMap/inputGraph cardinality，并使用 Set lookup。
- oracle trace 流式计算 event/final-state digest，并在 canonical event 扩张前执行 262,144 steps/events、单指令 64 raw events、32 GPR targets、4096 DM targets ceiling。
- `p7.probe` 在 canonicalize 前用迭代式深度/node/key/string-byte ceiling 验证，20,000 层对象只产生 manifest issue，不再抛 `RangeError`。
- production `runMarsFile` 对 stdout/stderr 各实施 16 MiB raw ceiling；触发即终止整棵进程树。manifest 记录同一真实 `maxTraceBytes`，不再伪称无界。
- `asmCaseStore` 的 root/stdin/artifact/manifest ingestion 全部改为同句柄有界普通文件读取；manifest discovery 流式枚举，并限制 2048 个条目及 16 MiB manifest 总量。
- bundle 相对路径只接受 canonical `/`，反斜杠、大小写碰撞、临时目录、最终发布目录、symlink/junction 和 containment escape 均 fail closed；POSIX 上“反斜杠文件与斜杠目录并存”的双文件攻击有回归覆盖。

### 5.4 语义闭包与 fail-closed diagnostics

- legacy assembly provenance 保存 profile/runtime/wallClock/p7RI，与 oracle run configuration 分离；memory/profile 不一致会拒绝回放。
- exit-code 为 0 但输出含 unsupported `coL/coL2/efc/p7irq/cl/memory` 或 dump failure 时，生产与 replay 使用同一诊断逻辑失败。
- trace、case JSON、ASM/stdin、machine dump 都要求无损 UTF-8；HexText 同时限制 bytes 与 parsed words，防止短文本解析扩张。
- P7 external IRQ 的 target-4/target canonical simple pair 在生成与 bundle 校验共用同一静态契约。
- stock/legacy MARS 没有可信的 max-step exhaustion signal；replay 只在 trace 证明标准自分支+nop halt-loop 时接受正常停止，记录为 `step-limit` 的 legacy case 在启动 JVM 前 fail closed，避免把超时/预算耗尽误判为通过。

### 5.5 Gate、审批身份与证据 provenance

- 旧 `run:required` 会在 candidate 数据上 exit 0 并输出 `required:true`；现已拆成 `run:candidate` 与 `run:formal`，candidate summary 强制为 `gate:candidate, required:false`，formal 禁止 filter/record/partial lane 并要求 approved course vectors。
- `verify:formal` 统一聚合 official RTL、approved ISA/courseVector/TS CLI、两平台 approved benchmark、references、corpus、tests 和完整 formal lanes；任何缺项都保持红灯。
- courseVector、ISA 与 benchmark 的 approval validator 共用 `reviewerPolicy.mjs`，只接受 GitHub 用户名 `stone926`；`.github/CODEOWNERS` 覆盖整个 conformance、evidence workflows、CODEOWNERS 自身与性能 ADR。
- JSON reviewer 只是可审计声明，不是签名。真实身份仍必须在 GitHub Settings 中启用 protected `main`、Require review from Code Owners、dismiss stale approvals、禁止 direct push，并在正式关阶段 0 时要求 formal status；源码不能替代这项仓库外配置。
- legacy equivalence 原先错误固定到 provider 迁移后的 `d24a6dd`，无法证明“迁移前等价”。现固定到 `6f67c42` 的直接父提交 `044bab0`，校验 commit/tree/`mips.ts` blob、父子关系及 baseline 不含 provider 目录，并在历史运行前后复核 JAR digest。
- Worker 原先在 `onProgress` 抛错时仍 ACK 并可接受成功 terminal，导致结果批次丢失却误绿。现只有消费成功才按从 0 连续的 sequence ACK；consumer failure、首序号非 0、重复/跳号、并发 progress 或未 ACK 即成功 terminal 均 fail closed。

## 6. 本地验证结果

以下为全部审计修复完成后在 Windows 工作区实际运行的最终证据。

| 命令/证据 | 结果 |
| --- | --- |
| `npm run compile`、`npx tsc --noEmit` | 通过 |
| `npm test` | 143 files passed、1 skipped；1679 tests passed、3 skipped |
| `node scripts/check-index.mjs` | 0 error；已有 warning 仍按项目策略允许 |
| module boundary + generated ISA check | 通过 |
| conformance `node --test` | 55/55 |
| contract sources | 73 contracts、10 decisions、12 divergences；152 reference instances |
| ISA golden / TS CLI | 33 instructions + 5 runtime counterexamples，candidate 可复核 |
| course vectors | 10/10，candidate 可复核 |
| corpus freeze / fixed seed evidence | P3–P7 各 50 seeds；250 unique source graphs + 250 unique images；5,000 words 经固定 MARS + TS JSONL CLI；20 handwritten features；4 combinations |
| candidate conformance lanes | 14/14（4 legacy baseline + 10 course vector），summary 为 `gate:candidate, required:false` |
| formal conformance/aggregate gate | 按设计非零退出；candidate 与缺失 approval 不能误绿 |
| pinned references / regression | 3 个资产 hash 通过；9/9 regression |
| `test-cli` | 6/6 |
| real legacy MARS offline replay | 2/2 |
| pre-migration/current legacy equivalence | 12/12；baseline=`044bab0`（provider migration `6f67c42` 的父提交） |
| real JVM process supervisor | abort/timeout 两项均完成 descendant termination、pipe close、single settlement |

按设计保持失败的 gate：

- aggregate `verify:formal` / formal lane：失败，任何 candidate 或外部 evidence 缺失都不能满足 gate。
- ISA `--require-approved`：失败，尚未独立批准。
- courseVector `--require-approved`：失败，尚未独立批准。
- TS CLI approved gate：失败，因为所依赖 ISA golden 仍是 candidate。
- benchmark approved gate：失败，缺少两平台各自的 candidate 与 approval 四个文件。
- Timer decision `--require-rtl`：失败，本机没有 `iverilog/vvp`；其他三类 directed decision 通过。

这些失败不是待代码绕过的问题，而是正式过门所需的人/环境证据。

## 7. 剩余工作与过门顺序

1. 在 GitHub Settings 为 `main` 启用 Require review from Code Owners、dismiss stale approvals、禁止 direct push，并在正式关阶段 0 时要求 formal status；确认管理员不能静默绕过。
2. 在受保护分支/PR 上让 `phase1-portability.yml` 同时完成 `windows-2025`、`ubuntu-24.04` 两项工作，并保存 evidence artifacts。
3. 在带 Icarus 的 required CI 运行 Timer official RTL vector；不得把 `UNAVAILABLE` 改成 pass。
4. 由 `stone926` 审查 candidate diff 后，使用专用 approve 命令分别批准 ISA golden 与 10 个 courseVector；禁止脚本自批。
5. 在两个固定 runner 采集完整 benchmark candidate，检查 fingerprint、统计区间和 envelope 后分别批准；本机 smoke 不入基线。
6. 所有证据齐全并由 `verify:formal` 通过后，再把阶段 0/1 状态改为 formally passed，并开始阶段 2 的 P3–P6 TypeScript machine execution core。

在这些门槛完成之前，默认 provider 继续保持 legacy MARS，回滚路径不变。

## 8. 正式过门记录（2026-08-27 增补）

以下五项阻断已全部解除，阶段 0/1 正式过门。每项均附可复核证据；没有任何一项用
本机 smoke 或近似环境替代指定环境。

1. **expected-data 人工审批**：四类候选（corpus 1、courseVector 10、isaGolden 1、
   marsGolden 4）由所有者授权的独立审阅完成，16 份不可变审批信封于
   `conformance/mips/governance/approvals/`。审阅方法与逐项结论（含 4 条记录在案的
   发现）见 `conformance/mips/governance/reviews/phase0-expected-data-review-2026-08-27.md`。
   信封 schema 无字段记录实际执行审阅的主体，该文档是这些信封的 provenance 说明。
2. **两平台 portability 证据**：run 33074105808 在 `windows-2025` 与 `ubuntu-24.04`
   双平台完整通过（compile/tree-clean/npm test/CLI/Worker/process supervisor/MARS
   replay/legacy equivalence）。
3. **Timer official-RTL required lane**：CI（ubuntu-latest + Icarus）中
   `PASSED COURSE-P7-TIMER-RESTART-001: official RTL via Icarus; sha256-lf 047ac467…`
   （11 向量），见 run 33076598577 的 Test and compile 与 Phase 0 formal gate 两步。
4. **两平台 benchmark 审批**：run 33074237426 的 `github-hosted:ubuntu-24.04`
   （ubuntu24:20260101.1）与 `github-hosted:windows-2025`（win25-vs2026:20260818.207.1）
   各产出 49 cells / 343 样本 candidate，经 validate --require-eligible 复核后批准，
   信封在 `conformance/mips/bench/baselines/`；`benchmark:verify-approved` 通过。
5. **branch protection / code-owner 强制**：本增补提交推送后立即在 GitHub 上配置
   （require code-owner review、dismiss stale approvals、required status checks、
   enforce admins、禁止直推/force-push/删除），随后由远端运行结果核验。

**Formal gate**：run 33076598577 的 `Phase 0 formal gate (approved evidence only)`
通过（ubuntu-24.04），`verify:formal` 全链路绿，summary `gate=formal-required,
required=true, passed=14, failed=0`。

**过程修复记录**（远端证据过程中发现并修复的真实缺陷，均已单独提交）：

- `isaCatalogSha256` 依赖磁盘换行字节，Windows/Linux 指纹不一致 —— 改为 LF 规范化
  哈希（`979ad10`）；ISA golden 重新绑定并重新审批（review-revision 2）。
- `generate-manifest-config.mjs` / `generate-syntaxes.mjs` / `generate-diagnostic-catalog.mjs`
  的比较/写入对 CRLF 检出不安全（`979ad10`、`dc7ee02`、`795628c`）。
- `verify-generated-tree-clean.mjs` 在 Windows 下无法 spawn npm.cmd（`ff13f58`）。
- `test-cli/src/legacyEquivalence.ts` 未迁移到 provider-neutral `ExecuteRequest.image`
  （`dc7ee02`）。
- benchmark hosted-image 断言未涵盖 `win25-vs2026` 镜像标签（`dc7ee02`）。
- `readResourceTemplate` 未规范化换行，扩展产物随检出平台漂移（`795628c`）。
- 三个哨兵测试原先假设出厂 artifact 永远未批准；改为对空 approval root 证明
  fail-closed（`168d107`）。

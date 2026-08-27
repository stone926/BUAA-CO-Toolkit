# ADR-0001：MIPS 引擎性能基线采集与批准策略

- 状态：已接受策略；阶段 0 的 baseline 已采集；批准机制已于 2026-08-27 简化（见“产物与维护”）
- 日期：2026-08-26
- 决策者：stone926
- 对应计划：MARS TypeScript Core 实施方案 §8.1

## 决策

阶段 0 的 MARS 冷启动基线只接受 GitHub Actions 的
`ubuntu-24.04` 与 `windows-2025` 两个受控 runner。候选产物必须记录 image
revision、CPU 型号/策略、逻辑 CPU 数、内存、Node、Java、并发度 1、固定 MARS
artifact hash 和完整 matrix hash。runner 硬件可能由 GitHub 调度而变化，因此任何
runner fingerprint 变化都形成新桶，不能与旧桶拼样本。

候选还必须绑定 `stone926/BUAA-CO-Toolkit` 的手工 dispatch、受保护 `main` 分支上的精确
CI workflow ref、commit
SHA、job id、run id/attempt URL、hosted runner 名称/OS/arch。审批人必须打开该 run URL
核对下载产物；JSON 中的 provenance 用于审计和 fail-closed 校验，本身不冒充签名证明。

每个 cell 至少采集 7 个独立 fresh-JVM 样本，保存原始 wall-clock、CPU、peak RSS
和 stdout/stderr 字节数；汇总采用 nearest-rank p50/p95，并保存固定算法的 p95 95%
bootstrap interval。完整 matrix 包含：

- 10、200、1,000、4,096-word 冷端到端汇编；
- 1K、65,536、1M-step 执行；
- trace off、commit、canonical full；
- 普通、访存密集、P7 exception、Timer、IRQ workload。

MARS CLI 没有已经证明完整复位的常驻进程，所以所有 MARS 数据必须标记为
`cold-end-to-end` / `fresh-jvm-per-sample`。不得把第二次 JVM、OS file cache 命中或同一
进程的第二个 case 标成 warm。TS 引擎落地后，first Worker、warm assemble、warm
execute 和 extension activation 使用 matrix 中另立的生命周期桶。

## 产物与维护

CI 只产生 candidate，不自动更新 baseline。`validate-fixed-benchmark.mjs` 会重新计算
matrix、p50/p95/CI、CPU/RSS 汇总和所有 hash。审阅 raw samples 与汇总后，把 candidate
替换进 `bench/baselines/` 并在提交信息里记录 run URL。任何重新测量、runner fingerprint、
matrix 或 reference hash 变化都对应一次新的替换与说明。

> 历史说明：阶段 0 过门时曾使用 `approve-baseline.mjs` 生成的 immutable approval
> envelope 作为正式证据；该机制对单人维护没有增加独立性，已于 2026-08-27 撤销，
> 当时的 envelope 归档在 `conformance/mips/governance/reviews/archived-approvals-2026-08-27/benchmark/`。
> 撤销的只是"批准"这个形式步骤，**采集环境的约束全部保留**：baseline 只能来自
> 受保护 `main` 的 CI dispatch。

不得填写估算值、复制另一操作系统的数字或以本地开发机 smoke 代替 controlled-runner
候选。阶段 0 使用的两套 candidate（run 33074237426）仍保留在本目录。

## 后续 gate

阶段 2 首次 TS runner 数据到齐后，在本 ADR 的后续 revision 中确认或调整计划给出的绝对
SLO；调整必须引用 CI candidate 数据，不能为了让实现过线而回填。相对 gate 固定为同
fingerprint 下 p95 相对上一份 TS baseline 回退不超过 15%。

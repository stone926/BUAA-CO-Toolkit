# ADR-0001：MIPS 引擎性能基线采集与批准策略

- 状态：已接受策略；阶段 0 的外部 baseline 数值仍待采集和独立批准
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

## 产物与批准

CI 只产生 candidate，不自动更新 baseline。`validate-fixed-benchmark.mjs` 会重新计算
matrix、p50/p95/CI、CPU/RSS 汇总和所有 hash。独立审阅 raw samples 与汇总后，审阅者用
`approve-baseline.mjs` 创建只写一次的 approval envelope；候选 JSON 和 envelope 一同
进入 `bench/baselines/`。任何重新测量、runner fingerprint、matrix 或 reference hash
变化都需要新 envelope/revision。

审批 envelope 的 reviewer 只允许 GitHub 用户名 `stone926`。该字符串仍不是签名：仓库必须
为 conformance trust-root 路径启用 `.github/CODEOWNERS`，并在 GitHub 受保护默认分支上要求
code-owner review、禁止直接 push、在新提交后撤销陈旧审批。源码只能声明这项要求，不能替代
GitHub 仓库设置本身。

不得填写估算值、复制另一操作系统的数字或以本地开发机 smoke 代替 controlled-runner
候选。当前目录没有 approved baseline，因此阶段 0 性能证据门仍保持未通过，直到两套
CI candidate 均经 `stone926` 审阅批准。

## 后续 gate

阶段 2 首次 TS runner 数据到齐后，在本 ADR 的后续 revision 中确认或调整计划给出的绝对
SLO；调整必须引用批准数据，不能为了让实现过线而回填。相对 gate 固定为同 fingerprint
下 p95 相对上一批准 TS baseline 回退不超过 15%。

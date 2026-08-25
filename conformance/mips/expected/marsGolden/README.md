# marsGolden

由固定 MARS reference（`reference-manifest.json` 的 `mars-assembler-v0.6.3` / regression ZIP）
生成，只证明 mars-compatible/迁移行为。

规则：

- 只能通过 conformance runner 的显式 MARS golden regeneration 命令
  （`run-conformance.mjs --lane legacy-baseline --record-golden`）写入；
  普通测试运行不得自动更新本目录。
- 每次更新必须人工审阅 raw 与 normalized diff。
- 任何命令不得把 `courseVector/` 与 `marsGolden/` 互相覆盖。
- 每个 golden 文件携带 provenance：MARS tag/commit/JAR hash/CLI options/Java 版本。

阶段 0 状态：目录结构冻结；golden 文件自阶段 1 语料扩展后开始积累。

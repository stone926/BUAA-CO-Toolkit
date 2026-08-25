# marsGolden

由固定 MARS reference（`reference-manifest.json` 的 `legacy-course-executor`）生成，
只证明该 course-executor fingerprint 下的迁移行为。

规则：

- 只能通过 conformance runner 的显式 MARS golden regeneration 命令
  （`run-conformance.mjs --lane legacy-baseline --record-golden`）写入；
  普通测试运行不得自动更新本目录。
- 每次更新必须人工审阅 raw 与 normalized diff。
- 任何命令不得把 `courseVector/` 与 `marsGolden/` 互相覆盖。
- 每个 golden 文件携带 deterministic provenance：source hash、MARS tag/commit/JAR hash、
  CLI options、runner/normalizer revision 与 corpus reviewer；不写入生成时间或绝对路径。

阶段 0 状态：四个 frozen microcase 已有 golden；缺失、hash/revision 漂移或未声明写入均失败。

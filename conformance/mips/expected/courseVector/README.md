# courseVector

由课程教程条款、官方设备规范/Verilog/TB 或人工审阅的数学 expected 构造，定义 course-correct
行为。MARS 命令永远不能重写本目录。

规则：

- 只能通过独立 contract-vector 命令和人工规范审阅更新。
- 每个向量携带 contract ID、教程来源路径/行号/内容 hash、reviewer 与 reviewedAt。
- 与 `marsGolden/` 物理隔离，任何命令不得跨目录覆盖。

阶段 0 的 course vectors 目前以 `corpus/manifest.json` 的 `expected` 字段（人工审阅值）表达；
阶段 1 起引入独立 vector 文件与生成命令。

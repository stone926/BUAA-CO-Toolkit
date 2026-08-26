# courseVector

由课程教程条款、官方设备规范/Verilog/TB 或人工审阅的数学 expected 构造，定义 course-correct
行为。MARS 命令永远不能重写本目录。

规则：

- 只能通过独立 contract-vector 命令和人工规范审阅更新。
- 每个向量携带 contract ID、教程来源路径/行号/内容 hash、reviewer 与 reviewedAt。
- 与 `marsGolden/` 物理隔离，任何命令不得跨目录覆盖。

阶段 0 起，每个 course vector 都是本目录内的独立 JSON artifact；`corpus/manifest.json`
只保存 artifact 文件名，绝不内嵌 course-correct expected。`manage-course-vectors.mjs`
是唯一写入入口：普通 verify 允许查看 candidate，阶段 gate 使用 `--require-approved`。

```text
node expected/courseVector/manage-course-vectors.mjs --review
node expected/courseVector/manage-course-vectors.mjs --verify
node expected/courseVector/manage-course-vectors.mjs --verify --require-approved
node expected/courseVector/manage-course-vectors.mjs --approve --reviewer stone926 --review-revision 1
```

`--refresh-integrity` 只刷新来源/内容 hash；只要 ASM、expected payload 或教程来源 registry
任一发生变化，已有 approved 状态会自动降级为 candidate，清空 reviewer/date/revision，必须重新
检查 raw ASM、normalized expected 与 diff 后再批准。MARS golden 命令从不导入或写入本目录。

审批策略只接受 GitHub 用户名 `stone926`。JSON 中的 reviewer 字符串是审计声明，不是身份签名；
真实身份必须由 `.github/CODEOWNERS` 与 GitHub 受保护分支的 code-owner review 强制，详见
`../../governance/README.md`。candidate runner 的 summary 固定为 `required: false`，只有 formal
gate 会要求并重新验证 approved 状态。

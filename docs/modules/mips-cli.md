# mips-cli | src/mips/cli/ | 2 files

供独立 conformance process 调用的纯 TypeScript ISA JSONL 边界；不导入 VS Code、课程 runner 或 expected-value 生成链。阶段 1 只暴露 describe 与 ISA encode/decode（单项及 batch），不是尚未实现的 assembler/executor。

- `protocol.ts` — protocol v1 的严格请求校验、未知字段拒绝、profile/layer scope、最多 4096 项 batch，以及稳定的结构化错误。
- `main.ts` — 每行最多 4 MiB 的流式 JSONL 入口；超长行边读边丢弃，非无损 UTF-8 拒绝，每个非空请求恰有一个响应，并等待 stdout drain 形成背压。

构建后入口为 `out/mips/cli/main.js`。`scripts/verify-mips-cli.mjs` 验证 describe、encode/decode、畸形输入、超限和进程退出语义；conformance 只能通过该进程边界访问生产 ISA 服务。

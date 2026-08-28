# mips-cli | src/mips/cli/ | 2 files

供独立 conformance process 调用的纯 TypeScript JSONL 边界；不导入 VS Code、课程 runner 或 expected-value 生成链。当前暴露 describe、ISA encode/decode（单项及 batch）、`assembler.assemble`（阶段 5 课程汇编器）、`machine.execute`（阶段 2/3 执行器）与 `device.cycleVector`（官方 Timer 周期向量）。`assembler.assemble` 接收 root/include source unit 与显式 include 边，返回 ProgramImage、诊断和 sourceMap origin。

- `protocol.ts` — protocol v1 的严格请求校验、未知字段拒绝、profile/layer scope、最多 4096 项 batch/segment、执行与设备向量上限，以及稳定的结构化错误。
- `main.ts` — 每行最多 4 MiB 的流式 JSONL 入口；超长行边读边丢弃，非无损 UTF-8 拒绝，每个非空请求恰有一个响应，并等待 stdout drain 形成背压。

构建后入口为 `out/mips/cli/main.js`。`scripts/verify-mips-cli.mjs` 验证 describe、encode/decode、畸形输入、超限和进程退出语义；conformance 只能通过该进程边界访问生产 ISA/执行服务。

`describe` 分别返回 `catalog`、`assembler`、`executor` 与 `device` 四组 revision：汇编证据含 assembler semantics/catalog，执行证据只含 executor/catalog 之外的字段，设备证据只含 CycleContract revision，避免不同 evidence kind 互相作废（计划第 7.6 节）。

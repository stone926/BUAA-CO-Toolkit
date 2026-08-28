# mips-cli | src/mips/cli/ | 2 files

供独立 conformance process 调用的纯 TypeScript JSONL 边界；不导入 VS Code、课程 runner 或 expected-value 生成链。当前暴露 describe、ISA encode/decode（单项及 batch）、`assembler.assemble`（阶段 5 课程汇编器）、`machine.execute`（阶段 2/3 执行器）与 `device.cycleVector`（官方 Timer 周期向量）。`assembler.assemble` 接收 root/include source unit 与显式 include 边，返回 ProgramImage、诊断和 sourceMap origin。

- `protocol.ts` — protocol v1 的严格请求校验、未知字段拒绝、profile/layer scope、最多 4096 项 batch/segment、执行与设备向量上限，以及稳定的结构化错误。
- `main.ts` — 每行最多 4 MiB 的流式 JSONL 入口；超长行边读边丢弃，非无损 UTF-8 拒绝，每个非空请求恰有一个响应，并等待 stdout drain 形成背压。

构建后入口为 `out/mips/cli/main.js`。`scripts/verify-mips-cli.mjs` 验证 describe、encode/decode、P3 assembler smoke、畸形输入、超限和进程退出语义；独立 `conformance/mips/runner/verify-ts-cli.mjs` 覆盖 ISA golden、P3 assembler smoke，并固定断言一个 P3 `machine.execute` 的停机、完整最终状态与 trace。conformance 只能通过该进程边界访问生产 ISA/汇编/执行服务。

course-vector lane 中，P3–P6 的 7 个 `program-final-state` 用例通过该边界先汇编再执行，P7 Timer vector 调用 `device.cycleVector`。P7 CP0 exception 与 external IRQ vector 当前没有对应的独立 CLI operation，runner 明确报告为 `directed-artifact-only` 并使用 `validated` 而非 `passed`；它们不是 CLI 执行覆盖。assembly-diff 也通过该边界运行 assembler，但当前 10 个对拍源都是单文件直接指令用例，复杂 include graph/macro/pseudo 与非空 data 的正确性来自 core/provider 测试而非该独立 lane。

`describe` 分别返回 `catalog`、`assembler`、`executor` 与 `device` 四组 revision：汇编证据含 assembler semantics/catalog，执行证据只含 executor/catalog 之外的字段，设备证据只含 CycleContract revision，避免不同 evidence kind 互相作废（计划第 7.6 节）。

# mips-cli | src/mips/cli/ | 2 files

独立 conformance process 调用生产引擎的唯一进程边界：纯 TypeScript JSONL over stdio，**不**导入 VS Code、课程 runner 或 expected-value 生成链。

- `protocol.ts` — protocol v1 严格校验：未知字段拒绝、profile/layer scope、batch/segment/执行/设备向量上限、稳定结构化错误
- `main.ts` — 每行最多 4 MiB 的流式 JSONL 入口（超长行边读边丢弃、非无损 UTF-8 拒绝、每请求恰一响应、等待 stdout drain 形成背压）

**暴露的操作**：`describe`、`isa.encode` / `isa.decode`（另有 `isa.encodeBatch` / `isa.decodeBatch`）、`assembler.assemble`、`machine.execute`、`device.cycleVector`。构建后入口为 `out/mips/cli/main.js`。

**设计决策**

- `describe` 返回 `catalog` / `assembler` / `executor` / `device` 四组**独立** revision，使执行/设备证据不会因汇编器或 catalog 变更而作废，反之亦然。
- 一切走有界 DTO：`assembler.assemble` 接收 root/include source unit 与显式 include 边，返回 ProgramImage、诊断与 sourceMap origin；conformance 无法绕过此边界直接调内部服务。
- P7 CP0 exception 与 external IRQ vector 目前没有对应 CLI operation，runner 明确报告为 `directed-artifact-only` 而非 `passed`——不得把定向 artifact 冒充 CLI 执行覆盖。

验证：`scripts/verify-mips-cli.mjs`（协议/畸形输入/超限/退出语义）+ `conformance/mips/runner/verify-ts-cli.mjs`（ISA golden、P3 assembler smoke、固定 P3 `machine.execute` 停机与最终状态）。默认切换门 `npm run verify:phase6`。

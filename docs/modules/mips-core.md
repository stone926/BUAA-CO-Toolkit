# mips-core | src/mips/core/ | 6 files

纯 TypeScript MIPS 引擎核心。无 VS Code/LSP/文件系统/Worker 依赖；模块边界由 scripts/check-module-boundaries.mjs 检查。

- api.ts — 核心数据契约：SourceUnit、ProgramImage、EngineDescriptor、EngineCapabilities、指令分层
- values.ts — 32/64 位值边界 helper（u32/s32/signExtend16/乘除 64 位/溢出标志）与固定宽度 hex 格式化
- generated/isaCatalog.ts — 由 scripts/generate-mips-isa.mjs 从 resources/mips/isa.json 生成（勿手改）
- isa/decoder.ts — 基于生成 catalog、profile 与 layer scope 的三层机器码解码（runtime RI candidate group / REGIMM-COP0 exact dispatch / 课程 canonical）
- isa/encoder.ts — 基于生成 catalog 的真实指令编码；拒绝未使用 operand、非 canonical 保留字段和课程外 CP0 rd
- isa/service.ts — CLI/Worker 共用的无宿主 encode/decode 服务 DTO；固定字宽输出且不泄露 generated entry 对象

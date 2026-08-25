# mips-core | src/mips/core/ | 2 files

纯 TypeScript MIPS 引擎核心（阶段 1 骨架）。无 VS Code/LSP/文件系统/Worker 依赖；模块边界由 scripts/check-module-boundaries.mjs 检查。ISA catalog 生成文件与 decoder/encoder 随对应切片加入本索引。

- api.ts — 核心数据契约：SourceUnit、ProgramImage、EngineDescriptor、EngineCapabilities、指令分层
- values.ts — 32/64 位值边界 helper（u32/s32/signExtend16/乘除 64 位/溢出标志）与固定宽度 hex 格式化

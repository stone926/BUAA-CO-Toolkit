# mips-host | src/mips/host/ | 5 files

懒启动 Worker 宿主（计划第 5.6 节）。阶段 6 后 P3–P7 默认 builtin assembler/executor 经 `AppServices.mipsRuntime` 在生产路径运行于 Worker；激活阶段仍只构造 manager，首次任务才启动 Worker。direct lane 仅用于定向测试/无 runtime host，不是运行中 fallback。

- runtimeManager.ts — MipsRuntimeManager：激活时仅构造并注入 `AppServices.mipsRuntime`，首次非预取消任务才启动 Worker；dispose/crash/强制取消后按 generation 重建并忽略旧 Worker 事件
- workerProtocol.ts — protocol v2（request/cancel/progress/ack/result）；未知/多余/畸形字段 fail closed，progress sequence 单调且每批必须获 ACK
- workerClient.ts — WorkerClient：progress sequence 必须从 0 严格连续且前一批消费成功后才 ACK；consumer reject、重复/跳号/并发 progress、未 ACK 即 success terminal 均 fail closed 并取消请求。另含 AbortSignal 取消、单 terminal settle、宽限期强杀、监听器清理和 crash/generation 恢复
- workerJobs.ts — `isa-encode-batch` / `isa-decode-batch` 真实生产作业；最多 65,536 项、每 128 项 yield/检查取消并输出一批；阶段 4 增加 `machine-execute` / `device-cycle-vector`，与 JSONL CLI 共享同一有界 DTO 校验边界，machine-execute 每 slice 以 progress/ACK 回传 CommitEvent
- workerMain.ts — Worker 分派入口；每个请求最多一个未 ACK progress batch，取消会解除 ACK 等待并只产生一个 cancelled terminal result

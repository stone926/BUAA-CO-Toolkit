# mips-host | src/mips/host/ | 5 files

懒启动 Worker 宿主。P3–P7 默认 builtin assembler/executor 经 `AppServices.mipsRuntime` 在生产路径运行于 Worker；激活阶段只构造 manager，首次任务才启动 Worker。direct lane 仅用于定向测试/无 runtime host，**不是**运行中 fallback。

- `runtimeManager.ts` — MipsRuntimeManager：首次非预取消任务才启动 Worker；dispose/crash/强制取消后按 generation 重建并忽略旧 Worker 事件
- `workerProtocol.ts` — protocol v2（request/cancel/progress/ack/result）；未知/畸形字段 fail closed，progress sequence 单调且每批必须获 ACK
- `workerClient.ts` — WorkerClient：sequence 从 0 严格连续、消费成功后才 ACK；重复/跳号/并发 progress、未 ACK 即 success terminal 均 fail closed 并取消请求；含 AbortSignal、单 terminal settle、宽限期强杀与 crash 恢复
- `workerJobs.ts` — 生产作业 `isa-encode-batch` / `isa-decode-batch` / `machine-execute` / `device-cycle-vector`，与 JSONL CLI 共享同一有界 DTO 校验边界；按 slice 流式回传 CommitEvent
- `workerMain.ts` — Worker 分派入口；每个请求最多一个未 ACK progress batch，取消只产生一个 cancelled terminal result

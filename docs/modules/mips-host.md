# mips-host | src/mips/host/ | 4 files

懒启动 Worker 宿主骨架（计划第 5.6 节）。阶段 1 生产不接入（默认 provider 为 legacy 直接进程执行），骨架以单元测试覆盖。

- runtimeManager.ts — MipsRuntimeManager：激活时仅构造，首次任务才启动 Worker；dispose/crash 重建
- workerProtocol.ts — 版本化消息协议（request/cancel/progress/result，纯类型，worker 两侧共享）
- workerClient.ts — WorkerClient：消息往返、AbortSignal 取消、宽限期强杀、崩溃恢复
- workerMain.ts — Worker 入口：阶段 1 仅 ping/未知任务协议处理，真实 job 分派待 builtin 引擎

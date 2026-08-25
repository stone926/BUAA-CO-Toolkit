# mips-host | src/mips/host/ | 4 files

懒启动 Worker 宿主骨架（计划第 5.6 节）。阶段 1 生产不接入（默认 provider 为 legacy 直接进程执行），骨架以单元测试覆盖。

- runtimeManager.ts — MipsRuntimeManager：激活时仅构造，首次非预取消任务才启动 Worker；dispose/crash/强制取消后按 generation 重建并忽略旧 Worker 事件
- workerProtocol.ts — 严格版本化消息协议（request/cancel/progress/result，未知/多余/畸形字段 fail closed，worker 两侧共享）
- workerClient.ts — WorkerClient：消息往返、progress callback、AbortSignal 取消、单 terminal settle、宽限期强杀、监听器清理和崩溃恢复
- workerMain.ts — Worker 入口：阶段 1 仅 ping/未知任务协议处理；取消由 handler signal 协作并只返回一个 cancelled result，真实 assemble/execute job 待 builtin 引擎

# mips-host | src/mips/host/ | 12 files

懒启动 Worker 宿主。P2–P7 汇编与 P3–P7 课程执行经 `AppServices.mipsRuntime` 在生产路径运行于 Worker；普通 MARS 控制台执行也使用同一 Worker。激活阶段只构造 manager，首次任务才启动 Worker。direct lane 仅用于定向测试/无 runtime host，**不是**运行中 fallback。

- `runtimeManager.ts` — MipsRuntimeManager：首次非预取消任务才启动 Worker；dispose/crash/强制取消后按 generation 重建并忽略旧 Worker 事件
- `workerProtocol.ts` — protocol v2（request/cancel/progress/ack/result）；未知/畸形字段 fail closed，progress sequence 单调且每批必须获 ACK
- `workerClient.ts` — WorkerClient：sequence 从 0 严格连续、消费成功后才 ACK；重复/跳号/并发 progress、未 ACK 即 success terminal 均 fail closed 并取消请求；含 AbortSignal、单 terminal settle、宽限期强杀与 crash 恢复
- `workerJobs.ts` — 生产作业 `isa-encode-batch` / `isa-decode-batch` / `assembler-assemble` / `machine-execute` / `device-cycle-vector` / `mars-assemble` / `mars-execute`；与 JSONL CLI 共享有界 DTO 校验边界，按 slice 回传 CommitEvent 或 syscall progress
- `workerMain.ts` — Worker 分派入口；每个请求最多一个未 ACK progress batch，取消只产生一个 cancelled terminal result

## 普通 MARS

- `sourceInput.ts` — 与课程 provider 共用的有界 source/include 快照读取
- `marsService.ts` — 文件汇编到 ProgramImage、执行、取消/超时与输出上限编排
- `marsJobs.ts` — mars-execute 有界 DTO 与分片执行；P7 CPU 仍走 machine-execute
- `marsIo.ts` — 控制台、标准输入、文件、时钟的异步宿主适配，不把文件系统引入核心
- `marsTerminal.ts` — VS Code Pseudoterminal，行输入、回显、EOF、Ctrl+C 与关闭取消
- `debugClient.ts` — 复用 Worker progress/ACK 通道承载交互命令，并适配普通 MARS syscall 输入/输出
- `debugJob.ts` — 校验调试会话 DTO，在 Worker 中运行共享 DebugSession，暂停点及 slice 通过 progress 返回

`mars-assemble` 使用与课程相同的两遍汇编器；`mars-execute` 使用 MarsSession，并经 progress/ACK 的 response 返回系统调用结果。输入等待也可取消。P7 课程异常/中断 syscall 不经过普通 MARS I/O 服务。

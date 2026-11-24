# mips-host | src/mips/host/ | 27 files

懒启动 Worker 宿主。P2–P7 汇编与 P3–P7 课程执行经 `AppServices.mipsRuntime` 在生产路径运行于 Worker；普通 MARS 控制台执行也使用同一 Worker。激活阶段只构造 manager，首次任务才启动 Worker。direct lane 仅用于定向测试/无 runtime host，**不是**运行中 fallback。

- `runtimeManager.ts` — MipsRuntimeManager：首次非预取消任务才启动 Worker；dispose/crash/强制取消后按 generation 重建并忽略旧 Worker 事件
- `workerProtocol.ts` — protocol v2（request/cancel/progress/ack/result）；未知/畸形字段 fail closed，progress sequence 单调且每批必须获 ACK
- `workerClient.ts` — WorkerClient：sequence 从 0 严格连续、消费成功后才 ACK；重复/跳号/并发 progress、未 ACK 即 success terminal 均 fail closed 并取消请求；含 AbortSignal、单 terminal settle、宽限期强杀与 crash 恢复
- `workerJobs.ts` — 生产作业 `isa-encode-batch` / `isa-decode-batch` / `assembler-assemble` / `machine-execute` / `device-cycle-vector` / `mars-assemble` / `mars-execute`；与 JSONL CLI 共享有界 DTO 校验边界，按 slice 回传 CommitEvent 或 syscall progress
- `workerMain.ts` — Worker 分派入口；每个请求最多一个未 ACK progress batch，取消只产生一个 cancelled terminal result

## 普通 MARS

- `sourceInput.ts` — 与课程 provider 共用的有界 source/include 快照读取
- `customInstructionService.ts` / `customInstructionResource.ts` / `customInstructionFiles.ts` — 工作区指令发现、引擎选择、元数据检查及绑定执行的统一入口
- `customMarsArtifacts.ts` — 登记选定的 JAR、class 和桥接依赖，按次私有物化
- `customMarsBridge.ts` — 随包 Java bridge 的有界结构化协议、进程树取消、超时、输出限制和交互输入
- `customMarsConsole.ts` — 普通运行/导出的自定义指令适配；保留原 ASM 目录作为 syscall cwd，外部进程只读捕获的源闭包
- `marsService.ts` / `mipsWorkerRequests.ts` — 控制台汇编与执行、共享 Worker DTO、取消和超时。当前 Profile 的课程专用脚本指令用对应课程模式运行
- `marsJobs.ts` — mars-execute 有界 DTO 与分片执行；P7 CPU 仍走 machine-execute
- `marsIo.ts` — 控制台、标准输入、文件、时钟的异步宿主适配，不把文件系统引入核心
- `marsTerminal.ts` — VS Code Pseudoterminal，行输入、回显、EOF、Ctrl+C 与关闭取消
- `debugClient.ts` — 复用 Worker progress/ACK 通道承载交互命令，并适配普通 MARS syscall 输入/输出
- `debugJob.ts` — 校验调试会话 DTO，在 Worker 中运行共享 DebugSession，暂停点及 slice 通过 progress 返回
- `debugProtocol.ts` — 输入 syscall 挂起期间的内存/断点 ACK；重复快照复用同一次 IO，不重复提示、不推进指令

`mars-assemble` 使用与课程相同的两遍汇编器；`mars-execute` 使用 MarsSession，并经 progress/ACK 的 response 返回系统调用结果。输入等待也可取消。P7 课程异常/中断 syscall 不经过普通 MARS I/O 服务。

## JS/TS 自定义指令

- `scriptInstructionBundle.ts` — 源闭包、JS 产物、SDK/Node 版本与 canonical 内容指纹
- `scriptInstructionsCapture.ts` — 有界目录/静态 import 捕获、原生 TS 类型擦除与缓存
- `scriptInstructions.ts` — 无脚本快速路径、取消、只读检查缓存和绑定 runtime facade
- `scriptInstructionWorker.ts` — 独立顶层 Worker 入口，正确定位随包资源
- `scriptInstructionJobs.ts` — Worker 内 ESM/SDK 加载、元数据与共享核心作业分派
- `scriptInstructionDeterminism.ts` — 回调重复输入检查、访存读重放、效果分离与诊断
- `scriptGenerationJob.ts` — 有界随机/GPR 生成 DTO 与纯生成器调用

脚本作业与普通共享 Worker 分开；不捆绑 Node/tsc，不依赖私有 VS Code TypeScript。最低 VS Code 1.101，运行时校验原生 API。

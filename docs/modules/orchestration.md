# orchestration | src/ | ~53 files

扩展宿主层: 生命周期/命令注册/配置读取/Profile推断/UI/工具链/MIPS+Verilog+Logisim操作命令/用例存储
不含语言智能逻辑(在src/language/ LSP Server端)

entry:
  extension.ts — activate(): 注册全部命令/侧边栏/StatusBar/FileWatcher(.v/.vh/.asm/.circ)/工具链缓存, deactivate()停止LSP
  languageClient.ts — startLanguageServer(IPC模式，initializationOptions 传扩展安装根供 bundled runtime 定位), stopLanguageServer, executeLanguageServerCommand

config:
  constants.ts — 命令ID/Profile能力集合/输出目录名等扩展公共常量, Profile集合从courseConfig能力矩阵推导
  config.ts — 所有co.*设置读取(getProfile/getMipsEngine/getMarsJar/getIsePath/getRunTimeout...), 分层取值(WorkspaceFolder/Workspace/Global/Default), Python异步探测缓存, Profile持久化, 值域裁剪；显式 Profile 的 top/TB/机器码/时长默认直接来自 courseConfig，向导无需写冗余项目设置；`co.mips.engine` 无效值 fail-safe 为 auto
  resources/co/configManifest.json + configDefaults.json — 公开 schema 与内部运行默认解耦：日常 UI 精确 20 项，底层 legacy/策略键以无默认的 deprecated schema 仅对已有配置可见；项目/诊断使用 resource scope，工具路径使用 machine-overridable scope
  scripts/generate-manifest-config.mjs — 只向非 deprecated 公开项注入默认值，允许内部默认作为受测超集，并从课程资源生成 Profile/指令说明

build:
  scripts/clean-compile-output.mjs — 编译前安全清空固定 `out/`，避免已删除模块的陈旧 JS 被打入 VSIX
  configDefaults.ts — 从resources/co/configDefaults.json加载 co.* 默认值, 供扩展宿主/LSP/测试共享
  courseConfig.ts — Profile定义(P0-P7): 名称/描述/语言/目录/必需工具/端口/内存布局/P3 Logisim trace, 从resources/co/courseConfig.json加载缓存
  projectProfile.ts — ProjectProfile(auto|P0-P7), ConcreteProjectProfile, isConcreteProjectProfile
  profileInference.ts — buildProfileInferenceInput: 从文件列表+模块注册表收集端口/扩展名/display格式
  profileResolver.ts — 推断核心: 端口签名(P6外部存储器/P7中断外设), display格式(P4 vs P5时间戳), P7结构(CP0+Bridge+Timer), 文件类型分布, 四级置信度(explicit/strong/weak/none)

toolchain:
  toolchain.ts + toolchainPolicy.ts — checkToolchain 与 UI 使用 mode-aware effective dependency：P1/P4–P7 的逻辑 `verilogSimulator` 固定预检扩展内置 Icarus，不受已配置 `isePath` 影响；P3 保留 Logisim/Java；mars/verify-both 再添加 profile 对应 MARS/Java。configured legacy 检查覆盖 v0.6.3 的 coL1/coL2、Compact 初态/配置及 P7 efc/p7irq；verify-both 另要求 v0.6.3-course1 `legacy-course-executor` 精确 bytes/SHA-256，不能与 assembly compatibility 角色混用
  iseCommon.ts — buildIseEnvironment, findFuse, findIsimGui, isimExecutableName
  python.ts — pythonCandidates(win32:python/py/python3, other:python3/python), firstWorkingCommand, commandResponds

process:
  process.ts — runTool(同步等待,stdout/stderr流式写入OutputChannel,透传 stopped/stopReason), launchTool(GUI分离启动,spawn延迟判定,unref), commandLine, quoteArg
  processCore.ts — 无VS Code依赖的spawn/stdout/stderr/逐行监控核心：timeout/AbortSignal 幂等 settle，raw-byte stdout/stderr ceiling（跨 UTF-8 chunk 用 StringDecoder），Windows taskkill /t 与 Unix process group执行 grace→force 整树终止；供扩展宿主和LSP复用
  startupTrace.ts — CO_TRACE_STARTUP/BUAA_CO_TRACE_STARTUP 启动耗时追踪 helper
  textChunks.ts — TextChunkAccumulator(零拷贝chunk收集), LineChunkScanner(流式逐行CRLF兼容)

fs:
  fsUtil.ts — workspaceFolderFor/workspaceFolderForOrFirst/dirname/basenameNoExt/readTextFile/writeTextFile(VSCode API)/coTmpDir(.co/tmp/)/cleanupCoTmp
  nodeFs.ts — pathExists/isFile/isDirectory/fileMtimeMs/yieldEventLoop
  pathUtils.ts — normalizePathKey/samePath/dedupePaths/dedupeUris/sanitizeFileStem 纯路径工具

mips-commands:
  mipsCommands.ts — registerMipsAssemblyCommands() 与机器码导出命令分派；P3–P7 普通 text/P7 kernel dump 强制使用 builtin assembler，P2 dump 保留 MARS provider，不做 capability fallback
  mips.ts — legacy MARS runner 与普通运行/capture/stdin/terminal 命令；这些 console/交互语义仍明确依赖 MARS
  mips.ts — legacy runMarsFile(run/dumpText/dumpKernel)：使用 provider preflight 的 immutable launch；流式捕获/授权 MARS JAR 与 RI class 后仅执行本次运行的私有 registry staged artifact；stdout/stderr 各有 16 MiB raw ceiling，data/text/kernel dump 有界读取；课程 Trace 源码/动态停机尾、P7 0x4180 合并、原生 max-step 与共享稳定版兼容诊断(coL1/coL2/efc/p7irq/cl)

verilog-commands:
  verilog.ts — Verilog 命令入口：generateTestbench、默认 Icarus 仿真/外部语法检查、ISE 工程文件生成、ISim 波形/VCD handler gate、lint禁用和 registerVerilog()；兼容保留既有 command ID
  verilog/documentContext.ts — VS Code 文档到 Verilog LSP TextDocument/CoSettings 的适配
  verilog/iseProject.ts — ISE PRJ/TCL生成、Verilog文件收集（排除 `.co`、`.vscode`、`.vscode-test` 等非 DUT 目录）、顺序敏感的项目签名；工作区唯一 `.xise` 存在时按 FILE_VERILOG 的 BehavioralSimulation seqID 编译，未列入的普通 `.v` 稳定排序后前置，运行时生成源固定置尾；无唯一/可读 XISE 时确定性排序
  verilog/iseProjectOrder.ts — 纯函数解析 XISE FILE_VERILOG 路径和 BehavioralSimulation seqID（全部有效且唯一时升序，否则稳定回退文档顺序），并组合普通/XISE/运行时源顺序，处理相对路径、XML 实体、去重和跨平台路径
  verilog/verilogBackend.ts — 显式两值偏好解析；省略偏好固定 bundled Icarus，仅显式 `isim` 请求进入 ISim，工具路径存在性不再参与选择
  verilog/iverilogRuntime.ts — 固定定位 `vendor/iverilog/win32-x64`，为子进程前置 bundled bin，校验 exe/lib 并会话级执行 `iverilog -V`；六个原生 EXE 通过可复现的 manifest-only 补丁启用 UTF-8 process code page，兼容系统 ANSI code page 无法表示的中文路径；统一生成 source-relative、各源码目录和 workspace root 的 include 参数
  verilog/iverilogDiagnostics.ts — 纯 Icarus `path:line[:column]` stderr 解析，供 LSP syntax diagnostics 与运行失败归因共同复用
  verilog/iseDiagnostics.ts — 纯 ISE fuse error/warning/info 解析，保留可操作的文件、行号和消息，供 LSP 与仿真失败报告共同复用
  verilog/simulationDiagnostic.ts — Icarus/ISim 失败结构化为 phase/reason/exit/首条诊断；公开报告边界统一做工作区相对路径、外部路径 basename、ANSI/控制符清理和限长
  verilog/iverilogRunner.ts — Icarus `-g2005 -t vvp` 编译 + `vvp -N`，复用源文件顺序/testbench/`code.txt`，用独立 watchdog top 结束永久时钟；同工作区按 operation 可取消串行，保护共享 TB/input/vvp 产物；编译/VVP stdout/stderr 分阶段设置 byte cap，失败为 case 保存有界私有原始 log，交互命令直接显示首条可定位诊断
  verilog/workspaceOperationQueue.ts — 以规范化 workspace path 为键的轻量 Promise 队列；等待者取消会释放自身 turn，不中断前序也不阻塞后续仿真
  verilog/simulationRunner.ts — 无 language-client 命令胶水依赖、可供 headless 复用的通用 Verilog 仿真分派器、共享增量模块注册表与带 backend 的最小公共结果；通用命令/课程流水线固定 Icarus，只有显式 backend 请求才进入 ISim；统一识别 Icarus compile、ISim fuse、simulate/output terminal failure，显式 ISim 失败不启动 Icarus
  verilog/isimRunner.ts — ISim compile/run 核心: ASM case准备、testbench解析/生成、fuse缓存、run tcl、sim输出落盘；fuse/仿真分阶段设置 byte cap，run 入口在 fuse 失败时保留 generated/fuseResult，自动报告与手动错误均显示脱敏首条诊断而不误报为准备失败
  verilog/simulationAsmCase.ts — P4–P7 ASM case 选择与 provider-neutral 机器码准备；默认内置汇编器，不把失败误报为 MARS 问题
  verilog/simulationInputs.ts — Icarus/ISim 运行前机器码源定位与复制；保留配置文件名并同步生成课程 TB 固定读取的 `code.txt` alias
  verilog/testbenchResolver.ts — Verilog testbench 发现、生成、P7 auto/probe testbench 和 ASM case 记录；发现顶层/testbench 时复用 ISE 源文件排除规则，不把 `.vscode`/`.vscode-test` 内编辑器副本误判为重复模块
  verilogSignalView.ts — 信号连线面板(coVerilogSignal视图): 光标处信号声明/驱动/读取, 跨模块导航
  verilogIsimCache.ts — IsimCompileCache接口+isimCompileCacheKey(workspaceRoot+isePath+moduleName+testbench签名+projectSignature+tclText+debug)
  verilogIsimOutput.ts — simulationOutputDirectory(.co/out/), isimOutputFileName, 兼容 re-export 路径 helper
  verilogSimulationFiles.ts — 按调用方顺序渲染 ISE 项目文本/ISim TCL(从resources/templates/isim渲染)；运行时 testbench(含P7 auto/probe)开头恢复 `` `default_nettype wire ``，避免前一编译单元泄漏；isGeneratedRuntimeTestbench
  verilogWaveform.ts — openIsimWaveform(ISim GUI+wave add -r /), exportVcdWaveform(TCL批处理VCD)

logisim-commands:
  logisim.ts — registerLogisim()4命令: 打开电路(GUI), 生成ROM, 注入ROM(修改.circ XML), 日志转CSV

trace-compare:
  traceCompare.ts — compareTracePair调用核心引擎(language/mips/traceCompare.ts), HTML diff报告, registerTraceCompare()2命令

hazard:
  hazard.ts — runHazardAnalysis: ZIP用例->Hazard-Calculator.jar->解析statistic.json->展示forward/stall覆盖率. registerHazard()2命令

ui:
  sidebar.ts — CoSidebarProvider TreeView: buildTree()->buildSidebarModel()->TreeItem
  sidebarModel.ts — 纯函数数据模型: 项目信息/上下文/操作三段，根据Profile+活跃文件+工具链状态构建；Verilog 常规上下文只强调当前文件与后端，避免把手动 Top/TB/时长误解成自动测试输入；操作区只提供“启动持续测试”这一测试启动入口
  wizard.ts + wizardSettings.ts — 4步向导: 选Profile->项目名->配置必需外部工具(可选)->创建目录+模板；Verilog Profile 使用 bundled Icarus，不再询问 ISE；纯写入计划只把 Profile 写入对应 WorkspaceFolder，实际询问到的机器路径写 Global，不再把绝对路径或 Profile 派生默认写进项目
  configurationResource.ts — 诊断快速修复携带来源文档 URI，在多根工作区内精确选择配置资源；仅命令面板直调时回退活动编辑器
  diagnosticSettings.ts — MIPS 伪指令与 Verilog lint 快速修复的配置读改写；与命令注册解耦并统一使用来源资源作用域
  advancedTools.ts — registerAdvancedTools(): 按Profile过滤非测试低频工具，不重复提供测试入口
  advancedToolModel.ts — 非测试工具分组/标签/描述模型，按 Profile 与当前文件类型过滤低频工具
  webview/reportLayout.ts — 报告 Webview 共享页面 shell/CSS(从resources/templates/webview渲染)、metric、table 和转义 helper
  templates/templateRegistry.ts — resources/templates 受控占位替换加载器, 用于生成可审计模板产物

other:
  legacySemanticColorMigration.ts — 一次性清理旧版本曾注入且用户未修改的全局 semantic token 规则；迁移后不再触碰颜色配置
  workflowInputs.ts — resolveWorkspaceFile(s)、resolveMachineCodeInput(智能查找code.txt), resolveActiveOrPickedTextFile, pickOneFile
  types.ts — AppServices(OutputChannel+StatusBarItem+扩展安装根+可选 MIPS Worker), RunResult, ToolDetection

# orchestration | src/ | ~47 files

扩展宿主层: 生命周期/命令注册/配置读取/Profile推断/UI/工具链/MIPS+Verilog+Logisim操作命令/用例存储
不含语言智能逻辑(在src/language/ LSP Server端)

entry:
  extension.ts — activate(): 注册全部命令/侧边栏/StatusBar/FileWatcher(.v/.vh/.asm/.circ)/工具链缓存, deactivate()停止LSP
  languageClient.ts — startLanguageServer(IPC模式), stopLanguageServer, executeLanguageServerCommand

config:
  constants.ts — 命令ID/Profile能力集合/输出目录名等扩展公共常量, Profile集合从courseConfig能力矩阵推导
  config.ts — 所有co.*设置读取(getProfile/getMipsEngine/getMarsJar/getIsePath/getRunTimeout...), 分层取值(Workspace/WorkspaceFolder/Global/Default), Python异步探测缓存, Profile持久化, 值域裁剪；`co.mips.engine` 无效值 fail-safe 为 auto

build:
  scripts/clean-compile-output.mjs — 编译前安全清空固定 `out/`，避免已删除模块的陈旧 JS 被打入 VSIX
  configDefaults.ts — 从resources/co/configDefaults.json加载 co.* 默认值, 供扩展宿主/LSP/测试共享
  courseConfig.ts — Profile定义(P0-P7): 名称/描述/语言/目录/必需工具/端口/内存布局/P3 Logisim trace, 从resources/co/courseConfig.json加载缓存
  projectProfile.ts — ProjectProfile(auto|P0-P7), ConcreteProjectProfile, isConcreteProjectProfile
  profileInference.ts — buildProfileInferenceInput: 从文件列表+模块注册表收集端口/扩展名/display格式
  profileResolver.ts — 推断核心: 端口签名(P6外部存储器/P7中断外设), display格式(P4 vs P5时间戳), P7结构(CP0+Bridge+Timer), 文件类型分布, 四级置信度(explicit/strong/weak/none)

toolchain:
  toolchain.ts + toolchainPolicy.ts — checkToolchain 与 UI 使用 mode-aware effective dependency：P4–P7 auto/builtin 只保留 ISE，P3 保留 Logisim/Java；mars/verify-both 再添加 profile 对应 MARS/Java。configured legacy 检查覆盖 v0.6.3 的 coL1/coL2、Compact 初态/配置及 P7 efc/p7irq；verify-both 另要求 v0.6.3-course1 `legacy-course-executor` 精确 bytes/SHA-256，不能与 assembly compatibility 角色混用
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
  mips.ts — runMarsFile(run/dumpText/dumpKernel): 使用 provider preflight 的 immutable launch；流式捕获/授权 MARS JAR 与 RI class 后仅执行本次运行的私有 registry staged artifact；stdout/stderr 各有 16 MiB raw ceiling，data/text/kernel dump 有界读取；课程 Trace 源码/动态停机尾、P7 0x4180 合并、原生 max-step 与共享稳定版兼容诊断(coL1/coL2/efc/p7irq/cl). registerMips()注册6个命令

verilog-commands:
  verilog.ts — Verilog 命令入口: generateTestbench、generateIseProject、runIsim/compileIsim wrapper、lint禁用和 registerVerilog()注册7个命令
  verilog/documentContext.ts — VS Code 文档到 Verilog LSP TextDocument/CoSettings 的适配
  verilog/iseProject.ts — ISE PRJ/TCL生成、Verilog文件收集（排除 `.co`、`.vscode`、`.vscode-test` 等非 DUT 目录）、顺序敏感的项目签名；工作区唯一 `.xise` 存在时按 FILE_VERILOG 的 BehavioralSimulation seqID 编译，未列入的普通 `.v` 稳定排序后前置，运行时生成源固定置尾；无唯一/可读 XISE 时确定性排序
  verilog/iseProjectOrder.ts — 纯函数解析 XISE FILE_VERILOG 路径和 BehavioralSimulation seqID（全部有效且唯一时升序，否则稳定回退文档顺序），并组合普通/XISE/运行时源顺序，处理相对路径、XML 实体、去重和跨平台路径
  verilog/isimRunner.ts — ISim compile/run 核心: ASM case准备、testbench解析/生成、fuse缓存、run tcl、sim输出落盘
  verilog/simulationInputs.ts — ISim 运行前机器码源定位与复制
  verilog/testbenchResolver.ts — ISim testbench 发现、生成、P7 auto/probe testbench 和 ASM case 记录；发现顶层/testbench 时复用 ISE 源文件排除规则，不把 `.vscode`/`.vscode-test` 内编辑器副本误判为重复模块
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
  sidebarModel.ts — 纯函数数据模型: 项目信息/上下文/操作三段，根据Profile+活跃文件+工具链状态构建；操作区只提供“启动持续测试”这一测试启动入口，另有停止与历史入口，不再包含“资料”段
  wizard.ts — 4步向导: 选Profile->项目名->配置工具链(可选)->创建目录+模板(.v/.asm+testbench)
  advancedTools.ts — registerAdvancedTools(): 按Profile过滤非测试低频工具，不重复提供测试入口
  advancedToolModel.ts — 非测试工具分组/标签/描述模型，按 Profile 与当前文件类型过滤低频工具
  webview/reportLayout.ts — 报告 Webview 共享页面 shell/CSS(从resources/templates/webview渲染)、metric、table 和转义 helper
  templates/templateRegistry.ts — resources/templates 受控占位替换加载器, 用于生成可审计模板产物

other:
  legacySemanticColorMigration.ts — 一次性清理旧版本曾注入且用户未修改的全局 semantic token 规则；迁移后不再触碰颜色配置
  workflowInputs.ts — resolveWorkspaceFile(s)、resolveMachineCodeInput(智能查找code.txt), resolveActiveOrPickedTextFile, pickOneFile
  types.ts — AppServices(OutputChannel+StatusBarItem), RunResult, ToolDetection

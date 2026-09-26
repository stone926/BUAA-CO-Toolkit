# orchestration | src/ | ~54 files

扩展宿主层: 生命周期/命令注册/配置读取/Profile推断/UI/工具链/MIPS+Verilog+Logisim操作命令/用例存储
不含语言智能逻辑(在src/language/ LSP Server端)

entry:
  extension.ts — activate(): 注册全部命令/侧边栏/StatusBar/FileWatcher(.v/.vh/.asm/.circ)/工具链缓存；属于源文件发现基线的 Verilog create/change/delete 会失效所有包含该路径的嵌套 workspace 缓存，folder add/remove 保守清空 session 基线，忽略 `.co` 生成 TB 等排除目录事件, deactivate()停止LSP
  languageClient.ts — startLanguageServer(IPC模式，initializationOptions 传扩展安装根供 bundled runtime 定位), stopLanguageServer, executeLanguageServerCommand；统一同步 co 配置，避免无关编辑器设置变化取消 LSP 保存语法检查

config:
  constants.ts — 命令ID/Profile能力集合/输出目录名等扩展公共常量, Profile集合从courseConfig能力矩阵推导
  config.ts — 所有co.*设置读取(getProfile/getMipsEngine/getMarsJar/getRunTimeout...), 分层取值(WorkspaceFolder/Workspace/Global/Default), Python异步探测缓存, Profile持久化, 值域裁剪；显式 Profile 的 top/TB/机器码/时长默认直接来自 courseConfig，向导无需写冗余项目设置；`co.mips.engine` 无效值 fail-safe 为 auto
  resources/co/configManifest.json + configDefaults.json — 公开 schema 与内部运行默认解耦：日常 UI 精确 19 项，底层 legacy/策略键以无默认的 deprecated schema 仅对已有配置可见；项目/诊断使用 resource scope，工具路径使用 machine-overridable scope
  scripts/generate-manifest-config.mjs — 只向非 deprecated 公开项注入默认值，允许内部默认作为受测超集，并从课程资源生成 Profile/指令说明

build:
  scripts/clean-compile-output.mjs — 编译前安全清空固定 `out/`，避免已删除模块的陈旧 JS 被打入 VSIX
  configDefaults.ts — 从resources/co/configDefaults.json加载 co.* 默认值, 供扩展宿主/LSP/测试共享
  courseConfig.ts — Profile定义(P0-P7): 名称/描述/语言/目录/必需工具/端口/内存布局/P3 Logisim trace, 从resources/co/courseConfig.json加载缓存
  projectProfile.ts — ProjectProfile(auto|P0-P7), ConcreteProjectProfile, isConcreteProjectProfile
  profileInference.ts — buildProfileInferenceInput: 从文件列表+模块注册表收集端口/扩展名/display格式
  profileResolver.ts — 推断核心: 端口签名(P6外部存储器/P7中断外设), display格式(P4 vs P5时间戳), P7结构(CP0+Bridge+Timer), 文件类型分布, 四级置信度(explicit/strong/weak/none)

toolchain:
  toolchain.ts + toolchainPolicy.ts — checkToolchain 与 UI 使用 mode-aware effective dependency：P1/P4–P7 的逻辑 `verilogSimulator` 固定预检扩展内置 Icarus；P3 保留 Logisim/Java；mars/verify-both 再添加 profile 对应 MARS/Java。configured legacy 检查覆盖 v0.6.3 的 coL1/coL2、Compact 初态/配置及 P7 efc/p7irq；verify-both 另要求 v0.6.3-course1 `legacy-course-executor` 精确 bytes/SHA-256，不能与 assembly compatibility 角色混用
  python.ts — pythonCandidates(win32:python/py/python3, other:python3/python), firstWorkingCommand, commandResponds

process:
  process.ts — runTool(同步等待,stdout/stderr流式写入OutputChannel,透传 stopped/stopReason), launchTool(GUI分离启动,spawn延迟判定,unref), commandLine, quoteArg
  processCore.ts — 无VS Code依赖的spawn/stdout/stderr/逐行监控核心：timeout/AbortSignal 幂等 settle，raw-byte stdout/stderr ceiling（跨 UTF-8 chunk 用 StringDecoder），Windows taskkill /t 与 Unix process group执行 grace→force 整树终止；供扩展宿主和LSP复用
  startupTrace.ts — CO_TRACE_STARTUP/BUAA_CO_TRACE_STARTUP 启动耗时追踪 helper
  textChunks.ts — TextChunkAccumulator(零拷贝chunk收集), LineChunkScanner(流式逐行CRLF兼容)

fs:
  fsUtil.ts — workspaceFolderFor/workspaceFolderForOrFirst/dirname/basenameNoExt/readTextFile/writeTextFile(VSCode API)/writeTextFileIfAbsent(本地文件独占创建，已存在即不写)/coTmpDir(.co/tmp/)/cleanupCoTmp
  nodeFs.ts — pathExists/isFile/isDirectory/fileMtimeMs/yieldEventLoop
  pathUtils.ts — normalizePathKey/samePath/dedupePaths/dedupeUris/sanitizeFileStem 纯路径工具

mips-commands:
  mipsCommands.ts — registerMipsAssemblyCommands() 与机器码导出命令分派；P3–P7 普通 text/P7 kernel dump 强制使用 builtin assembler，P2 dump 保留 MARS provider，不做 capability fallback
  mips.ts — legacy MARS runner 与普通运行/capture/stdin/terminal 命令；这些 console/交互语义仍明确依赖 MARS
  mips.ts — legacy runMarsFile(run/dumpText/dumpKernel)：使用 provider preflight 的 immutable launch；流式捕获/授权 MARS JAR 与 RI class 后仅执行本次运行的私有 registry staged artifact；stdout/stderr 各有 16 MiB raw ceiling，data/text/kernel dump 有界读取；课程 Trace 源码/动态停机尾、P7 0x4180 合并、原生 max-step 与共享稳定版兼容诊断(coL1/coL2/efc/p7irq/cl)

verilog-commands:
  verilog.ts — Verilog 命令入口：用户 TB 统一生成到 `.co/tb/<tb>.v`，已有 TB 直接打开；Icarus 仿真、外部语法检查和 lint 禁用。命令为 co.verilog.runSimulation / co.verilog.checkSyntax；波形使用 co.verilog.viewWaveform。
  verilog/documentContext.ts — VS Code 文档到 Verilog LSP TextDocument/CoSettings 的适配；verilogDocumentForUri 优先取活动编辑器未保存文本
  verilog/verilogProject.ts — Verilog 源文件收集与确定性排序，排除 `.co`、`.vscode`、`.vscode-test`；按工作区缓存发现基线，合并并发首次查询，按文件事件失效，运行时附加源置尾。自动测试排除用户 TB。
  verilog/verilogProjectOrder.ts — 纯函数稳定排序、路径去重、运行时附加源置尾。
  verilog/iverilogRuntime.ts — 以纯 platform/arch 映射选择 `vendor/iverilog/win32-x64|darwin-arm64|darwin-x64|linux-x64|linux-arm64` 及对应 executable 名，为子进程前置 bundled bin 并清除可重定向 compiler config 的 `IVERILOG_ICONFIG`（保留 VVP dumper/VPI 运行时控制），校验 exe/lib 并会话级执行 `iverilog -V`；所有 macOS / Linux `iverilog` argv 都通过共享 helper 前置 `-B <runtime>/lib/ivl`，覆盖构建时 prefix，不设置私有 `DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH`；Windows 六个原生 EXE 继续通过可复现的 manifest-only 补丁启用 UTF-8 process code page，兼容系统 ANSI code page 无法表示的中文路径；统一生成 source-relative、各源码目录和 workspace root 的 include 参数
  verilog/iverilogDiagnostics.ts — 纯 Icarus `path:line[:column]` stderr 解析，供 LSP syntax diagnostics 与运行失败归因共同复用
  verilog/simulationDiagnostic.ts — Icarus 失败结构化为 phase/reason/exit/首条诊断；公开报告边界统一做工作区相对路径、外部路径 basename、ANSI/控制符清理和限长
  verilog/iverilogRunner.ts — Icarus `-g2005 -t vvp` 编译 + bundled `vvp -N`，macOS / Linux compile argv 复用 runtime helper 注入 `-B <runtime>/lib/ivl`，不直接执行带构建时 shebang 的 `.vvp`；复用源文件顺序/testbench/`code.txt`；生成的用户 CPU TB 可选 ASM，其他手动 TB 不询问 ASM，自动用例显式传入机器码，用 workspace-hash 命名的稳定 watchdog top + VVP plusarg 结束永久时钟；同工作区按 operation 可取消串行，保护共享 TB/input/vvp 产物；自动 case 的指定 sim.out 直接由已持有 stdout 一次写入并登记 artifact，不再落盘后重读复制；编译/VVP stdout/stderr 分阶段设置 byte cap，失败为 case 保存有界私有原始 log，交互命令直接显示首条可定位诊断
  verilog/iverilogCompileCache.ts — session 内按 workspace 保存单条 content-verified Icarus 编译缓存（全局 8-workspace LRU）；key 固定 runtime/version/完整 argv/有序直接源 SHA，`-Mall` 依赖闭包与 VVP artifact 每次命中按内容复验；取消中的 lookup 不驱逐原有效项，调用方 acceptCompileResult 拒绝的编译不发布（缓存不保留编译告警），磁盘只复用固定 vvp/depfile，不按 case 增长
  verilog/iverilogCompileCacheIo.ts — 编译缓存专用的可取消、有界同句柄读取与 SHA/节点身份指纹；Windows case-fold 路径碰撞 fail-open，受限并发 hash
  verilog/iverilogIncludeResolution.ts — literal `include` 纯解析、source-relative/cwd/`-I` 搜索顺序与 shadow 负依赖验证；动态 include、边界超限或不可验证状态 fail-open
  verilog/workspaceOperationQueue.ts — 以规范化 workspace path 为键的轻量 Promise 队列；等待者取消会释放自身 turn，不中断前序也不阻塞后续仿真
  verilog/simulationRunner.ts — 通用 Verilog 仿真入口，固定使用 bundled Icarus；共享增量模块注册表，统一编译、仿真和输出失败结果。
  verilog/simulationInputs.ts — Icarus 运行前机器码源定位与复制；保留配置文件名并同步生成课程 TB 固定读取的 `code.txt` alias
  verilog/testbenchResolver.ts — 三种 TB 来源：自动测试使用 `.co/iverilog` 私有课程 TB；所有用户模板生成到 `.co/tb`，手工编写激励；自建 `_tb.v` / `_testbench.v` 按文件名识别。手动运行优先活动 TB，缺失时生成并打开模板后停止，所有阶段均不回退私有 TB。自动 TB 字节与 case 元数据一并记录。
  verilog/userCpuProgram.ts — `.co/tb` CPU 标记识别后提供选择 ASM/空程序；复用内置汇编器与课程镜像投影、停机尾及 P7 内核地址映射；每次完整初始化机器码，失败或取消停止仿真，波形重试在单次操作内复用输入字节。
  verilog/userCpuTestbench.ts — P4–P7 已配置 CPU top 的 `.co/tb` 模板复用课程时钟/复位/存储器接线，插入稳定 CPU 标记供手动仿真时可选 ASM；其他模块继续使用通用激励模板。
  verilog/userTestbench.ts — `.co/tb` 用户 testbench：`<workspace>/.co/tb/<tb>.v` 路径约定、按模块名精确解析、只创建不覆盖；目录被工程发现、模块注册表与自动测试排除
  verilogSignalView.ts — 信号连线面板(coVerilogSignal视图): 光标处信号声明/驱动/读取, 跨模块导航
  verilogSimulationOutput.ts — simulationOutputDirectory(.co/out/)、simulationOutputFileName 和路径 helper。
  verilogSimulationFiles.ts — 用户 TB 路径和自定义文件名识别约定、运行时 TB 标记；私有 TB 开头恢复 `` `default_nettype wire `` 防止前一编译单元泄漏。

logisim-commands:
  logisim.ts — registerLogisim()4命令: 打开电路(GUI), 生成ROM, 注入ROM(修改.circ XML), 日志转CSV

trace-compare:
  traceCompare.ts — compareTracePair调用核心引擎(language/mips/traceCompare.ts), HTML diff报告, registerTraceCompare()2命令

hazard:
  hazard.ts — runHazardAnalysis: ZIP用例->Hazard-Calculator.jar->解析statistic.json->展示forward/stall覆盖率. registerHazard()2命令

ui:
  sidebar.ts — CoSidebarProvider TreeView: buildTree()->buildSidebarModel()->TreeItem
  sidebarModel.ts — 纯函数数据模型: 项目信息/上下文/操作三段，根据Profile+活跃文件+工具链状态构建；Verilog 文件提供“运行仿真/仿真并查看波形/信号连线”；Verilog 常规上下文只强调当前文件与后端，避免把手动 Top/TB/时长误解成自动测试输入；操作区只提供“启动持续测试”这一测试启动入口
  wizard.ts + wizardSettings.ts — 4步向导: 选Profile->项目名->配置必需外部工具(可选)->创建目录+模板；Verilog Profile 使用 bundled Icarus；纯写入计划只把 Profile 写入对应 WorkspaceFolder，实际询问到的机器路径写 Global，不再把绝对路径或 Profile 派生默认写进项目
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

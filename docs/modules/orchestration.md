# orchestration | src/ | 59 files

扩展宿主层：生命周期、命令注册、配置读取、Profile 推断、UI、工具链、MIPS/Verilog/Logisim 操作命令与用例存储。**不含**语言智能逻辑（在 `src/language/` 的 LSP Server 端）。这一层只做 VS Code glue，业务逻辑必须落在下面的领域模块里。

## 入口

- `extension.ts` — `activate()`：注册全部命令/侧边栏/StatusBar/FileWatcher/工具链缓存；属于源文件发现基线的 Verilog 事件会失效所有包含该路径的嵌套 workspace 缓存，folder 增删保守清空基线并忽略 `.co` 生成物；`deactivate()` 停 LSP
- `languageClient.ts` — 文档选择器命中 MIPS、Verilog 或 `.circ` 文档时按需启动 IPC LSP；LSP 命令也可触发启动。`initializationOptions` 传扩展安装根供 bundled runtime 定位；启动 Promise 去重，停用等待启动完成

## 配置与 Profile

- `constants.ts` — 命令 ID、Profile 能力集合、输出目录名（`.co/*`）等公共常量
- `config.ts` — `co.*` 设置读取（分层取值 + Profile 持久化 + 值域裁剪）；显式 Profile 的默认项直接来自 courseConfig，向导无需写冗余设置
- `configDefaults.ts` — 从 `resources/co/configDefaults.json` 加载默认值，宿主/LSP/测试共享
- `resourcePaths.ts` — 宿主、LSP 与独立辅助入口共享扩展根与静态资源定位；Worker 管理器据此定位 Worker 入口
- `courseConfig.ts` — Profile 定义（P0–P7）：名称/描述/能力矩阵/语言/目录/端口/内存布局，从 `resources/co/courseConfig.json` 加载缓存
- `projectProfile.ts` / `generated/projectProfiles.ts` — 生成物（勿手改）与稳定导出入口，并校验 ISA profilePolicies 一致性
- `profileInference.ts` / `profileResolver.ts` — Profile 推断：端口签名、display 格式、文件类型分布与四级置信度
- `extension.ts` 的文件监听仅在文件增删或配置变化时清理 Profile 文件列表；普通内容变更仍失效工具链状态并更新工程视图

## 工具链与进程

- `toolchain.ts` / `toolchainPolicy.ts` — 课程有效依赖：Verilog Profile 预检内置 Icarus，P3 保留 Logisim/Java；旧引擎设置不追加 MARS。可选原版 MARS 检查标准汇编、HexText 与 syscall 执行，不探测魔改功能
- `process.ts` / `processCore.ts` — spawn/stdout/stderr 核心：幂等 settle、raw-byte ceiling、跨 UTF-8 chunk 解码、Windows taskkill /t 与 Unix process group 整树终止
- `startupTrace.ts` — `CO_TRACE_STARTUP` 启动耗时追踪
- `textChunks.ts` — 零拷贝 chunk 收集与流式逐行扫描

## 文件系统

- `fsUtil.ts` — workspace 定位、读写、`writeTextFileIfAbsent`、`.co/tmp` 管理
- `nodeFs.ts` — 存在性/类型/mtime 与事件循环让出
- `pathUtils.ts` — 规范化路径键、去重、文件名净化

## Verilog / Icarus 运行时

- `verilog.ts` — Verilog 命令入口；用户 TB 统一生成到 `.co/tb`（只创建不覆盖）
- `verilog/iverilogRuntime.ts` — 纯 platform/arch 映射到 `vendor/iverilog/<target>`；为子进程前置 bundled bin 与 `-B <lib/ivl>`，清除可重定向 compiler config 的 `IVERILOG_ICONFIG`；Windows 走 manifest-only UTF-8 补丁以兼容中文路径
- `verilog/iverilogRunner.ts` — `-g2005 -t vvp` 编译 + bundled `vvp -N`；复用源顺序/TB/`code.txt`，按 operation 串行并支持取消
- `verilog/iverilogCompileCache.ts` / `verilog/iverilogCompileCacheIo.ts` — session 内按 workspace 的单条 content-verified 编译缓存（全局 8-workspace LRU），依赖闭包与 VVP 产物每次命中按内容复验
- `verilog/iverilogIncludeResolution.ts` — literal `include` 纯解析与 shadow 负依赖验证，不可验证时 fail-open
- `verilog/iverilogDiagnostics.ts` / `verilog/simulationDiagnostic.ts` — stderr 解析与结构化失败报告（工作区相对路径、脱敏、限长）
- `verilog/simulationRunner.ts` — 通用仿真入口，固定使用 bundled Icarus
- `verilog/simulationInputs.ts` — 机器码源定位、复制与 `code.txt` alias
- `verilog/testbenchResolver.ts` — 三种 TB 来源（私有课程 TB / `.co/tb` 模板 / 自建 `*_tb.v`、`*_testbench.v`、`tb.v` 或 `testbench.v`），各阶段都不回退私有 TB
- `verilog/userCpuProgram.ts` / `verilog/userCpuTestbench.ts` / `verilog/userTestbench.ts` — 用户 CPU 仿真的 ASM 选择、模板与目录约定
- `verilog/verilogProject.ts` / `verilog/verilogProjectOrder.ts` — 源发现、确定性排序与按事件失效的缓存
- `verilog/workspaceOperationQueue.ts` — 按 workspace 串行的轻量 Promise 队列
- `verilog/documentContext.ts` — VS Code 文档到 LSP `TextDocument` 的适配
- `verilogSignalView.ts` — 信号连线面板（`coVerilogSignal` 视图）
- `verilogSimulationFiles.ts` / `verilogSimulationOutput.ts` — TB 路径与 trace 输出目录/命名约定（`.co/out`）

## 其他命令域

- `mipsCommands.ts` — 汇编与机器码导出命令分派；P3–P7 强制 builtin assembler，不做 capability fallback
- `mips.ts` — 原版 MARS runner（P2 汇编；普通 run/stdin/terminal 不受 Profile 限制，也不要求选择 Profile）；终端同样预检，dump 私有暂存并验证后落盘；stdout/stderr 各有 16 MiB raw ceiling；旧超时 0 回退默认预算
- `mipsTerminal.ts` — 显式 PowerShell/sh 终端参数引用；Java、ASM 的空格/中文路径作为字面参数传递
- `logisim.ts` — 打开电路、生成 ROM、注入 ROM、日志转 CSV
- `hazard.ts` — 注册分析/打开报告命令，首次调用惰性加载内置引擎（详见 hazard-analysis.md）
- `courseTest*` / `asmCaseStore*`（`src/courseTest*.ts`、`src/asmCaseStore*.ts`）— 持续测试与用例存储，见 course-testing.md

## UI

- `sidebar.ts` / `sidebarModel.ts` — 侧边栏 TreeView 与其纯函数数据模型
- `wizard.ts` / `wizardSettings.ts` — 4 步项目向导：选 Profile → 项目名 → 配置外部工具 → 创建目录与模板
- `advancedTools.ts` / `advancedToolModel.ts` — 按 Profile 过滤的低频工具
- `configurationResource.ts` / `diagnosticSettings.ts` — 诊断快速修复的配置读改写（精确作用域）
- `webview/reportLayout.ts` — 报告 Webview 共享 shell/CSS、状态徽标、可横向滚动表格与 nonce CSP；历史报告按需加载本地筛选脚本
- `webview/toolchainReport.ts` — 无宿主依赖的工具链报告渲染（汇总、状态与操作建议）
- `templates/templateRegistry.ts` — `resources/templates` 受控占位替换加载器
- `legacySemanticColorMigration.ts` — 一次性清理旧的全局 semantic token 规则
- `workflowInputs.ts` / `types.ts` — 文件选择辅助与 `AppServices`/`RunResult`/`ToolDetection` 等公共类型

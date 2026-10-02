# waveform | src/waveform/ | 60 files

内置 VCD 波形查看器：VS Code 只读自定义编辑器（`*.vcd` 默认打开）+ "仿真并查看波形"命令。宿主侧流式解析 VCD 为列式 typed-array 模型并经 postMessage 交给 Webview；Webview 用 Canvas 画波形、DOM 虚拟列表画信号名与值

数据流:
  仿真: 命令 → `iverilogRunner`（generatedTopModules 钩子）→ designHierarchy 找 testbench 下的可逐字 dump 小存储器 → `design/waveformDumper` 生成 dump 顶层 → `.co/wave/<tb>.vcd` + `.co/wave/<tb>.sim.out`
  查看: VCD 字节 → `vcd/vcdParser` → `vcd/waveformBuilder` → 列式 `model/waveformData` → postMessage → Webview store → 画布/标签/标尺/缩略条
  trace: 同名 `.sim.out`（须声明打开了该 VCD）→ `CpuTraceEvent` → 按 `$printtimescale` 换算为 dump tick

课程取向: GRF 等小存储器逐字记录并显示 `$sp` 等别名；32 位指令信号默认反汇编；testbench `$display` 的 GRF/DM 写入 trace 叠加到时间轴并可点击联动。

## 设计说明

**纯逻辑与宿主/Webview 分离** `model/`、`view/`、`vcd/`、`design/` 为纯 TS（无 vscode/DOM），宿主、Webview 与测试共用；Webview 由 esbuild 打包到 `out/media/`（`scripts/build-webview.mjs`），tsc 与 `tsconfig.webview.json` 分别做类型检查

**安全边界** Webview 严格 CSP：nonce 脚本、仅 `out/media` 本地资源、无内联 style 属性（样式经 CSSOM 设置）；宿主校验全部入站消息，持久化状态经 `viewStateContract` 清洗

**时间是整数 tick** 一律使用 dump 整数 tick（Float64 精确到 2^53），显示时自适应 ps/ns/µs。仿真默认时间尺度由 runIverilog 的 `co_iverilog_defaults.f` 设为课程 `1ns/1ps`（普通/波形/自动仿真共用），保留源码显式声明与 Verilog 指令继承语义，避免无声明的 GRF/DM 按 Icarus 原默认把 `$time` 舍入为 0

## 入口

- `waveform.ts` — `registerWaveform()`：自定义编辑器 provider、`co.verilog.viewWaveform`、`co.waveform.openFile` 与转发到活动页签的快捷键命令

## Model

- `model/waveformData.ts` — 跨进程数据契约：scope/var 表 + 按 track 列式存储（VPI 四态编码）
- `model/signalValues.ts` — track 二分查找、跳变查找与四态分类
- `model/valueFormat.ts` — 进制格式化（>32 位用 BigInt）、ASCII 与 MIPS 指令
- `model/radix.ts` — 进制枚举与中文标签
- `model/mipsDisassembly.ts` — 机器字反汇编，复用 core 解码器与寄存器名表
- `model/timeScale.ts` — `$timescale` 解析与刻度步长
- `model/viewStateContract.ts` — 持久化视图状态与不可信输入清洗
- `model/protocol.ts` — 宿主与 Webview 消息契约

## VCD

- `vcd/vcdParser.ts` — 流式词法/语法状态机：跨 chunk token、`$comment` 与 `$dumpvars`/`$dumpoff` 检查点块、标量/向量/实数/字符串；末尾无空白的 token 视为截断并标记不完整
- `vcd/waveformBuilder.ts` — 构建模型：按完整路径合并 scope、别名共享 track、等值去重、IEEE 左扩展、位宽/变化数/存储字数上限
- `vcd/vcdReader.ts` — 解析会话门面与一次性 `parseVcd`

## Design（生成 dump 顶层）

- `design/designHierarchy.ts` — 按实例名解析层次与声明；查找可逐字 dump 的一维小存储器（参数覆盖逐级传递，跳过 task/function 内数组与 generate 块内实例），递归与规模有界
- `design/waveformDumper.ts` — 从 `resources/templates/verilog/waveform_dumper.v` 渲染 dump 顶层；越界在编译期告警而非 VVP 崩溃，并把 Icarus 报错按行号归因到具体存储器

## Host

- `host/waveformDumpSetup.ts` — 手动波形与自动测试用例重跑共享的 dumper/discovery/编译拒绝归因；自动重跑按本次 compile 源文件集合发现存储器，VCD 有界记录

- `host/waveformEditorProvider.ts` — `CustomReadonlyEditorProvider`，按文件追踪页签并复用已打开页签；新波形在当前组打开
- `host/waveformPanel.ts` — 单页签控制器：ready 握手、流式加载 + 进度、超大文件确认、按路径过滤的目录监视防抖重载、trace 附加、消息校验、状态保存
- `host/waveformHtml.ts` — Webview 页面 shell 与 CSP
- `host/waveformFileLoader.ts` — Node 流式分块解析（可取消、有进度），非 file 方案走内存切片
- `host/waveformTraceSource.ts` — `.sim.out` 配对与时间换算
- `host/waveformViewStateStore.ts` — workspaceState 按路径保存视图状态（上限 64 个文件）
- `host/waveformSimulation.ts` — "仿真并查看波形"：复用 runIverilog 附加 dump 顶层；编译器拒绝存储器 dump 时只去掉被点名的存储器重试，并按 VVP 实际打开的 dumpfile 定位
- `host/designModules.ts` / `host/waveformSourceLocator.ts` — 模块注册表（按需解析 `.co/tb` 与生成的运行时 TB）与信号/scope 跳回 Verilog 声明；复用源码页签或当前组，不主动分栏

## View（纯逻辑，Webview 使用，单测覆盖）

- `view/viewport.ts` — 适配、锚点缩放、平移、框选与像素换算
- `view/waveSegments.ts` — LOD 遍历：亚像素跳变合并为密集带，工作量受画布宽度约束
- `view/cycleCounter.ts` — 时钟上升沿前缀计数与周期网格
- `view/markers.ts` — 标记集合：稳定编号、就近查找与持久化往返
- `view/signalTree.ts` — 信号树：存储器字归并为数组节点、参数折叠、自然排序与搜索
- `view/waveRows.ts` — 信号行/分组模型与持久化往返
- `view/signalDefaults.ts` — 课程默认：指令进制、时钟识别、首开信号集、GRF `$sp` 别名
- `view/displayNames.ts` — 重名信号补最短 scope 前缀
- `view/timeInput.ts` — 跳转输入 `500ns` / `#tick` / `c120`
- `view/hostShortcuts.ts` — VS Code 自身占用的组合键 → 波形快捷键映射

## Webview（浏览器端，esbuild 打包，覆盖率排除）

- `webview/main.ts`、`webview/app.ts`、`webview/hostChannel.ts` — 入口、组装与消息分派、`acquireVsCodeApi` 封装
- `webview/store.ts`、`webview/actions.ts` — 状态中心与合批脏区（帧调度由 app 注入 rAF，store/actions 不依赖 DOM，可在 node 单测）、缩放/导航/标记/行操作与选择校正；`overlay` 脏区仅重绘透明交互层，`waves`/布局重绘时同步两层
- `webview/wavePane.ts`、`webview/waveCanvas.ts`、`webview/waveRenderer.ts` — 装配与拖入、画布交互、波形绘制；主画布绘制信号和网格，透明画布绘制悬停线、游标/标记与框选
- `webview/rulerRenderer.ts`、`webview/rulerView.ts`、`webview/overview.ts` — 标尺绘制与交互、缩略条
- `webview/rowLabels.ts`、`webview/rowMenu.ts`、`webview/timeMenu.ts`、`webview/contextMenu.ts`、`webview/tooltip.ts` — 信号名与值列、行与时间点右键菜单、通用菜单、悬停提示
- `webview/signalBrowser.ts`、`webview/tracePanel.ts`、`webview/sidebar.ts`、`webview/toolbar.ts`、`webview/statusBar.ts` — 信号树、trace 列表、侧栏、工具栏、状态栏与加载/错误覆盖层
- `webview/keyboard.ts`、`webview/theme.ts`、`webview/icons.ts`、`webview/dom.ts`、`webview/dragData.ts`、`webview/styles.css` — 快捷键与帮助、主题调色板、SVG 图标、DOM 工具、拖放载荷、主题变量驱动样式

# waveform | src/waveform/ | 55 files

内置 VCD 波形查看器：VS Code 只读自定义编辑器（`*.vcd` 默认打开）+ “仿真并查看波形”命令。宿主侧流式解析 VCD 为列式 typed-array 模型并经 postMessage 交给 Webview；Webview 用 Canvas 绘制波形、DOM 虚拟列表绘制信号名/值。面向课程：GRF 等小存储器逐字记录并显示 `$sp` 等别名，32 位指令信号默认反汇编，testbench `$display` 的 GRF/DM 写入 trace 叠加到时间轴并可点击联动。

数据流:
  仿真: 命令 -> iverilogRunner(generatedTopModules 钩子) -> designHierarchy 找 testbench 下 ≤64 字存储器 -> waveformDumper 生成 `$printtimescale`/`$dumpfile`/`$dumpvars` 顶层 -> `.co/wave/<tb>.vcd` + `.co/wave/<tb>.sim.out`
  查看: VCD 字节 -> vcdParser(分词/状态机) -> waveformBuilder(scope 合并/去重/四态) -> WaveformData(列式) -> postMessage -> webview store -> 画布/标签/标尺/缩略条
  trace: 同名 .sim.out（须声明打开了该 VCD）-> CpuTraceEvent -> 按 `$printtimescale` 换算为 dump tick

边界:
  model/、view/、vcd/、design/ 为纯 TS（无 vscode/DOM），宿主、Webview、测试共用；Webview 由 esbuild 打包到 `out/media/`（scripts/build-webview.mjs），tsc 与 tsconfig.webview.json 分别做类型检查
  Webview 严格 CSP：nonce 脚本、仅 `out/media` 本地资源、无内联 style 属性（样式经 CSSOM 设置）；宿主校验全部入站消息，持久化状态经 viewStateContract 清洗
  时间一律用 dump 整数 tick（Float64 精确到 2^53），显示时自适应 ps/ns/µs

entry:
  waveform.ts — registerWaveform(): 注册自定义编辑器 provider、`co.verilog.viewWaveform`、`co.waveform.openFile`，接线源码跳转

model:
  model/waveformData.ts — 跨进程数据契约：scope/var 表与按 track 列式存储（times/aval/bval/reals/texts，VPI 四态编码）
  model/signalValues.ts — track 二分查找、上/下一次跳变、单比特四态与整值 x/z 状态分类
  model/valueFormat.ts — 进制格式化：hex/bin/无/有符号十进制（>32 位用 BigInt）/ASCII/MIPS 指令；x/z 按 nibble 显示 x、z、X
  model/radix.ts — 进制枚举与中文标签
  model/mipsDisassembly.ts — 机器字反汇编，复用 core 解码器、instructionForms 与寄存器名表
  model/timeScale.ts — `$timescale` 解析、tick 物理时间文本、1/2/5 刻度步长
  model/viewStateContract.ts — 持久化视图状态（行/分组/进制/颜色/时钟/视窗/游标/标记/布局）与不信任输入清洗
  model/protocol.ts — 宿主与 Webview 消息契约、trace 事件结构

vcd:
  vcd/vcdParser.ts — 流式 VCD 词法/语法状态机：跨 chunk token、头部命令、$comment/$dumpoff 等块、标量/向量/实数/字符串值，异常内容产生有限条诊断
  vcd/waveformBuilder.ts — 构建模型：按完整路径合并重复 scope、同 id 别名共享 track、重复 $dumpvars 去重、同刻覆盖与等值去重、IEEE 左扩展、变化数上限、时间倒退告警
  vcd/vcdReader.ts — 解析会话门面与一次性 parseVcd

design:
  design/designHierarchy.ts — 按实例名解析层次、查声明；在 testbench 下（含参数覆盖）查找可逐字 dump 的一维小存储器，递归/规模有界
  design/waveformDumper.ts — 从 resources/templates/verilog/waveform_dumper.v 渲染 dump 顶层，workspace 摘要命名，dump 路径相对 VVP 工作目录

host:
  host/waveformEditorProvider.ts — CustomReadonlyEditorProvider，按文件追踪页签，openWaveformEditor 复用已打开页签或在侧边打开
  host/waveformPanel.ts — 单个编辑器页签的控制器：ready 握手、流式加载+进度、>256 MiB 需确认、文件监视防抖重载（未变化跳过）、trace 附加、消息校验、状态保存
  host/waveformHtml.ts — Webview 页面（resources/templates/webview/waveform_page.html）与 CSP
  host/waveformFileLoader.ts — Node 流式分块解析（可取消、进度）、非 file 方案内存切片解析
  host/waveformTraceSource.ts — `.sim.out` 配对与时间换算（P4 无时间戳格式给出说明）
  host/waveformViewStateStore.ts — workspaceState 按路径保存视图状态，最多 64 个文件
  host/waveformSimulation.ts — “仿真并查看波形”：复用 runIverilog 附加 dump 顶层，trace 写 `.co/wave`；存储器路径无法编译时去掉逐字 dump 重试；按 VVP 实际打开的 dumpfile 定位
  host/designModules.ts — 模块注册表 + 按需解析 `.co/tb`、生成的运行时 TB
  host/waveformSourceLocator.ts — 波形信号/scope 路径跳回 Verilog 声明，在波形之外的编辑器列打开

view (纯逻辑，Webview 使用，单测覆盖):
  view/viewport.ts — 视窗：适配、锚点缩放、平移、框选、确保可见、像素换算与 overscroll 限制
  view/waveSegments.ts — LOD 遍历：亚像素跳变合并为密集带，工作量受画布宽度约束；有序时间点按列聚合
  view/cycleCounter.ts — 时钟上升沿前缀计数：周期序号、上/下一个沿、区间周期数、周期网格
  view/signalTree.ts — 信号树：存储器字归并为数组节点、参数折叠、自然排序、搜索（含路径片段）与扁平化
  view/waveRows.ts — 信号行/分组模型：去重添加、移动、分组/取消分组、持久化往返、重载后按路径重绑
  view/signalDefaults.ts — 课程默认：指令信号用 instr 进制、时钟识别、首开信号集 + 寄存器堆分组、GRF `$sp` 别名
  view/displayNames.ts — 重名信号补最短 scope 前缀
  view/timeInput.ts — 跳转输入：`500ns`、`#tick`、`c120`/`周期 120`

webview (浏览器端，esbuild 打包，覆盖率排除):
  webview/main.ts — 入口；webview/app.ts — 组装与宿主消息分派；webview/hostChannel.ts — acquireVsCodeApi 封装
  webview/store.ts — 状态中心与 rAF 合批脏区；webview/actions.ts — 缩放/导航/标记/行操作/trace 联动
  webview/wavePane.ts — 表头+粘性画布+虚拟标签行+缩略条装配与拖入；webview/waveCanvas.ts — 画布交互（吸附游标、框选放大、拖动游标/标记、平移、缩放、悬停提示）
  webview/waveRenderer.ts — 波形绘制；webview/rulerRenderer.ts、webview/rulerView.ts — 标尺绘制与交互；webview/overview.ts — 缩略条
  webview/rowLabels.ts — 信号名/值列；webview/rowMenu.ts — 行右键菜单；webview/contextMenu.ts — 通用菜单；webview/tooltip.ts — 悬停提示
  webview/signalBrowser.ts — 信号树；webview/tracePanel.ts — trace 列表；webview/sidebar.ts — 侧栏；webview/toolbar.ts — 工具栏；webview/statusBar.ts — 状态栏与加载/错误覆盖层
  webview/keyboard.ts — 快捷键与帮助；webview/theme.ts — 主题调色板；webview/icons.ts — SVG 图标；webview/dom.ts — DOM 工具；webview/dragData.ts — 拖放载荷
  webview/styles.css — 主题变量驱动的样式

# mips-debug | src/mips/debug/ | 18 files

VS Code 内置 MARS 调试工作台。入口命令和 Webview 生命周期在本模块；指令执行与状态快照由 `mips-core` 提供，交互命令经 `mips-host` 的 Worker transport 执行。工作台复用现有汇编器、诊断和 syscall catalog，不复制 ISA、课程 Profile 或普通 MARS 服务事实。

## 用户入口与工作流

对已打开的 `.asm` / `.s` / `.mips` 文件，可点击 ASM 编辑器标题栏上的调试图标、在命令面板运行 **`CO: 打开 MARS 调试工作台`**，或从侧边栏 **`CO: 更多工具` → `MARS 调试工作台`** 打开。首次打开后按以下流程使用：

1. 选择普通 **MARS** 或 P3–P7 课程模式，点击 **汇编**。工作台捕获主文件和 include 源码，使用共享汇编器；诊断定位回源码，指令列表保留伪指令展开后的地址与来源。
2. 在指令列表中设置断点，然后 **单步** 或 **运行**；运行中可暂停、停止或重置。执行停在入口、断点、暂停点或终态时均可查看当前状态。
3. 检查整数/FPU/CP0 寄存器、内存页、符号和控制台；普通 MARS 的输入 syscall 可在控制台提交输入或发送 EOF，服务参考表显示服务号及当前内置支持情况。
4. 程序汇编后可选择 text、ktext、data 或 kdata 段并导出 HexText。源文件或 include 改动会标记当前镜像已过期，需重新汇编后继续。

## 执行语义边界

普通 MARS 模式采用项目的普通 MARS 内存布局和延迟槽设置，`syscall` 按 `$v0` 调用内置服务。P3–P6 课程模式执行对应课程 Profile，不调用普通 MARS syscall 服务。P7 的 `syscall` 依 tutorial P7-2-6 产生 ExcCode=8 并进入 `0x4180`；它不会在工作台弹出普通输入或输出服务。

工作台展示架构指令步进和机器状态，不估算 Timer 周期、不注入外部中断，也没有反向单步或寄存器/内存状态编辑功能。它不能替代 P7 周期级 Timer/外部中断验证。

## 模块文件

- `workbench.ts` — 注册命令、创建面板及资源清理
- `controller.ts` — 汇编、诊断、源文件变化、调试会话和有限状态投影编排
- `source.ts` — 捕获主文件/include 快照、源位置转换与汇编诊断
- `protocol.ts` / `messages.ts` — Webview 状态契约及不可信消息校验
- `html.ts` — 使用 nonce 与严格 CSP 生成工作台 Webview 外壳
- `state.ts` — 将核心快照投影为界面寄存器、内存、模式说明和 syscall 参考
- `webview/app.ts`, `webview/console.ts`, `webview/dom.ts`, `webview/format.ts`, `webview/listing.ts`, `webview/main.ts`, `webview/memory.ts`, `webview/reference.ts`, `webview/registers.ts`, `webview/tabs.ts`, `webview/styles.css` — 面板组合、控制台、指令列表、寄存器、内存、符号/syscall 参考、DOM、标签页、格式、样式和入口

## 验证

- 生产 VS Code 宿主 gate：`npm run verify:extension-host -- <解包后的 extension 根目录>`。该门禁加载解包扩展，在真实 VS Code 中运行 `scripts/extension-host-mars-workbench.cjs`，覆盖真实面板/Worker 汇编、step、输入、断点、终态检查、导出、取消、源文件变化以及 P7 trap。
- 浏览器 fixture：先执行 `npm run build:webview`，再单独运行 `node scripts/preview-mars-workbench.mjs`；它会输出本地 fixture URL 并保持服务运行。另开终端运行 `node scripts/verify-mars-workbench-browser.mjs <fixture URL>`。验证器使用本机 Chromium/Edge 的 DevTools 协议检查生产 Webview bundle 的操作、输入焦点、主题、窄视口与安全文本渲染；浏览器路径可通过 `CO_BROWSER_EXECUTABLE` 指定。

浏览器 fixture 用于快速检查 Webview 呈现和交互；真实宿主 gate 覆盖扩展注册、VS Code API、Worker 与课程执行语义。

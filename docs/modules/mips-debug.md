# mips-debug | src/mips/debug/ | 19 files

VS Code 内置 MARS 调试工作台。入口命令和 Webview 生命周期在本模块；指令执行与状态快照由 `mips-core` 提供，交互命令经 `mips-host` 的 Worker transport 执行。工作台复用现有汇编器、诊断和 syscall catalog，不复制 ISA、课程 Profile 或普通 MARS 服务事实。

## 用户入口与工作流

对已打开的 `.asm` / `.s` / `.mips` 文件，可点击 ASM 编辑器标题栏上的调试图标、在命令面板运行 **`CO: 打开 MARS 调试工作台`**，或从侧边栏 **`CO: 更多工具` → `MARS 调试工作台`** 打开。首次打开后按以下流程使用：

1. 选择普通 **MARS** 或 P3–P7 课程模式，点击 **汇编**。工作台捕获主文件和 include 源码，使用共享汇编器；诊断定位回源码，指令列表保留伪指令展开后的地址与来源。
2. 在指令列表中设置断点，然后 **单步** 或 **运行**；运行中可暂停、停止或重置。执行停在入口、断点、暂停点或终态时均可查看当前状态。
3. 检查整数/FPU/CP0 寄存器、内存页、符号和控制台；普通 MARS 的输入 syscall 可在控制台提交输入或发送 EOF，服务参考表显示服务号及当前内置支持情况。执行或单步时指令列表自动跟随 PC；暂停后可手动浏览，点击「定位 PC」返回当前指令。进入输入等待时自动聚焦标准输入。
4. 程序汇编后可选择 text、ktext、data 或 kdata 段并导出 HexText。源文件或 include 改动会标记当前镜像已过期，需重新汇编后继续。

内存和系统服务页使用更大的默认高度；所有检查页都可点击「展开阅读」进入大窗口，按 Esc 或「还原布局」返回，保留当前内容与搜索条件。窄窗口的服务参考采用纵向条目。内存每页 64 个字（256 字节），可选择数据段/堆/栈、翻页或输入四字节对齐地址后「转到」。等待标准输入时也可切换内存页和断点，不推进指令；停止后显示最后快照并禁用切页，重置后恢复。点击数据标签会切换到内存，代码标签会定位对应指令。

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
- `webview/app.ts`, `webview/console.ts`, `webview/dom.ts`, `webview/format.ts`, `webview/inspection.ts`, `webview/listing.ts`, `webview/main.ts`, `webview/memory.ts`, `webview/reference.ts`, `webview/registers.ts`, `webview/tabs.ts`, `webview/styles.css` — 面板组合、控制台、检查页与展开阅读、指令列表、寄存器、内存、符号/syscall 参考、DOM、标签页、格式、样式和入口

## 验证

- 生产 VS Code 宿主 gate：`npm run verify:extension-host -- <解包后的 extension 根目录>`。该门禁加载解包扩展，在真实 VS Code 中运行 `scripts/extension-host-mars-workbench.cjs`，覆盖真实面板/Worker 汇编、step、输入、断点、终态检查、导出、取消、源文件变化以及 P7 trap。
- 浏览器 fixture：先执行 `npm run build:webview`，再单独运行 `node scripts/preview-mars-workbench.mjs`；它会输出本地 fixture URL 并保持服务运行。另开终端运行 `node scripts/verify-mars-workbench-browser.mjs <fixture URL>`。验证器使用本机 Chromium/Edge 的 DevTools 协议检查生产 Webview bundle 的操作、输入焦点、主题、窄视口与安全文本渲染；浏览器路径可通过 `CO_BROWSER_EXECUTABLE` 指定。

浏览器 fixture 用于快速检查 Webview 呈现和交互；真实宿主 gate 覆盖扩展注册、VS Code API、Worker 与课程执行语义。

`node scripts/verify-mars-workbench-program.mjs [conv.asm 路径]` 在构建后通过真实 Controller/Worker 验证运行、逐条执行和输入期间的内存跳转。无参数使用内置输入样例；指定路径用于课程 P2 卷积样例（3×3 的 1–9 矩阵，2×2 的 1/0/0/1 卷积核，期望 6/8、12/14）。源码保持不变，状态记录写入 `.vscode-test/mars-workbench-program.json`。把该文件作为浏览器验证器的第三个参数可回放真实状态，检查每次 PC 更新后的可见性。

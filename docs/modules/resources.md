# resources | resources/ + syntaxes/ + snippets/ + language-configuration/ | ~55 files + 5 bundled Icarus runtimes

静态资产，随 VSIX 打包。**所有 `co.*` 配置、课程事实与语言目录都有唯一源文件**，package.json 与运行时代码都是生成物。

## 唯一源与生成物

| 源 | 生成物 | 命令 |
| --- | --- | --- |
| `resources/co/configManifest.json` | `package.json` `contributes.configuration` + `resources/co/configDefaults.json` | `npm run sync:manifest-config` |
| `resources/mips/isa.json` | `src/mips/core/generated/isaCatalog.ts`、`src/language/mips/generated/isaDisplayCatalog.ts`、`resources/mips/generatorProfiles.json` | `npm run sync:isa-catalog` |
| `resources/co/languages.json` | package 语言贡献 + `src/language/generated/languages.ts` | `npm run generate:languages` |
| `resources/mips/*.json` + `resources/verilog/*.json` | `syntaxes/*.tmLanguage.json` | `npm run sync:syntaxes` |

规则：不手写生成物；修改源后提交生成结果。`compile` / `test` / `package:vsix` 都先跑 `sync:generated`（Profile → ISA → config → languages → syntaxes → diagnostics），CI 在任何生成前运行 `check:generated`，防止自动修复掩盖提交漂移；`npm run verify:generated-tree-clean` 证明 clean checkout 编译后 tree clean。

## 课程与语言事实

- `mips/isa.json` — 真实指令唯一 catalog：encoding / runtime / canonical / effects / control / profile 与 generator 稳定顺序
- `mips/instructions.json` — 展示元数据（助记符、类型、格式、操作数、描述）
- `mips/instructionMeta.json` — 伪指令、非 catalog 指令与 parser directive 的附加元数据
- `mips/pseudoExpansions.json` / `pseudoForms.json` — MARS 伪指令/扩展操作数形式的**展示**模板；内建可执行能力由 core 展开 handler registry 定义
- `mips/registers.json` / `cp0Registers.json` / `directives.json` — 寄存器中文用途与 CP0 展示说明、TextMate 生成输入；LSP 的寄存器解析和 directive 集合直接使用 core。普通 syscall 唯一目录为 mips-core 的 `mars/syscallCatalog.ts`，旧 `syscalls.json` 已删除
- `verilog/keywords.json` / `systemverilog.json` — keyword group、compiler directive、system task 与 operator 目录（SystemVerilog 不进 Verilog parser）
- `co/courseConfig.json` — Profile 定义（P0–P7）：能力矩阵、默认项、语言、目录、端口、内存布局与推断 hints
- `co/p7Hardware.json` — P7 硬件布局：4096-word IM、3072-word DM、0x4180 异常入口、probe、Timer、CP0 与中断确认

## 模板

`resources/templates/` 经 `templates/templateRegistry.ts` 做受控占位替换，保证生成产物可审计。

- `verilog/` — `basic_testbench.v`、`external_memory_testbench.v`、`p7_official_testbench.v`、`p7_interrupt_block*.v`、`p7_probe_block.v`、`waveform_dumper.v`（波形 dump 顶层）、`dm_store_contract.v`（P6/P7 有效 DM 写事务契约，保留 `CO_DM_STORE` 原始字段供 builtin oracle 对拍）、`p7_probe_invalid_store_observer.v` + `p7_probe_invalid_store_case.v`
- `webview/` — `report_page.html`、`report.css`（测试/工具链/冲突分析共享主题样式）、`reportFilter.js`（测试历史搜索/结果筛选与视图状态恢复）、`continuousActions.js`（固定停止/历史操作，工作区与会话由宿主持有）；`waveform_page.html`（独立波形界面，脚本/样式来自 `out/media`）。报告均使用 nonce CSP，无远程字体、脚本或图标依赖。
- `wizard/` — `p2_main.asm`、`verilog_top.v`、基础 testbench fallback
- `asm/` — `p7_exception_handler*.asm`、`p7_probe_prologue.asm`、`p7_probe_handler.asm`
- `hazard/` — 冲突报告模板

## 编辑器资产

- `icons/logo.svg` / `icons/logo.png` — 简化芯片与 CO 字形品牌标识；命令、侧边栏功能图标统一使用 VS Code 内置 Codicon。

- `syntaxes/` — `mips`、`verilog`、`systemverilog` TextMate grammar（由目录确定性生成）
- `snippets/` — `mipsasm.json`、`verilog.json`
- `language-configuration/` — `mipsasm.json`、`verilog.json`（括号配对、注释与自动闭合）

## Bundled Icarus 运行时

`vendor/iverilog/{win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}/` 提供固定的 Icarus 13.0 运行时（Windows 为 MSYS2 UCRT64，macOS 为 Homebrew bottle，Linux 为 Ubuntu 22.04 原生构建），使用系统 libc/GLIBC，不分发私有 loader。

每个 target 附 `THIRD_PARTY_NOTICES.md` + `licenses/`，`CORRESPONDING_SOURCES.json` 记录上游源码 URL、大小与 SHA-256（`file` 使用 GitHub Release 不会重写的稳定资产名）。macOS/Linux 额外保留 `include/` 与 `share/` 完整 prefix，Git 保留可执行位，release 打包前会恢复。

## 打包

`scripts/package-vsix.mjs` 是本地与 release 共用的入口（必填 `--target`、可选 `--out`），按目标裁剪 runtime 目录并保留共享来源/配方。`scripts/build-host.mjs` 将宿主、LSP、Worker 与 CLI 各自打包；Icarus 门禁使用的三个公共 helper 也有独立 bundle。所有资源加载入口位于 `out/` 根目录，共享安装根定位，Worker/CLI 保留原嵌套路径且不加载安装资源。构建检查外部依赖及宿主误引服务端模块，并生成依赖许可证合集。

`npm run compile` 默认生成未压缩且带 source map 的宿主 bundle，保留 F5 调试；`vscode:prepublish` 用 `--production` 生成发布 bundle。`tsc` 的逐文件输出保留供本地验证脚本使用；VSIX 仅允许 bundle 入口、Webview 与许可证，排除 `node_modules`、源码、测试与构建元数据。`.github/actions/verify-extension-package/action.yml` 被 release 与 Extension platforms CI 共用：解包确认唯一目标 runtime 后运行 Icarus smoke 与真实 VS Code 宿主检查（Linux 用 Xvfb）。`CO_VSCODE_EXECUTABLE` 可指定本机 VS Code 进行隔离宿主验证，默认仍下载指定版本。

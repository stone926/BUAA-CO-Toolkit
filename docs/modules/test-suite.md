# test-suite | src/test/ | 230 files | 框架: Vitest

单元/集成测试，目录结构镜像 `src/`。测试文件名规则为 `<name>.test.ts`。

`npm test` / `npm run test:coverage` 先 `sync:generated`，再 `npm run typecheck`（用 `tsconfig.test.json` 严格检查生产源码、测试源码与 Vitest 配置，且不生成文件），最后运行 Vitest；CI 与 release 的 `npm test` 同样包含该门禁。`npm run compile` 仍只构建生产源码。`npm run test:all` 追加 `node scripts/check-index.mjs`。

## 覆盖地图

| 目录 | 数量 | 重点 |
| --- | --- | --- |
| `test/language/` | 68 | MIPS/Verilog/Logisim/common 的 parser、diagnostic、provider 与真实工程语料回归 |
| `test/`（根） | 44 | 配置/Profile、工具链、进程、报告、侧边栏、模板、fixture 快照 |
| `test/courseTesting/` | 40 | 生成器、oracle 差分、manifest v1/v2、probe 场景与 DUT 契约 |
| `test/mipsCore/` | 21 | ISA golden、汇编器、执行器、devices 与 events |
| `test/verilog/` | 14 | 真实 bundled Icarus：时间尺度、DM store 契约、runtime/runner/缓存失效 |
| `test/waveform/` | 10 | VCD 解析、进制与反汇编、视窗/标记/行模型、宿主与面板、设计 dump |
| `test/mips{Providers,Host,Replay,Cli}/` | 19 | engine plan 解析与 preflight 不可变性、Worker protocol v2/ACK/cancel、bundle 完整性、JSONL CLI |
| `test/mips/` | 4 | 跨模块集成 |
| `test/{hazardAnalysis,helpers,templates,webview}/` | 7 | 冲突分析解析与动态路径、共享 fixture 辅助、模板与 Webview 回归 |

**fixtures**：`test/fixtures/syntax/{mips,verilog}/` 下分 `valid/`、`invalid/`（含 JSON 期望）与课程语料目录。

**TextMate 回归**：用 `vscode-textmate` + `vscode-oniguruma` 逐行 tokenizeLine 并保留 ruleStack，覆盖未闭合字符串不跨行、scope 边界、catalog 同步与课程真实宏/数字片段。

## 真实工具与平台证据

这些 lane 使用真实的 bundled Icarus / MARS / 真实 VS Code，不 mock 生产接口：

- `scripts/verify-bundled-iverilog.mjs` / `verify-bundled-iverilog-course.mjs` — 按 host platform/arch 选择五个 runtime 之一，在隔离 PATH 下验证中文与空格路径的 syntax success/failure、compile/VVP、`$readmemh`/`$display`、watchdog 与课程兼容
- `scripts/verify-extension-host.mjs` + `extension-host-smoke.cjs` — `@vscode/test-electron` 加载最终 VSIX 解包目录，创建中文空格工作区，验证真实激活、LSP 保存诊断与修复、`co.verilog.runSimulation`、持续测试的内置生成器/assembler/Worker oracle/Icarus 故意错误 DUT 与首失败停止
- `scripts/verify-mips-{cli,worker}.mjs`、`verify-process-supervisor.mjs`、`verify-real-cpu-shadow*.mjs`、`check-module-boundaries.mjs` — CLI/Worker 边界、进程树、真实 CPU shadow 与模块依赖边界
- `scripts/package-vsix.test.mjs` — 通过真实 vsce fixture 验证五目标内容裁剪、共享许可/来源/配方保留与中文空格路径
- `conformance/mips/test/` — ISA golden、决策向量、250+5 冻结执行语料与 phase6 evidence 聚合器；`npm run verify:phase6` 运行固定 v0.6.3 assembly-diff 与 course1 real execution differential
- `.github/actions/verify-extension-package/action.yml` 与 `.github/workflows/extension-platforms.yml` — 五 target 原生 PR/main 验证，与 release 共用打包、解包、Icarus smoke 与真实宿主检查（Linux 用 Xvfb）；不逐平台重复全量单元测试

## 回归重点

- **课程自动测试**：P3–P7 独立 GPR 双端口读与存储观察（每持续会话一次），随机点保留默认最大 payload；jr 生产者 × 间隔 0/1/2 的陈旧目标变异；小预算跳转毒指令、双向控制流与错误路径变异；双端口/最新写优先/load-store lane 的可观察依赖；P7 原 130 变体完整保留（36 个特殊 Timer 变体单独说明），older-MDU 四变体、Mode1 停机去断言、五种真实双 IRQ 程序及字段/顺序/重放损坏反例；continuous 的会话所有权清理与 fail-closed 保留
- **返回边界协议**：`p7ReturnProbe.test.ts` 校验不同种子、合法 jal link 重放、未命中与功能失败区别、handler 字段来源和路径内错误 EPC；`p7ReturnTestbench.test.ts` 使用真实 Icarus 检查不同 eret 停留长度、X/错位 PC、SW 低位 don't-care、未选中 IG 转发、应答随 interrupt 撤销等合法接口变体
- **DUT 观测**：`CO_DM_STORE` 公开事务与 builtin CommitEvent 逐笔对拍（覆盖整字相同时仍能失败的地址/mask 漏检）；P6/P7 完整 testbench 下 `dm_store_contract.v` 捕获的错误全使能读改写
- **可移植性**：`processCore` 的 stdout/stderr raw-byte cap、UTF-8 chunk 边界、timeout/abort 与子孙进程树；Windows UTF-8 code page manifest；macOS/Linux 的 bundled `-B <lib/ivl>`

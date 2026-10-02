# test-suite | src/test/ | 247 files | 框架: Vitest

单元/集成测试，目录结构镜像 `src/`。测试文件名规则为 `<name>.test.ts`。

`npm test` / `npm run test:coverage` 先 `sync:generated`，再 `npm run typecheck`（用 `tsconfig.test.json` 严格检查生产源码、测试源码与 Vitest 配置，且不生成文件），最后运行 Vitest；CI 与 release 的 `npm test` 同样包含该门禁。`npm run compile` 仍只构建生产源码。`npm run test:all` 追加 `node scripts/check-index.mjs`。

## 覆盖地图

| 目录 | 数量 | 重点 |
| --- | --- | --- |
| `test/language/` | 77 | MIPS/Verilog/Logisim/common 的 parser、diagnostic、provider 与真实工程语料回归 |
| `test/`（根） | 46 | 配置/Profile、工具链、进程、报告、侧边栏、模板、fixture 快照 |
| `test/courseTesting/` | 41 | 生成器、oracle 差分、manifest v1/v2、probe 场景与 DUT 契约 |
| `test/mipsCore/` | 26 | ISA golden、汇编器、执行器、devices/events 与架构调试会话 |
| `test/verilog/` | 15 | 真实 bundled Icarus：时间尺度、格式化等价性、DM store 契约、runtime/runner/缓存失效 |
| `test/waveform/` | 11 | VCD 解析、进制与反汇编、视窗/标记/行模型、宿主与面板、设计 dump |
| `test/mips{Providers,Host,Replay,Cli,Debug}/` | 23 | engine plan、Worker protocol v2/ACK/cancel、bundle 完整性、JSONL CLI 与工作台会话/Worker 边界 |
| `test/mips/` | 4 | 跨模块集成 |
| `test/{hazardAnalysis,helpers,templates,webview}/` | 4 | 冲突分析解析、模板与 Webview 回归 |

**fixtures**：`test/fixtures/syntax/{mips,verilog}/` 下分 `valid/`、`invalid/`（含 JSON 期望）与课程语料目录。

**TextMate 回归**：用 `vscode-textmate` + `vscode-oniguruma` 逐行 tokenizeLine 并保留 ruleStack，覆盖未闭合字符串不跨行、scope 边界、catalog 同步与课程真实宏/数字片段。

## 真实工具与平台证据

这些 lane 使用真实的 bundled Icarus、内置 MIPS Worker 和真实 VS Code，不 mock 生产接口。冻结 MARS 仅作为可选历史 reference 数据，不启动外部 MARS：

- `scripts/verify-bundled-iverilog.mjs` / `verify-bundled-iverilog-course.mjs` — 按 host platform/arch 选择五个 runtime 之一，在隔离 PATH 下验证中文与空格路径的 syntax success/failure、compile/VVP、`$readmemh`/`$display`、watchdog 与课程兼容
- `scripts/verify-extension-host.mjs` + `extension-host-smoke.cjs` — `@vscode/test-electron` 加载最终 VSIX 解包目录，创建中文空格工作区，验证真实激活、LSP 保存诊断与修复、`co.verilog.runSimulation`、持续测试的内置生成器/assembler/Worker oracle/Icarus 故意错误 DUT 与首失败停止
- `scripts/extension-host-custom-testbench-smoke.cjs` — 同一真实宿主中验证 `tb.v` / `testbench.v` 的同名与异名模块选择、DUT 时钟激励、无关错误 TB 排除、编译/运行失败后的修复，以及 VCD、仿真 trace 与内置波形查看器
- `scripts/extension-host-asm-smoke.cjs` — 同一真实宿主中验证 P3–P7 内置汇编导出（外部 Java/MARS 不可用）、中文空格路径 include/宏、逐字机器码与停机尾、P7 0x4180 handler 与独立 kernel 文件，以及错误导出保留已有产物和修复
- `scripts/extension-host-mars-workbench.cjs` — 同一真实宿主中验证生产 MARS 工作台面板与 Worker 的汇编、单步、stdin、等待输入时的内存跳转、断点、终态检查、段导出、取消、源文件变化和 P7 syscall trap；浏览器 fixture 的手动构建/检查命令见 `mips-debug.md`
- `scripts/verify-mars-workbench-program.mjs` — 真实 Controller/Worker 执行输入样例或指定 P2 卷积源文件，记录运行与单步状态；浏览器验证器回放以检查 PC 可见性，另检查内存导航、展开阅读、输入焦点与窄窗口布局
- `scripts/extension-host-mars.cjs` — 必跑的真实宿主内部 MARS 测试；Java/JAR 路径故意无效，覆盖各 Profile/工作区外 ASM、中文空格 include/宏、stdin、P2 逐字导出、错误保留产物、超时及实际伪终端输入与文件读写
- `scripts/verify-mips-{cli,worker}.mjs`、`verify-process-supervisor.mjs`、`verify-real-cpu-shadow*.mjs`、`check-module-boundaries.mjs` — CLI/Worker 边界、进程树、真实 CPU shadow 与模块依赖边界
- `scripts/package-vsix.test.mjs` — 通过真实 vsce fixture 验证五目标内容裁剪、共享许可/来源/配方保留与中文空格路径
- `conformance/mips/test/` — ISA golden、决策向量、250+5 冻结执行语料与 phase6 evidence 聚合器；`npm run verify:phase6` 运行 builtin JSONL 汇编/执行与课程向量门禁，历史 MARS 差分仅在明确 archival 命令中读取冻结证据
- `.github/actions/verify-extension-package/action.yml` 与 `.github/workflows/extension-platforms.yml` — 五 target 原生 PR/main 验证，与 release 共用打包、解包、Icarus smoke 与真实宿主检查（Linux 用 Xvfb）；不逐平台重复全量单元测试

## Verilog 格式化回归

- `language/verilog/formatting.test.ts` 保留课程默认布局与旧偏好 golden；辅助函数实际应用完整 TextEdit 列表，不假设首条编辑是全文替换。
- `language/verilog/formattingSafety.test.ts` 验证 token/注释/字符串/宏保真、未完成输入、结构边界、off/on、换行和幂等性。
- `language/verilog/formattingRange.test.ts` 验证相交完整行的选区边界、范围外不变、受保护内容以及无变化编辑。
- `language/verilog/formattingPerformance.test.ts` 覆盖 2k/10k/50k 行文档及长字面量、深嵌套等边界；使用 `CO_FORMAT_PERF_BUDGET_MS` 可调整预算，不以空结果替代正确输出。
- `language/verilog/formattingEditRegression.test.ts` / `language/verilog/formattingStructureRegression.test.ts` 固化审查发现的数字 token 边界、选区间隙、保护区结构、条件分支与错误恢复回归。
- `verilog/formattingEquivalence.test.ts` 用真实 bundled Icarus 分别编译原始和格式化后的合法样例，并比较确定性仿真结果；词法保真断言不替代行为证据，runtime 缺失的跳过必须单独报告。
- `language/common/formattingRequest.test.ts` 验证配置异步等待期间的取消、文档关闭与版本变化，不允许过期 edits 返回。
- `scripts/extension-host-formatting-smoke.cjs` 由真实宿主入口调用，通过 VS Code 全文/选区 provider 应用 edits，覆盖幂等、缩进设置和保护区域，不 mock 格式化核心。

## 回归重点

- **特殊测试结果展示**：通过/失败/工具错误与范围说明分别保留；运行中先发布 activeCase，完成后保存具体首失败；历史无结果和取消不冒充终态，限定目录监视、合并刷新及关闭后的异步读保护
- **课程自动测试**：P3–P7 独立 GPR 双端口读与存储观察（每持续会话一次），随机点保留默认最大 payload；jr 生产者 × 间隔 0/1/2 的陈旧目标变异；小预算跳转毒指令、双向控制流与错误路径变异；双端口/最新写优先/load-store lane 的可观察依赖；P7 原 130 变体完整保留（36 个特殊 Timer 变体单独说明），older-MDU 四变体、Mode1 停机去断言、五种真实双 IRQ 程序及字段/顺序/重放损坏反例；continuous 的会话所有权清理与 fail-closed 保留
- **返回边界协议**：`p7ReturnProbe.test.ts` 校验不同种子、合法 jal link 重放、未命中与功能失败区别、handler 字段来源和路径内错误 EPC；`p7ReturnTestbench.test.ts` 使用真实 Icarus 检查不同 eret 停留长度、X/错位 PC、SW 低位 don't-care、未选中 IG 转发、应答随 interrupt 撤销等合法接口变体。Mode1 官方周期模型与“每次 Enable 仅发一次 IRQ、COUNT 仍重载”的变异，确保停止态新检查不会替代连续周期 IRQ 覆盖
- **DUT 观测**：`CO_DM_STORE` 公开事务与 builtin CommitEvent 逐笔对拍（覆盖整字相同时仍能失败的地址/mask 漏检）；P6/P7 完整 testbench 下 `dm_store_contract.v` 捕获的错误全使能读改写
- **可移植性**：`processCore` 的 stdout/stderr raw-byte cap、UTF-8 chunk 边界、timeout/abort 与子孙进程树；Windows UTF-8 code page manifest；macOS/Linux 的 bundled `-B <lib/ivl>`

- `scripts/verify-internal-mars.mjs` — 源文件/include → 真实 Worker → syscall IO 的独立端到端门禁，另验证 P7 syscall 仍进入 0x4180 内核。运行 `npm run verify:internal-mars`。

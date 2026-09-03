# test-suite | src/test/ | 201 files | 框架: Vitest

单元/集成测试, 镜像src/结构. npm test = vitest run. 以下为<name>.test.ts

test/:
  manifest, configProfile, wizardSettings, wizardUpdate, configurationResource, diagnosticSettings, advancedToolModel, asmCaseStoreCore, fsUtil, sidebarModel, verilogIsimCache, verilogIsimOutput, verilogSimulationFiles, python, toolchain, courseConfig, courseTestToolchain, courseTestCases, courseTestStdin, courseTestLogisim, courseTestReport, profileResolver；manifest 精确锁定 20 项公开配置/22 项仅已配置可见兼容 schema 及 scope/order，fsUtil 锁定 generated write-if-changed 的同内容跳过/大文件免读/symlink 拒绝

test/language/common/:
  settings, diagnosticActions, lsp, util, documentResultCache, semanticTokens

test/language/mips/:
  parser, syntax, instructionValidation, semantic, resources, hover, formatting, traceParser, traceCompare, realProjectPatterns, completions, signatureHelp, codeActions

test/language/verilog/:
  syntaxDiagnostics, widthDiagnostics, usageDiagnostics, workspaceDiagnostics, iseSyntaxCheck, iverilogSyntaxCheck, externalSyntaxCheck, iseDiagnosticFilters, semanticModel, parser, formatting, folding, traceParser, cst, model, workspaceModuleRegistry, completions, semanticTokens, crossFileSemantic, signalWiring, taskDeclarations, parseCache, workspaceIndex, expressionAstLsp, realProjectPatterns, performance, constantDivisorDiagnostics, selectBoundsDiagnostics, parameterOverrideDiagnostics, assignmentDiagnostics, lintRules

test/verilog/:
  verilogBackend, iseProjectOrder, iverilogRuntime, iverilogRunner, iverilogCompileCache, simulationRunner, simulationDiagnostic, simulationInputs — 默认 Icarus/显式 ISim 选择、ISE 源发现/XISE 顺序的并发合并缓存（调用级 extra/exclusion 重算、按根失效、LRU 上界）、win32-x64/darwin-arm64/darwin-x64/linux-x64/linux-arm64 runtime 纯映射与 unsupported 分支、五 target 路径/预检、Unix `-B <lib/ivl>` 与 Windows argv 不变、源码目录 include、compile+VVP/watchdog argv、workspace 串行/排队取消、session compile cache 的源码/依赖/include-shadow/artifact 失效与 LRU 上界、自定义机器码名 alias 与无 fallback 分派；失败 phase/reason、Windows/POSIX/中文路径脱敏、首条诊断、限长和私有 raw artifact 持久化

TextMate:
  使用 vscode-textmate + vscode-oniguruma 逐行 tokenizeLine 并保留 ruleStack，覆盖未闭合字符串不跨行、scope 边界、catalog 同步及课程真实宏/数字片段

test/language/logisim/:
  service, rom, realProjectPatterns

test/courseTesting/:
  builtinAsmGenerator, generator, mipsUtil, p7ProbeCheck, p7InterruptAnchor, manifestCodec, machineCode/mars compatibility, logisimPrep, logisimTrace, continuous；覆盖 continuous P7 首失败/取消/展开与部分生成异常的会话所有权清理，以及 terminal/manual/session mismatch 的 fail-closed 保留
  p7ProbeScenarios, p7ProbeMmio, p7ProbePriority, p7ProbeMdu — 五分片多 seed 的完整变体覆盖、实际汇编与 IM/DM 容量；Timer 非法读写、pending 优先级、外部/Timer MDU 的真实汇编执行和损坏 CP0/HI/LO/重试写回负例；模型执行不冒充真实 DUT 的流水线证据

test/mipsCore/, test/mipsCli/, test/mipsHost/, test/mipsProviders/, test/mipsReplay/:
  ISA catalog/encode/decode golden 与 core/LSP/generator 多目标 projection 收敛/--check；有界 JSONL CLI；Worker protocol v2、从 0 连续 sequence、consumer 成功后 ACK、slice 取消与 crash generation；provider preflight immutable request/launch；source graph、ProgramImage、engine trust registry、exact replay/re-evaluate、真实 MARS 可选集成

阶段 6 定向回归:
  courseEnginePolicy/providerResolver — auto/builtin/mars/verify-both 的稳定 id 原子选择、resource snapshot、无 preflight/runtime fallback
  fixedMarsReference — 编译内置信任 role、bytes/SHA-256、symlink/漂移/取消/错误码 fail closed
  assemblerArtifacts/machineCodeValidation — P7 text+gap+ktext 4096-word 投影、重叠/越界/尾零与 legacy 4095 独立 policy
  fullStackShadowRunner/executorShadowRunner — evidence kind 分离、隔离 source closure、双端 image/execution、hash/binding continuity、matched/mismatch/inconclusive bundle
  conformance/mips/test/execution-corpus.test.mjs + phase6-evidence.test.mjs — 250+5 冻结真实执行语料与聚合器负例；`npm run verify:phase6` 运行固定 v0.6.3 assembly-diff 与 course1 real execution differential

进程/兼容证据:
  processCore 覆盖 stdout/stderr raw-byte cap、UTF-8 chunk boundary、timeout/abort 与子孙进程树；`test-cli` 的 legacy-equivalence runner 在 detached provider 迁移前父提交 `044bab0` 与当前 provider 路径间比较 machine code、trace、verdict、halt PC
  scripts/verify-bundled-iverilog*.mjs 从源码树或解包 VSIX 按 host platform/arch 自动选择 win32-x64/darwin-arm64/darwin-x64/linux-x64/linux-arm64 runtime，在隔离 PATH 下验证中文与空格路径的 syntax success/failure、compile/VVP、`$readmemh`/`$display`、watchdog 和代表性课程兼容；Windows 另验证六个原生 EXE 的 UTF-8 manifest/PE metadata，macOS / Linux 的全部 `iverilog` 调用验证 bundled `-B <lib/ivl>`。常规 portability CI 在 Windows 2025 提前执行同一 smoke；release matrix 在 windows-2025、macos-15 arm64、macos-15-intel、ubuntu-24.04、ubuntu-24.04-arm 从各自解包 VSIX 运行 host smoke，公共 `npm test` 只执行一次；fetch-iverilog-corresponding-sources.mjs 合并固定 Windows 与共享 macOS / Linux manifest，按 URL/SHA 去重下载并校验 release 对应源码资产

fixtures:
  syntaxFixtures — fixture测试运行器
  fixtures/syntax/mips/: valid/, invalid/(含JSON期望), course/
  fixtures/syntax/verilog/: valid/, invalid/, course-out/, real-project/

平台打包与构建验证:
  scripts/package-vsix.test.mjs 通过真实 vsce fixture 验证五目标内容裁剪、共享许可/来源/配方保留、中文空格路径及参数失败；release 同一 Test job 执行。每个平台解包检查只保留当前 runtime，Unix 课程 smoke 选择 P7-probe。Linux 手动构建 workflow 在干净 Ubuntu 22.04 容器执行 smoke 并记录实际 ELF 依赖，普通 release 不重复构建或 ABI 扫描。
  首次 Icarus 集成（2026-09-03）：[五个平台最终 VSIX 的原生验证](https://github.com/stone926/BUAA-CO-Toolkit/actions/runs/33656156772) 全部通过；Linux 二进制来自 [Ubuntu 22.04 原生双架构构建](https://github.com/stone926/BUAA-CO-Toolkit/actions/runs/33655749189)。此记录只覆盖打包和 Icarus 层。

真实 VS Code 扩展宿主:
  scripts/verify-extension-host.mjs — @vscode/test-electron 下载当前稳定版，加载最终 VSIX 解包目录；隔离用户配置/其他扩展，创建中文空格工作区，保留日志；本地可用 CO_VSCODE_VERSION 指定排查版本
  scripts/extension-host-smoke.cjs — 四项小型测试：实际扩展激活、DocumentSymbol/LSP 保存 Icarus 错误诊断与修复（包含无关 editor 设置变化不应取消保存检查的回归）、co.verilog.runIsim 命令及输出、co.test.runFullTest 固定 P4 用例的真实 assembler/Worker oracle/Icarus 双侧 golden trace 与报告 Webview；内嵌协议 fixture，不复制完整课程 CPU，不 mock VS Code 或增加生产测试接口
  .github/workflows/extension-platforms.yml — PR/main push/手动五 target 原生验证；.github/actions/verify-extension-package/action.yml 与 release 共用打包、解包、Icarus smoke、真实扩展宿主检查，Linux 用 Xvfb；不逐平台重复全量单元测试，失败上传宿主日志
  首次宿主验证（2026-09-03）：[五个平台最终 VSIX 的真实 VS Code 验证](https://github.com/stone926/BUAA-CO-Toolkit/actions/runs/33659011560) 全部通过；保存诊断回归另以旧 server 失败、新 server 通过作本地对照。

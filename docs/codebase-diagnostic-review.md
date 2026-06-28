### 1. [x] P7 派生边界和 manifest 配置说明仍未完全来自单一资源

完成记录:

- 新增 `p7KernelTextDumpEndAddress`，MARS kernel dump 范围改为从 `resources/co/p7Hardware.json` 派生。
- 新增 `scripts/generate-manifest-config.mjs`，P7 instruction count default/maximum、P7 MARS 说明和内存说明由 P7 硬件资源生成。
- 新增 manifest 生成检查和 P7 常量测试覆盖派生上限、说明和 dump 终点。

剩余证据:

- `src/mips.ts` 的 P7 kernel dump 范围仍写死到 `0x00004ffc`，没有从 `resources/co/p7Hardware.json` 或 `resources/co/courseConfig.json` 的内核段边界派生。
- `package.json` 仍在配置说明中手写 `0x4180`、`1118` 等 P7 课程约束；`resources/co/configDefaults.json` 也保存 `test.builtinGenerator.p7InstructionCount = 1118`，运行时只在 `src/config.ts` 中用 `p7CourseInstructionCountMaximum` 做裁剪。
- 目前已有 `src/courseTesting/p7Hardware.ts`、ASM/Verilog 模板参数化和一致性测试，但没有覆盖 package 配置说明、默认值上限、MARS dump 终点等派生边界。

风险:

- P7 硬件布局调整时，运行时代码大多能跟随资源，但 VS Code 配置页说明、默认生成数量和 MARS kernel dump 边界仍可能漂移。
- P7 最大指令数既是课程硬件约束又是用户可见配置，硬编码在 manifest 说明里会误导用户。

建议:

- 在 `p7Hardware.ts` 或 `courseConfig` 中导出 P7 kernel dump 结束地址、用户段可用指令数、默认/最大生成数量等派生值。
- 让 package 配置说明和默认值校验脚本读取这些派生值，至少新增测试覆盖 `co.test.builtinGenerator.p7InstructionCount`、P7 Mars 说明和 dump 范围。

### 2. [x] 配置 schema、enum 和说明仍由 package.json 手工维护

完成记录:

- 新增 `resources/co/configManifest.json` 作为配置 schema 源。
- `package.json.contributes.configuration` 由 `configManifest.json`、`configDefaults.json`、课程配置、P7 硬件、ASM 生成器 catalog 和 Verilog lint catalog 生成。
- manifest 测试现在运行 `node scripts/generate-manifest-config.mjs --check`，把测试定位为生成结果校验。

剩余证据:

- `resources/co/configDefaults.json` 已成为运行时和 LSP 默认值来源，`src/test/manifest.test.ts` 也会比较 package default 和运行时 default。
- 但 `package.json` 中 `contributes.configuration` 的 schema、enum、description、minimum/maximum 仍是手写内容。
- Profile enum、lint disabled rule enum、P7/generator 说明等依赖其它资源的字段靠测试发现漂移，而不是生成得到。

风险:

- 新增配置项时仍要同时改资源、package schema、描述文案和测试。
- 测试可以发现 default 漂移，但不能保证文案、范围、enum 和运行时约束完全一致。

建议:

- 建立配置 schema 源或生成脚本，生成 `package.json.contributes.configuration` 中的 default、enum、范围和说明。
- 保留 manifest 测试作为生成结果校验，而不是唯一防线。

### 3. [x] Profile manifest enum 和推断 fallback 仍有重复来源

完成记录:

- `co.project.profile` enum/enumDescriptions 已由 `resources/co/courseConfig.json` 生成。
- `src/profileResolver.ts` 移除 `fallbackP7ExclusivePorts`、`fallbackP6RequiredPorts`、`fallbackTopModuleNames`、`fallbackP7Structure` 等重复数组；资源缺失时对应推断规则为空，不再隐藏资源缺失。
- `profileResolver` 测试改为从 `courseConfig.profileInference` 读取端口规则，并校验资源中的推断 hint 非空。

剩余证据:

- `resources/co/courseConfig.json` 已包含 `capabilities`、`defaults`、`profileInference`、端口规范和 trace format。
- `src/constants.ts` 已从 `courseConfig` 推导 Profile 分组，`src/extension.ts`/sidebar 展示也改用 `getProfileName()`。
- 但 `package.json` 的 `co.project.profile` enum 仍手写，只由测试对齐。
- `src/profileResolver.ts` 仍保留 `fallbackP7ExclusivePorts`、`fallbackP6RequiredPorts`、`fallbackTopModuleNames`、`fallbackP7Structure` 等兜底数组，和 `courseConfig.json` 中的 profileInference 规则重复。

风险:

- Profile 名称和能力已基本单源，但 manifest enum 与 fallback 推断规则仍可能在资源更新时滞后。
- fallback 规则一旦被实际使用，可能隐藏资源缺失或资源更新未同步的问题。

建议:

- 由 `courseConfig.json` 生成 `co.project.profile` enum。
- 将 `profileResolver.ts` 的 fallback 缩小到“资源缺失时报错或空规则”，或把 fallback 与资源一致性纳入测试。

### 4. Verilog/P7 testbench 已模板化，但 probe/legacy 分支仍混在 TypeScript 和模板中

剩余证据:

- `resources/templates/verilog/` 和 `src/templates/templateRegistry.ts` 已存在，基础 testbench、external memory testbench、P7 official/probe/interrupt block 已移出大段 TS 字符串。
- `src/language/verilog/moduleUtils.ts` 仍用 TypeScript 拼接 `externalScenarioCases`，并按 `armAddress === 0` 写入 `co_p7_external_legacy`。
- `resources/templates/verilog/p7_probe_block.v` 仍同时包含正常 arm 流程和 legacy 外部中断流程。
- `moduleUtils.ts` 仍有非 P7 external memory 的本地 `courseMemoryWords = 4096`，没有从课程配置读取。

风险:

- P7 probe 的场景渲染仍难以作为完整 Verilog 模板审阅和 diff。
- legacy 行为和当前 probe 行为耦合，修改 probe 时仍可能影响旧兼容路径。
- 非 P7 external memory 容量仍可能和课程配置漂移。

建议:

- 将 probe scenario case 渲染也下沉为模板列表块或受控 partial。
- 把 `co_p7_external_legacy` 拆成独立 legacy 模板或显式 feature flag，并记录移除条件。
- 将非 P7 external memory 容量从 `courseConfig` 或专门硬件 profile 读取。

### 5. 报告页面 shell 已统一，但正文和表格 cell 仍依赖调用方手工转义

剩余证据:

- `src/webview/reportLayout.ts` 已统一 `renderReportPage()`、CSS、metric、table 和 `html.text/code/path` helper。
- `renderReportPage({ body: string })` 仍接收完整 HTML 字符串。
- `renderTable()` 的 `cells` 仍是已转义 HTML 字符串，调用方在 `src/courseTestReport.ts`、`src/traceCompare.ts`、`src/hazard.ts`、`src/extension.ts` 中手工组合 `<div>`、`<code>` 并调用 `escapeHtml()`。

风险:

- 新报告仍可能漏转义，`renderTable()` 无法区分纯文本 cell 和已转义 HTML cell。
- 后续如果加入 CSP、资源 URI 或少量脚本，仍需要审计所有业务渲染函数。

建议:

- 将报告 body 改成结构化 section model，或引入明确的 `SafeHtml`/`RawHtml` 类型边界。
- `renderTable()` 支持 `{ kind: 'text' | 'code' | 'html', value }` cell model，默认文本转义。

### 6. [x] ASM 生成器 catalog 已资源化，但配置说明仍手写默认指令集

完成记录:

- `co.test.builtinGenerator.instructions` 的配置说明改由 `resources/mips/generatorProfiles.json` 生成。
- manifest 测试逐个校验说明中列出的 Profile 默认指令集与 catalog 一致。

剩余证据:

- `resources/mips/generatorProfiles.json` 已保存默认 profile 指令集、分类、访存对齐、MDU 周期。
- `src/courseTesting/generatorInstructionCatalog.ts` 会加载并校验该资源，`src/courseTesting/mnemonicSets.ts` 只是兼容包装。
- `package.json` 中 `co.test.builtinGenerator.instructions` 的 description 仍手写 P3-P7 默认指令集长列表。

风险:

- 生成器默认指令集调整后，配置页说明可能和实际行为不一致。

建议:

- 从 `generatorProfiles.json` 生成 `co.test.builtinGenerator.instructions` 的说明文本。
- 增加 manifest 测试，确保说明里列出的 profile 指令集与 catalog 一致，或避免在 package 文案中展开完整列表。

### 7. [x] Verilog lint catalog 尚未成为规则文案、manifest enum 和文档的完整单一来源

完成记录:

- `co.verilog.lint.disabledRules` default/enum 已由 `resources/verilog/lintRules.json` 生成，settings normalization 也只接受 catalog 中可配置规则。
- `lintDiagnostics.ts` 的 VC/synth 诊断 severity 通过 lint catalog 注入，检测逻辑保留局部上下文 message。
- 新增 `scripts/generate-diagnostic-catalog.mjs`，生成 `docs/diagnostic-catalog.md` 的 Verilog lint catalog 段，并新增测试防止文档漂移。

剩余证据:

- `resources/verilog/lintRules.json` 已保存 lint rule metadata。
- `src/language/verilog/lintRuleCatalog.ts` 已从 catalog 推导 configurable/default disabled rule ids，`src/test/manifest.test.ts` 校验 package enum/default。
- 但 `package.json` 的 enum 仍手写。
- 规则实现和部分诊断文案仍在 `src/language/verilog/lintDiagnostics.ts` 中维护。
- `docs/diagnostic-catalog.md` 仍是独立文档，需要人工保持同步。

风险:

- 新增或废弃 lint rule 时，catalog、实现、package enum、QuickFix、诊断文档仍可能不同步。

建议:

- 由 lint catalog 生成 package enum 和 diagnostic catalog 中的 VC 规则表。
- 将 rule title/severity/doc text 尽量从 catalog 注入诊断实现，lintDiagnostics 只保留检测逻辑。

### 8. Verilog LSP service 仍是 provider 大文件

剩余证据:

- `src/language/verilog/service.ts` 仍约 1500 行。
- 该文件仍同时包含 completion facade、hover、definition/reference、rename、code actions、signature help、inlay hints、markdown 展示、instance connection context、symbol resolution 和引用收集 helper。
- MIPS 侧 provider 拆分更细，Verilog 侧只有 completion provider 已独立。

影响:

- Verilog hover/navigation/code action/inlay 修改仍容易互相影响。
- 共用的 `resolveVerilogSymbol`、markdown 展示和引用收集逻辑不便单独测试。

建议拆分:

- `hover.ts`
- `navigation.ts`
- `rename.ts`
- `codeActions.ts`
- `signatureHelp.ts`
- `inlayHints.ts`
- `display.ts`
- `resolveSymbol.ts`
- `service.ts` 只保留 re-export 和 provider 聚合。

### 9. Verilog ISim orchestration 仍有 compile/run 核心留在入口文件

剩余证据:

- `src/verilog.ts` 已拆到约 400 行，并已抽出 `src/verilog/iseProject.ts`、`src/verilog/testbenchResolver.ts`、`src/verilog/simulationInputs.ts`。
- 但 `runIsim()`、`compileIsim()`、`prepareIsimRunInputs()`、`ensureSimulationAsmCase()` 仍在 `src/verilog.ts`。
- 尚无 `src/verilog/isimRunner.ts`，ISim 编译缓存、fuse 调用、run tcl、输出落盘和 ASM case artifact 记录仍集中在入口模块。

影响:

- `src/verilog.ts` 仍同时承担命令注册、用户交互、编译、运行和 case 记录。
- 波形/VCD 功能继续通过入口文件内部 `compileIsim` 闭包耦合。

建议拆分:

- 新增 `src/verilog/isimRunner.ts`，承接 `runIsim()`、`compileIsim()`、`prepareIsimRunInputs()`。
- `src/verilog.ts` 保留 command entry、lint 禁用、用户 testbench 生成和依赖装配。

### 10. 文件选择和路径工具只完成了部分收敛

剩余证据:

- `src/workflowInputs.ts` 已有 `resolveWorkspaceFile()`、`resolveWorkspaceFiles()`、`pickOneFile()`。
- `src/pathUtils.ts` 已有 `normalizePathKey()`、`samePath()`、`dedupePaths()`、`dedupeUris()`、`sanitizeFileStem()`。
- 但以下模块仍各自维护 active editor、workspace `findFiles`、QuickPick/openDialog 或候选排序组合逻辑:
  - `src/asmCaseStore.ts` 的 `resolveAsmCaseInput()`
  - `src/courseTesting/generatorWorkflow.ts` 的生成器文件选择
  - `src/traceCompare.ts` 的 trace pair/report 选择
  - `src/hazard.ts` 的机器码/工程定位
  - `src/verilog/testbenchResolver.ts` 的 testbench 候选扫描和排序
- `src/courseTesting/logisimPrep.ts` 仍有局部 `sanitizeFileStem()` wrapper，需确认是否可以完全复用 `pathUtils` 行为。

影响:

- 不同工作流在多工作区、active file 优先级、排除目录、候选排序和取消行为上仍可能不一致。
- 后续新增工作流时仍容易复制选择逻辑。

建议:

- 扩展 `workflowInputs.ts` 的选项，覆盖单选、多选、active file、workspace folder 限定、候选 rank、fallback openDialog。
- 将剩余工作流逐步迁移到统一 resolver。
- 保留特殊排序策略时，将 rank 函数作为参数传入，而不是复制整套 UI 流程。

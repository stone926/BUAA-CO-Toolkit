# test-suite | src/test/ | 192 files | 框架: Vitest

单元/集成测试, 镜像src/结构. npm test = vitest run. 以下为<name>.test.ts

test/:
  manifest, advancedToolModel, asmCaseStoreCore, sidebarModel, verilogIsimCache, verilogIsimOutput, verilogSimulationFiles, python, toolchain, courseConfig, courseTestToolchain, courseTestCases, courseTestStdin, courseTestLogisim, courseTestReport, profileResolver

test/language/common/:
  settings, diagnosticActions, lsp, util, documentResultCache, semanticTokens

test/language/mips/:
  parser, syntax, instructionValidation, semantic, resources, hover, formatting, traceParser, traceCompare, realProjectPatterns, completions, signatureHelp

test/language/verilog/:
  syntaxDiagnostics, widthDiagnostics, usageDiagnostics, workspaceDiagnostics, iseSyntaxCheck, semanticModel, parser, formatting, folding, traceParser, cst, model, workspaceModuleRegistry, completions, semanticTokens, crossFileSemantic, signalWiring, taskDeclarations, parseCache, workspaceIndex, expressionAstLsp, realProjectPatterns, performance, constantDivisorDiagnostics, selectBoundsDiagnostics, parameterOverrideDiagnostics, assignmentDiagnostics, lintRules

TextMate:
  使用 vscode-textmate + vscode-oniguruma 逐行 tokenizeLine 并保留 ruleStack，覆盖未闭合字符串不跨行、scope 边界、catalog 同步及课程真实宏/数字片段

test/language/logisim/:
  service, rom, realProjectPatterns

test/courseTesting/:
  builtinAsmGenerator, generator, mipsUtil, p7ProbeCheck, p7InterruptAnchor, manifestCodec, machineCode/mars compatibility, logisimPrep, logisimTrace, continuous

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

fixtures:
  syntaxFixtures — fixture测试运行器
  fixtures/syntax/mips/: valid/, invalid/(含JSON期望), course/
  fixtures/syntax/verilog/: valid/, invalid/, course-out/, real-project/

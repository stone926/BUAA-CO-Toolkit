# test-suite | src/test/ | 159 files | 框架: Vitest

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

进程/兼容证据:
  processCore 覆盖 stdout/stderr raw-byte cap、UTF-8 chunk boundary、timeout/abort 与子孙进程树；`test-cli` 的 legacy-equivalence runner 在 detached provider 迁移前父提交 `044bab0` 与当前 provider 路径间比较 machine code、trace、verdict、halt PC

fixtures:
  syntaxFixtures — fixture测试运行器
  fixtures/syntax/mips/: valid/, invalid/(含JSON期望), course/
  fixtures/syntax/verilog/: valid/, invalid/, course-out/, real-project/

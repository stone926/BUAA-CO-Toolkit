# test-suite | src/test/ | ~70 files | 框架: Vitest

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
  builtinAsmGenerator, generator, mipsUtil, p7ProbeCheck, logisimPrep, logisimTrace, continuous

fixtures:
  syntaxFixtures — fixture测试运行器
  fixtures/syntax/mips/: valid/, invalid/(含JSON期望), course/
  fixtures/syntax/verilog/: valid/, invalid/, course-out/, real-project/

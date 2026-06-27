# test-suite | src/test/ | ~70 files | 框架: Vitest

单元/集成测试, 镜像src/结构. npm test = vitest run

test/:
  manifest.test.ts, advancedToolModel.test.ts, asmCaseStoreCore.test.ts, sidebarModel.test.ts, verilogIsimCache.test.ts, verilogIsimOutput.test.ts, verilogSimulationFiles.test.ts, python.test.ts, toolchain.test.ts, courseConfig.test.ts, courseTestToolchain.test.ts, courseTestCases.test.ts, courseTestStdin.test.ts, courseTestLogisim.test.ts, courseTestReport.test.ts, profileResolver.test.ts

test/language/common/:
  settings.test.ts, diagnosticActions.test.ts, lsp.test.ts, util.test.ts

test/language/mips/:
  parser.test.ts, syntax.test.ts, instructionValidation.test.ts, semantic.test.ts, resources.test.ts, hover.test.ts, formatting.test.ts, traceParser.test.ts, traceCompare.test.ts, realProjectPatterns.test.ts, completions.test.ts, signatureHelp.test.ts

test/language/verilog/:
  syntaxDiagnostics.test.ts, widthDiagnostics.test.ts, usageDiagnostics.test.ts, workspaceDiagnostics.test.ts, iseSyntaxCheck.test.ts, semanticModel.test.ts, parser.test.ts, formatting.test.ts, folding.test.ts, traceParser.test.ts, cst.test.ts, model.test.ts, workspaceModuleRegistry.test.ts, completions.test.ts, semanticTokens.test.ts, crossFileSemantic.test.ts, signalWiring.test.ts, taskDeclarations.test.ts, parseCache.test.ts, workspaceIndex.test.ts, expressionAstLsp.test.ts, realProjectPatterns.test.ts, performance.test.ts, constantDivisorDiagnostics.test.ts, selectBoundsDiagnostics.test.ts, parameterOverrideDiagnostics.test.ts, assignmentDiagnostics.test.ts, lintRules.test.ts

test/language/logisim/:
  service.test.ts, rom.test.ts, realProjectPatterns.test.ts

test/courseTesting/:
  builtinAsmGenerator.test.ts, generator.test.ts, mipsUtil.test.ts, p7ProbeCheck.test.ts, logisimPrep.test.ts, logisimTrace.test.ts, continuous.test.ts

fixtures:
  syntaxFixtures.test.ts — fixture测试运行器
  fixtures/syntax/mips/: valid/, invalid/(含JSON期望), course/
  fixtures/syntax/verilog/: valid/, invalid/, course-out/, real-project/
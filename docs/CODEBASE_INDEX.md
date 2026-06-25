### Core Entry Points
- Extension Activation: `src/extension.ts` - Main entry, registers all features
- Language Server: `src/server.ts`, `src/languageClient.ts` - LSP infrastructure

### Language Support Modules

#### MIPS Assembly (`src/language/mips/`)
service.ts          # LSP feature registration
parser.ts           # ASM parser orchestration over AST
syntax.ts           # Parsed source API; macro argument nodes; deprecated parseOperands/MipsCst wrappers live here
ast.ts              # MIPS AST with typed operands, label+immediate expressions, data continuations, macro args, .eqv, and .macro headers
operandReferences.ts # Operand AST reference visitor
semantic.ts         # Semantic analysis, symbol resolution
completions.ts      # Code completion provider
hover.ts            # Hover information provider
navigation.ts       # Go to definition, find references
formatting.ts       # Code formatter
diagnostics via:
  └─ syntax.ts, parser.ts (lexical/line/directive diagnostics), instructionValidation.ts (AST operands), semantic.ts
traceParser.ts      # Parse MARS coL1 trace output
traceCompare.ts     # Trace comparison logic

#### Verilog (`src/language/verilog/`)
service.ts          # LSP feature registration
parser.ts           # Main parser entry
lexer.ts            # Tokenizer
statementParser.ts  # Statement source slicing from token stream
astParser.ts        # Module/declaration/instance parser
ast.ts              # Abstract syntax tree, including module subroutines and parsed-instance statement classification
exprAst.ts          # Expression AST
gatePrimitives.ts   # Built-in gate primitive keyword helper shared by AST and syntax diagnostics
proceduralAst.ts    # Procedural statement AST with control/assignment/local declaration expression metadata
blockAst.ts         # Always/initial block extraction, sensitivity AST, and header control AST
syntaxParser.ts     # Syntax tree/diagnostics; module item discovery consumes AST structures
tokenUtils.ts       # Token helper boundary for parser/syntax fallback
cst.ts              # Deprecated legacy compatibility wrapper, not the main parser path
semanticModel.ts    # Symbol tables, scope analysis, AST-backed reference collection
semanticTokens.ts   # Semantic highlighting
formatting.ts       # Code formatter
folding.ts          # Code folding ranges

Diagnostics (9 types):
  syntaxDiagnostics.ts           # Syntax errors
  driverDiagnostics.ts           # Multiple drivers
  dataflowDiagnostics.ts         # Width mismatches
  instanceConnectionDiagnostics.ts  # Port connections
  usageDiagnostics.ts            # Unused signals
  lintDiagnostics.ts             # Course lint rules (VC-001~022), mostly AST/model backed including procedural expression visitors
  assignmentAnalysis.ts          # Assignment analysis
  iseSyntaxCheck.ts              # ISE fuse integration
  workspaceDiagnostics.ts        # Cross-file checks

Cross-file analysis:
  workspaceModuleRegistry.ts  # Background .v file indexer
  workspaceIndex.ts           # Module database
  signalWiring.ts             # Signal connection analysis
  
traceParser.ts      # Parse ISim $display output

#### Logisim (`src/language/logisim/`)
service.ts          # Logisim file analysis
rom.ts              # ROM generation/injection logic

## Feature Implementation Modules

### MIPS Operations (`src/mips.ts`)
- Run ASM in terminal
- Dump machine code (HexText format)
- P7 kernel text merge (0x4180 exception handler)

### Verilog Operations (`src/verilog.ts`)
- Generate ISE project (.prj, .tcl)
- Run ISim simulation
- Generate testbench
- ISE syntax check integration
- Manage machine code loading

### Logisim Operations (`src/logisim.ts`)
- Open circuit in Logisim
- Generate ROM file
- Inject ROM into circuit
- Convert log to CSV

### Trace Comparison (`src/traceCompare.ts`)
- Compare two trace files
- Find first difference
- Generate HTML report

### Hazard Analysis (`src/hazard.ts`)
- Integrate with Hazard-Calculator.jar
- Prepare test case ZIP
- Parse analysis report
- Display coverage statistics

## Course Testing System

### Test Orchestration
courseTest.ts           # Main test coordinator
courseTestCases.ts      # Test case management
courseTestContinuous.ts # Continuous testing loop
courseTestMessages.ts   # User notifications
courseTestReport.ts     # Report generation
courseTestToolchain.ts  # Tool invocation helpers
courseTestLogisim.ts    # P3 Logisim testing
courseTestStdin.ts      # stdin file handling
courseTestTraceFiles.ts # Trace file operations

### Test Generation (`src/courseTesting/`)
builtinAsmGenerator.ts  # Main generator entry
generator.ts            # Core generation logic
cpuState.ts             # Internal CPU state model
mnemonicSets.ts         # Instruction sets per profile
random.ts               # Random utilities
mipsUtil.ts             # MIPS helper functions

P7 specific:
  builtinAsm/p7/
    probeAsm.ts         # Probe mode ASM generation
    probeEmitter.ts     # Handler code generation
    probeScenarios.ts   # Interrupt/Timer scenarios
    constants.ts        # P7 constants
    
Logisim:
  logisimPrep.ts        # Prepare Logisim cases
  logisimTrace.ts       # Parse Logisim output
  p7ProbeCheck.ts       # P7 probe log validation

### ASM Case Storage (`src/asmCaseStore.ts`, `src/asmCaseStoreCore.ts`)
- Case metadata management
- Artifact storage (.co/cases/<id>/)
- SHA256 checksums
- Manifest JSON generation

## Project Management

### Profile System
config.ts               # Configuration access
courseConfig.ts         # Profile definitions (P0-P7)
projectProfile.ts       # Profile API
profileInference.ts     # Auto-detect profile
profileResolver.ts      # Profile resolution logic

### UI Components
sidebar.ts              # TreeView provider
sidebarModel.ts         # Sidebar data model
wizard.ts               # Project creation wizard
advancedTools.ts        # Tool menu
advancedToolModel.ts    # Tool categorization

### Verilog-specific UI
verilogSignalView.ts    # Signal wiring panel
verilogWaveform.ts      # Waveform viewer integration
verilogSimulationFiles.ts  # Simulation file management
verilogIsimOutput.ts    # ISim output parsing

### Utilities
toolchain.ts            # Tool detection and validation
semanticColors.ts       # Semantic token coloring
semanticColorPresets.ts # Color presets (dark/light)
courseLinks.ts          # Tutorial link generation
fsUtil.ts               # File system helpers
process.ts              # Process spawning
python.ts               # Python detection

## Resource Files

### JSON Resources (`resources/`)
mips/
  instructions.json       # MIPS instruction metadata
  pseudoExpansions.json   # Pseudo-instruction expansions
  pseudoForms.json        # Pseudo-instruction forms
  registers.json          # Register names and descriptions
  cp0Registers.json       # CP0 register metadata
  directives.json         # Assembler directives
  syscalls.json           # System call table
  
verilog/
  keywords.json           # Verilog keywords
  
co/
  courseConfig.json       # Course profile definitions

### Language Configuration
language-configuration/
  mipsasm.json            # MIPS bracket pairs, comments
  verilog.json            # Verilog bracket pairs, comments
  
syntaxes/
  mips.tmLanguage.json    # TextMate grammar (syntax highlighting)
  verilog.tmLanguage.json # TextMate grammar
  
snippets/
  mipsasm.json            # Code snippets
  verilog.json            # Code snippets

## Syntax Coverage Assets

### Documentation
docs/diagnostic-catalog.md       # Stable built-in diagnostic code catalog
docs/syntax-coverage-matrix.md   # MIPS/Verilog course subset and course-out coverage matrix
CO_SUBSET_SYNTAX_COVERAGE_PLAN.md # Long-running implementation checklist and completion status

### Fixture Tests
src/test/language/syntaxFixtures.test.ts # Fixture runner for valid/invalid syntax samples
src/test/fixtures/syntax/
  mips/
    valid/      # MIPS samples that must not produce syntax-blocking diagnostics
    invalid/    # MIPS samples with JSON code/line expectations
    course/     # Course-pattern MIPS samples
  verilog/
    valid/      # Verilog samples that must not produce syntax-* diagnostics
    invalid/    # Verilog samples with JSON code/line expectations
    course-out/ # Course-out Verilog samples asserting info-level classification, not syntax errors
    real-project/ # Larger real project patterns

## Key Architectural Patterns

### Language Service Pattern
Each language (MIPS/Verilog) follows:
1. Parser → AST
2. Semantic Model → Symbol tables, scopes
3. Service → Register LSP providers (completion, hover, diagnostics, etc.)
4. Client/Server → LSP protocol communication

### Test Workflow Pattern
Generate/Select ASM
  ↓
MARS dump machine code
  ↓
MARS run (golden trace) [P3-P7 anchor mode]
  ↓
ISim/Logisim run (student CPU)
  ↓
Parse outputs → Trace comparison
  ↓
Generate report

### P7 Test Modes
- anchor: MARS + ISim synchronized, precise trace comparison
- probe: CPU writes probe log to DM 0x2800, property checking
- hybrid: Generate both anchor + probe cases
- off: No interrupt/exception testing

### Workspace Module Registry (Verilog)
- Background indexer scans all .v files
- Builds module database (ports, signals, parameters)
- Enables cross-file features (signal wiring, instance validation)
- Incremental updates on file change

## Finding Code by Feature

| Feature | Primary Files |
|---------|--------------|
| MIPS code completion | `src/language/mips/completions.ts` |
| MIPS diagnostics | `src/language/mips/syntax.ts`, `instructionValidation.ts`, `semantic.ts` |
| Verilog parsing | `src/language/verilog/parser.ts`, `lexer.ts`, `statementParser.ts`, `astParser.ts`, `ast.ts`, `exprAst.ts`, `proceduralAst.ts` |
| Verilog Lint rules | `src/language/verilog/lintDiagnostics.ts` |
| Verilog formatting | `src/language/verilog/formatting.ts` |
| Signal wiring analysis | `src/language/verilog/signalWiring.ts`, `src/verilogSignalView.ts` |
| ISE integration | `src/verilog.ts`, `src/language/verilog/iseSyntaxCheck.ts` |
| ISim runner | `src/verilog.ts` (runIsim function) |
| Testbench generation | `src/verilog.ts` (generateTestbench function) |
| Trace parsing (MIPS) | `src/language/mips/traceParser.ts` |
| Trace parsing (Verilog) | `src/language/verilog/traceParser.ts` |
| Trace comparison | `src/traceCompare.ts` |
| Random ASM generation | `src/courseTesting/builtinAsmGenerator.ts`, `generator.ts` |
| P7 interrupt testing | `src/courseTesting/builtinAsm/p7/probeScenarios.ts` |
| P7 probe handler | `src/courseTesting/builtinAsm/p7/probeEmitter.ts` |
| Continuous testing | `src/courseTestContinuous.ts`, `src/courseTesting/continuous.ts` |
| Logisim ROM inject | `src/language/logisim/rom.ts` |
| P3 Logisim testing | `src/courseTestLogisim.ts` |
| Hazard analysis | `src/hazard.ts` |
| Profile detection | `src/profileInference.ts`, `src/profileResolver.ts` |
| Toolchain check | `src/toolchain.ts` |
| Sidebar | `src/sidebar.ts`, `src/sidebarModel.ts` |
| Project wizard | `src/wizard.ts` |

## Configuration Schema

Configuration lives in `package.json` under `contributes.configuration`.

Key config groups:
1. co.project.* - Project settings (profile, topModule, testbench, machineCode, simTime)
2. co.toolchain.* - Tool paths (java, python, mars, marsP7, logisim, isePath, hazardCalculator)
3. co.test.* - Testing config (generator, continuous, p7, logisim)
4. co.mips.* - MIPS editor settings (delayedBranching, memoryConfiguration, warnPseudoInstruction)
5. co.verilog.* - Verilog editor settings (lint, format, syntax, implicitNet)
6. co.run.* - Execution settings (timeoutMs, revealOutput, showCommandBeforeRun)
7. co.semanticColors.preset - Semantic token coloring
8. co.diagnostics.disabled* - Disable diagnostics

## Extension Commands

All commands start with `co.` prefix. Defined in `package.json` under `contributes.commands`.

Command registration happens in:
- `src/extension.ts` - Core commands (checkToolchain, selectProjectProfile, projectWizard)
- `src/mips.ts` - MIPS commands (run, dump, etc.)
- `src/verilog.ts` - Verilog commands (ISim, testbench, etc.)
- `src/logisim.ts` - Logisim commands (open, inject, etc.)
- `src/courseTest.ts` - Test commands
- `src/hazard.ts` - Hazard analysis commands
- `src/traceCompare.ts` - Trace comparison commands

## Code Quality Notes

### Patterns to Follow
- Immutable data structures where possible
- Functional style for parsers and transformers
- LSP protocol for all language features
- Async/await for I/O operations
- Proper error handling with try-catch and user-friendly messages

### Performance Considerations
- Incremental parsing (cache parse results)
- Workspace module registry updates incrementally
- Toolchain status caching
- Debounced UI updates

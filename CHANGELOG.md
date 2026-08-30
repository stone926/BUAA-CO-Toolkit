# Change Log

All notable changes to BUAA CO Toolkit are documented in this file.

## [Unreleased]

## [1.0.4] - 2026-08-30

- fix(ci): make bundled-runtime and replay source-graph tests portable across Linux and Windows path representations
- fix(ci): decouple the headless test CLI from VS Code language-client command glue and compile only its import closure

## [1.0.3] - 2026-08-30

- feat(verilog): bundle Icarus Verilog 13.0 and its Windows x64 runtime dependencies for compiler-level syntax checks and course simulation without a separate ISE/MSYS2 install
- feat(verilog): select bundled Icarus when `co.toolchain.isePath` is empty and retain fuse/ISim as the explicit ISE opt-in, with no silent fallback for invalid non-empty paths
- feat(verilog): keep ISE project, ISim waveform, and existing VCD commands as ISE-only capabilities
- fix(verilog): support nested source-tree includes, serialize shared Icarus workspace artifacts, and keep generated course testbenches compatible with custom machine-code filenames
- breaking(config): replace `co.verilog.syntax.ise.enabled/mode/timeoutMs` with `co.verilog.syntax.external.mode/timeoutMs`; ignore the removed `co.project.simBackend` setting
- chore(release): publish a single verified `win32-x64` VSIX artifact to both Marketplace and GitHub Releases, including bundled-runtime licenses, notices, and verified corresponding-source archives

## [1.0.2] - 2026-08-13

- fix(course-testing): target stable Mars v0.6.3 (a026eab)

## [1.0.1] - 2026-08-12

- refactor(highlighting)!: delegate semantic colors to VS Code (661dc00)
- feat(highlighting): rebuild syntax and semantic coloring (42c9c8a)
- fix(verilog): preserve ISE project compilation order (57173f5)
- docs: 移除冗余审查文档 (0bcc7bc)
- fix(course-testing): align automatic tests with course semantics (27b73ce)
- fix(verilog): expand begin completion to block (23f90d6)
- feat(verilog): filter noisy ISE port warnings (314b4e1)

## [1.0.0] - 2026-07-03

- 微调默认指令集 (98aa6c0)
- 微调默认指令集 (27f6bf8)
- chore: keep setting descriptions user-facing (a0643f2)
- 修改p7测试配置默认值 (d3f2c04)
- 修改p7测试配置默认值 (0c9ec4f)
- chore: improve generator instruction setting description (c74f3a5)
- chore: regroup vscode settings (9e5fd5c)
- 修改p7测试配置默认值 (1604093)
- refactor: remove Verilog format style preset (ba660d2)
- fix: remove Verilog alignment legacy fallback (5347a36)
- fix: group Verilog alignment settings (b027db5)
- fix: align ternary chains after inline assign branch (97f88f6)
- feat: configure Verilog ternary alignment (983c30d)
- feat: align multiline Verilog ternary chains (f036501)
- fix: make Verilog port alignment idempotent (f966114)
- fix: align Verilog module port ranges (2a4ac08)
- chore: prune unused npm scripts (a52d2b4)
- chore: sync manifest config in workflows (eeb72c8)
- fix: 修改配置分组的名称 (07121c2)
- feat: add configurable Verilog formatter alignment (0f378e6)

## [0.7.1] - 2026-06-28

- fix: normalize ISim paths across CI platforms (54d548b)

## [0.7.0] - 2026-06-28

- 移除中间产物 (e651452)
- docs: align diagnostic coverage docs (82f7b84)
- test: make new verilog tests ci portable (2922576)
- chore: ignore local agent state (0cb5964)
- test: strengthen plugin behavior coverage (a77d465)
- refactor: split verilog service and isim runner (bca6a3b)
- fix: consolidate reports templates and file inputs (ff52214)
- fix: source profile and lint metadata from catalogs (8a9b241)
- fix: derive manifest config from course resources (f212c6a)
- doc: Update INDEX (7b7d247)
- perf: speed up semantic token startup (088061c)
- fix: keep original template extensions (e150cda)
- fix: centralize generated text templates (1964179)
- fix: centralize workspace file selection (0fda59e)
- fix: split course trace batch runner (a2e3db6)
- fix: split course trace runner (5933195)
- fix: split verilog testbench resolution (d74ad66)
- fix: split verilog simulation inputs (c42ec5b)
- fix: render p7 probe asm from templates (e6a1cbf)
- fix: render generic verilog testbenches from templates (6ff4079)
- fix: render wizard starter files from templates (6771ac0)
- fix: split verilog lsp providers (80c67f9)
- fix: split verilog ise project generation (d2b7f87)
- fix: split course test generator workflow (d56d90e)
- fix: render p7 testbench from templates (13feb6f)
- fix: load profile inference hints from course config (5a71a86)
- test: track deprecated compatibility exports (672b76d)
- fix: reuse document result cache for parsers (fc1d94c)
- fix: remove redundant activation events (410458a)
- fix: remove legacy case sidecar metadata (6472b54)
- fix: share process execution core (7eccca1)
- fix: share webview report layout (7e42990)
- fix: centralize path utilities (68f4f9a)
- fix: load logisim trace profile from course config (fae8320)
- fix: load asm generator profiles from resources (5a0550e)
- fix: add verilog lint rule catalog (1ae634a)
- fix: derive profile capabilities from course config (d5e1b4d)
- fix: centralize configuration defaults (8ed0146)
- fix: centralize P7 hardware constants (425b341)
- doc: update index (5aff185)
- doc: update index (d9b3433)
- refactor: extract P7 exception handler ASM to resource .asm files (b9c2971)
- refactor: externalize expectedPorts and trace format patterns to courseConfig.json (e1e27e4)
- refactor: replace hardcoded .co path strings with CO_* constants (5f232dc)
- refactor: centralize all 48 command IDs into Commands object (40588e2)
- refactor: centralize profile groups and path constants in src/constants.ts (095bf39)
- refactor: eliminate P7 constant duplication between constants.ts and randomBody.ts (884d6f1)
- refactor: extract buildMarsArgs to dedicated marsArgs.ts module (bcdcd89)
- test: strengthen test coverage for hardcoded values (TDD Phase 0) (d6f45a4)
- refactor(asm): 伪指令数据驱动 (bc55518)
- doc: 多级索引 (c514db5)

## [0.6.0] - 2026-06-25

- chore: tighten VSIX package ignore rules (170a777)
- test(verilog): cover syntax boundaries and performance (ff4d27e)
- test(mips): cover instruction and directive syntax matrix (96946b9)
- fix(verilog): support generate and course-out syntax diagnostics (868d648)
- fix(mips): report lexical and malformed line diagnostics (14be7a8)

## [0.5.1] - 2026-06-24

- fix(test): compact continuous test artifacts (c3c7048)

## [0.5.0] - 2026-06-24

- fix(verilog): stabilize workspace module diagnostics (9934b1b)
- fix: align course diagnostics with real projects (f375bd1)
- fix: reduce Verilog real-project diagnostic noise (2a33821)
- refactor: model verilog gate primitives in ast (bd0d25c)
- refactor: use verilog ast for syntax module items (56c0466)
- refactor: mark legacy parser helpers deprecated (6fae97e)
- refactor: use ast operands in mips display helpers (1e4afd3)
- refactor: use ast operands in mips instruction validation (a36d553)
- refactor: remove verilog procedural other token fallback (85a8093)
- refactor: expose partial verilog statement expressions (db1d68c)
- refactor: classify verilog instances from ast (8208cd5)
- refactor: use procedural assignment ast references (e7771de)
- refactor: visit verilog procedural expressions in lint (c2ab9fa)
- refactor: model verilog local declaration expressions (3083d27)
- refactor: model verilog loop controls in ast (41ad395)
- refactor: model verilog block controls in ast (967f776)
- refactor: use verilog declaration initializer ast references (43c5510)
- refactor: expose verilog local declarations in ast (7364e4b)
- refactor: model verilog subroutines in ast (0f576ce)
- refactor: model mips label offsets in ast (8fc2459)
- refactor: parse mips data continuations in ast (d6964b7)
- refactor: expose mips macro headers in ast (0261df8)
- refactor: expose mips eqv directives in ast (2947244)
- refactor: expose mips macro arguments in ast (b038732)
- refactor: validate mips directives from ast operands (ce783a6)
- refactor: model verilog sensitivity lists in ast (18f822d)
- refactor: check sequential assignment style via ast (1e6ef74)
- refactor: check combinational assignment style via ast (22ae845)
- refactor: check verilog clock data via ast (12a8ffd)
- refactor: detect verilog testbench clocks from ast (77206f6)
- refactor: move verilog token ranges out of cst (158fcca)
- refactor: keep mips parser operand checks on ast (1d17fef)
- refactor: resolve mips display operands from ast (0062c57)
- refactor: use mips ast integer operands in validation (b129c4c)
- refactor: make mips parsed source types primary (d0f4cd4)
- refactor: expose mips parsed source API (b722c21)
- refactor: lex verilog parser with trivia (eab383c)
- refactor: lex verilog expressions without cst mode (0483189)
- refactor: split verilog statement sources from cst (9d0cfe6)
- refactor: lex verilog parser wrappers without cst (36b0799)
- refactor: tokenize verilog formatting without cst (cb26f18)
- refactor: remove cst parameters from verilog parser wrappers (0072255)
- refactor: build mips ast from parsed lines (9dab1a7)
- refactor: hide mips cst from ast surface (4d7a333)
- refactor: build verilog ast from parser source data (8af01ee)
- refactor: parse verilog modules from tokens (eb1645a)
- refactor: parse verilog preprocessor data from tokens (41d9834)
- refactor: hide verilog cst from ast surface (bd413f2)
- refactor: hide verilog cst from parse results (5876f84)
- refactor: collect verilog block ast from tokens (3a34017)
- refactor: remove unused verilog cst folding helpers (27c0dcc)
- refactor: expose verilog lexical diagnostics on ast (4c59c54)
- refactor: route verilog syntax diagnostics through ast tokens (a1ef473)
- refactor: derive verilog semantic model tokens from ast (5f77d14)
- refactor: build verilog semantic tokens from ast (5882774)
- refactor: fold verilog ranges from ast (6f904a7)
- refactor: remove unused verilog token navigation (d9bced1)
- refactor: place verilog case fixes from ast range (a131d5f)
- refactor: drive mips parser loop from ast (3478dc3)
- refactor: expose mips parse lines through ast (69419fd)
- refactor: build mips semantic tokens from ast (d5f2990)
- refactor: resolve mips macro references from ast (beb2022)
- refactor: parse mips macro headers from ast (e24b232)
- refactor: expand mips hover details from ast (5393885)
- refactor: resolve mips word ranges from ast (2c7d8b9)
- refactor: gate verilog completions with ast trivia (2453dfc)
- refactor: resolve verilog lsp ranges from semantic model (37f2223)
- refactor: drive mips completions from prefix ast (a02e6b6)
- refactor: summarize verilog workspace diagnostics from ast (2ab6a0c)
- refactor: read verilog nettype directives from ast (3cc754c)
- refactor: detect verilog explicit port types from model (0130784)
- refactor: detect verilog magic numbers from ast (ad48a0b)
- refactor: detect verilog synthesizable hints from ast (1622245)
- refactor: detect verilog declaration init hints from model (08870af)
- refactor: detect verilog display calls from ast (c5d8bbb)
- refactor: remove verilog semantic expression token fallback (46664c6)
- refactor: traverse verilog semantic references through ast items (b74b4bf)
- refactor: collect verilog local declarations from ast (c276f22)
- refactor: check verilog initializer widths from ast (6f695bb)
- refactor: derive verilog block scopes from ast (dd06c3a)
- refactor: collect verilog assignments from ast (e12781b)
- refactor: collect verilog width references from ast (2a97ec5)
- refactor: collect verilog procedural references from ast (5afaf42)
- refactor: drive verilog implicit net diagnostics from semantic model (b526e32)
- refactor: migrate mips checks to ast operands (77e0850)
- fix(manifest): sync disabled lint defaults (aaee1b7)
- perf(verilog): reuse ISim compilation in trace batches (9bc74d4)
- perf(test): reduce streaming output overhead (76afcf2)
- fix(verilog): fix false positives for keywords and macro uses (4020d92)
- perf(logisim): parse trace output in one pass (0140253)
- perf(test): batch ASM snapshot stats (7067d7d)
- perf(test): throttle continuous report rendering (db4f4b0)
- perf(trace): compare batch traces with bounded entries (017b6f9)
- perf(verilog): reuse AST blocks in diagnostics (db87093)
- perf(verilog): cache workspace diagnostic summaries (3a7ccb1)
- perf(language): cache repeated document feature results (8a22d84)
- perf(mips): reuse parse and semantic work across files (d422ad4)
- perf(verilog): cache workspace profile and reference indexes (6249eb7)
- perf: reduce extension startup and verilog indexing work (b30b1bc)
- update gitignore (b55bbc8)
- feat(verilog): add default case quick fix (181311e)
- refactor(verilog): reuse token helpers in semantic model (95f3073)
- refactor(verilog): share token boundary helpers (9108cb7)
- refactor(verilog): share assignment token parsing (8bf3d99)
- feat(verilog): recover expression ast errors (c014633)
- feat(verilog): show effective instance parameters (b21a114)
- feat(verilog): expand constant expression evaluation (d8135a9)
- feat(verilog): retain expression ASTs in model (622ce67)
- feat(verilog): add procedural statement AST (2979ac0)
- fix(verilog): reduce noisy workspace diagnostics (94064ee)
- feat(verilog): add workspace diagnostic lint coverage (3efd5a8)
- Add cross-file Verilog semantic graph (0f9d204)
- Add AST wire extraction code action (a3afd5f)
- Collect expression references with AST walker (d2ddcf4)
- Add AST select bounds diagnostics (90c189d)
- Propagate parameter overrides in width diagnostics (987b2a0)
- Add AST constant extraction code action (993a2fa)
- Add AST constant divisor diagnostics (443fed8)
- Use expression AST for assignment width diagnostics (926cd11)
- Add AST expression refactor actions (dbff3a6)
- Adapt expression AST to Verilog LSP features (692fe5e)
- Add Verilog expression AST parser (d9d58fd)
- feat: 更多的折叠和代码补全 (f2a18cd)
- revert some commits (15b14d4)
- Revert "Extract Verilog waveform helpers" (6bf28bd)
- Extract Verilog procedural validation (a9cbb2d)
- Extract Verilog instance validation (a6d199a)
- Extract Verilog continuous assignment validation (1b504fd)
- Extract Verilog expression validation (6263b7c)
- Extract Verilog declaration validation (ac539bb)
- Extract Verilog module header validation (3cbf1aa)
- Extract Verilog syntax parser utilities (444893b)
- Extract Verilog lint testbench rules (c6a171d)
- Extract Verilog lint always rules (6762aab)
- Extract Verilog lint magic number rules (e56dd91)
- Extract Verilog lint token utilities (f5a7527)
- Extract Verilog lint declaration rules (d6b745a)
- Extract Verilog lint instantiation rules (2c2fb06)
- Extract Verilog lint naming rules (7da0910)
- Extract Verilog waveform helpers (a5ec4c2)
- Extract course test stdin helpers (061ef35)
- Avoid blocking project wizard file writes (e6096f1)
- Avoid blocking toolchain file probes (f2989ab)
- Avoid blocking MARS setup file checks (b195156)
- Avoid blocking Verilog command file checks (429923e)
- Centralize async filesystem helpers (2dc39a5)
- Read ASM case metadata asynchronously (b1a7115)
- Avoid blocking trace output discovery (2c71ce9)
- Avoid blocking Hazard report file probes (42833ae)
- Avoid blocking ISE syntax file scans (2ea82e8)
- Guard async Verilog index rebuilds (531bff2)
- Make Verilog workspace indexing asynchronous (7d7948d)
- Make generator ASM snapshots asynchronous (506ed7e)
- Read Verilog registry scans asynchronously (b51a7af)
- Avoid blocking Verilog registry scans (70d8511)
- Polish trace messages and catch notes (06833d3)
- Decouple Verilog module registry consumers (b12f358)
- Extract P3 Logisim trace runner (97d1c8b)
- Extract Logisim case preparation (43079fa)
- Extract P3 Logisim trace setup utilities (33f962d)
- Extract continuous course trace runner (f4cbee6)
- Extract course test report rendering (64f89b0)
- Optimize server and reporting utilities (8bf2410)
- feat: 强化语法检查 (5ce61b0)
- doc: 修复README错误 (3c0b464)

## [0.4.0] - 2026-06-15

- fix: 精简暴露给用户的接口 (5336529)
- fix: P3 测试 现在按画布上的端口顺序识别输出 (8cf02e1)
- fix: P3 测试 现在按 <appear><circ-port ... x/y> 的端口外观顺序识别输出 (dc1b333)
- feat: p3测试对拍 (609d0de)
- 语法检查引入ise (5ead08d)
- feat: profile auto优化 (955cc6b)
- feat: profile auto优化 (8e9e5c6)

## [0.3.0] - 2026-06-12

- ignore AGENTS.md (1e73e23)
- feat: unify CO workflow management (854b031)
- feat: 优化代码高亮 (93fa869)
- feat: 优化代码高亮 (4a8df0f)
- feat: module实例化和参数折叠 (3429f1c)
- feat: module实例化和参数折叠 (3f142ba)
- update README (206ff90)

## [0.2.1] - 2026-06-11

- fix: support npm commands in Windows release script (ec2ded5)
- update vscodeignore (c458926)
- github workflow (cd6a935)
- 插件设置分组 (4c5499a)
- feat: p7 timer和中断强测 (1d6d8db)
- feat: p7 timer和中断强测 (46b0455)
- fix: add RI test intru to resources (5c41a92)
- fix: P7 interrupt (86bfc45)
- fix: exception handler (43790d1)

## [0.2.0] - 2026-06-11

- p7 Timer和中断强测

## [0.1.4]

- 侧边栏提供连线情况展示

## [0.1.3]

- 优化 README，提供 MARS 下载地址

## [0.1.2]

- 改插件 logo

## [0.1.1]

- 初始发布

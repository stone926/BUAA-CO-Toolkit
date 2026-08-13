# CPU 自动测试严谨性与可靠性强化分析

> 分析日期：2026-08-13
>
> 插件基线：`5a988ec5b34fe0b07f65d0ede41604d533a8b273`
>
> MARS 基线：已发布稳定版 `v0.6.3 / 8b53a492dddc4fe1c62a7a02c55bea6fc4fb49d8`
>
> 范围：只分析插件、测试程序、Testbench 与裁决链可以做的改进；**不修改 MARS**，本文也不实现这些改进。

## 1. 结论

不修改 MARS，CPU 自动测试仍有很大的强化空间。当前最值得优先解决的并不是随机指令数量不够，而是以下四类“裁决链漏洞”：

1. DUT 侧只比较 GRF/DM 写事件，没有可靠证明 DUT 已经执行到测试终点；错误 CPU 在最后一次期望写回后死锁，仍可能被判通过。
2. 课程测试可能复用学生 Testbench；P6/P7 现有内存模型还会对地址取模、静默忽略越界写，并可能把带 X 的使能当作未发生。这些行为会掩盖真实硬件错误。
3. P7 中断/异常测试已经有较强的定向 probe，但普通中断场景、额外副作用、重复 ACK、年轻指令错误提交等仍没有形成完整的场景状态机。
4. MARS 只能作为一个有边界的 oracle。稳定版对部分已处理同步异常不输出故障指令，Timer 的推进模型也与 RTL 不同；P7 教程更明确规定最终标准是课程规范而非 MARS。

因此建议按以下顺序推进：

- **P0：先修裁决闭环。** 课程专用权威 TB、完成签名与 watchdog、严格内存模型、X/协议断言、严格日志协议、P3–P6 的课程 oracle run 使用稳定 MARS 已支持的 `ig`。
- **P1：强化场景与可观测性。** P7 事件 FSM、P3 完整动态 PC/Instr 比较、在线提交 scoreboard、复位 campaign、总线因果检查。
- **P2：降低单一 MARS oracle 风险。** 实现独立的课程 ISA 解释器、metamorphic testing、mutation testing、覆盖率闭环与失败自动缩减。

即使全部实现，也不能把有限仿真等同于形式证明。P3、P4、P5 的公开接口，以及 P6/P7 缺少 `commit_valid`、异常元数据等事实，决定了若干行为原则上不可从现有端口准确观察。此类情况必须显式返回 `INCONCLUSIVE` 或“降级可信度”，不能显示为普通通过。

## 2. 术语与目标裁决模型

为避免“假阳性/假阴性”的正负定义歧义，本文统一使用：

- **误报/误杀**：正确 CPU 被判失败。
- **漏报/漏检**：错误 CPU 被判通过。

建议插件不要继续把所有结果压成二值，而是使用四态裁决：

| 结果 | 含义 | 典型条件 |
| --- | --- | --- |
| `PASS` | 在声明的 oracle、接口和覆盖范围内，没有发现矛盾，而且已证明测试完成 | oracle 适用、DUT 到达完成点、事件完全匹配、TB 断言全通过 |
| `FAIL` | 观察到与课程规范或适用 oracle 的确定矛盾 | 写回不匹配、非法 byte-enable、复位期副作用、错误 EPC 等 |
| `INCONCLUSIVE` | 当前工具无法可靠判断 | 没有其他充分证据时 MARS 丢失异常 victim、缺少必要观测端口、无法归因的不一致 |
| `ERROR` | 测试基础设施失败 | 编译失败、TB 未启动、日志损坏、宿主工具超时/崩溃 |

`PASS` 必须同时满足“正确性比较”和“完成性证明”。只有一个相同的写回前缀，不能成为 `PASS`。

## 3. 当前系统已经具备的有效保护

现有系统不是从零开始，以下机制应保留并继续作为加固基础：

- 课程机器码和 DM 初始化预检，避免把明显不属于课程硬件的输入交给 oracle。
- 基于稳定 MARS `coL2` 的动态 trace，以及对最终合并 HexText 镜像、访存范围、`$gp/$sp` 初态差异的兼容性检查。
- 对标准停机尾的 MARS 动态确认，而不是只相信静态源代码。
- P3 对 Logisim PC 初值、对齐、范围、最终停机点以及可选 Instr 列的检查。
- P7 exception/interrupt probe 对 Cause、Status、EPC、部分 victim/retry commit 和 handler 记录的定向检查。
- 可复现 seed、内置随机/锚点场景以及持续测试基础设施。

本分析的目标是补上这些保护之间的空白，而不是推翻现有 trace 比较器。

## 4. 当前主要误报与漏报来源

### 4.1 只比较可见写事件，没有证明 DUT 完成

`CpuTraceEvent` 目前只包含 GRF 和 DM 写事件；最终比较核心只核对 PC、事件类型、目标和值，并且课程模式不要求与 MARS 周期一致：

- `src/language/mips/traceParser.ts`
- `src/language/mips/traceCompare.ts`
- `src/courseTesting/traceRunner.ts`
- `src/traceCompare.ts`

这会漏掉：

- 无副作用指令被跳过，但之后又回到产生相同写事件的路径；
- 分支、stall、flush 错误暂时走错路，但错误路径没有产生写回；
- CPU 产生全部期望写回后死锁；
- 错误 CPU 在最后一个可见事件后继续产生无限无副作用行为。

当前 MARS 停机检查只证明 oracle 到达停机尾，不能证明 DUT 也到达停机尾。

### 4.2 课程自动测试可能使用学生 TB

`src/verilog/testbenchResolver.ts` 会优先选择 active/user TB，再考虑生成 TB；只有部分带 P7 schedule/probe 的路径会强制生成专用 TB。

学生 TB 可能提前 `$finish`、复位长度不同、时钟相位不同、漏接 observer，或者只打印一段正确前缀。这不一定是恶意行为，但会让课程自动测试的证据不再可控。

建议区分两个命令：

- 普通 “Run ISim” 继续尊重学生 TB；
- `co.test.*` 课程裁决始终使用插件拥有并带版本号的权威 runtime TB。

### 4.3 固定仿真时长不是语义终止

`resources/templates/isim/run.tcl` 目前本质上是固定 `run <time>; exit`。进程正常退出只代表仿真器完成了这段时间，不代表程序完成。

由此会同时造成：

- 正确但执行较慢或程序较长时被截断，形成误报；
- 错误 CPU 卡住后安静等待到固定时间，若此前写事件已经匹配，形成漏报。

### 4.4 TB 内存取模和静默丢弃越界事务

当前 P7 official TB 以及通用外置内存生成逻辑中存在 `% instructionMemoryWords` / `% dataWords` 一类寻址；越界地址可能别名到合法单元。部分越界写只是不更新数组、也不打印 trace。

相关位置包括：

- `resources/templates/verilog/p7_official_testbench.v`
- `src/language/verilog/moduleUtils.ts`

这会让地址译码错误、Bridge 错误、错误高位地址偶然读到“正确”数据，或者非法 store 完全不出现在比较流中。

### 4.5 X/Z 和复位期副作用可能被静默掩盖

普通 Verilog `if (w_grf_we)` 或 `if (|m_data_byteen)` 遇到 X 时，分支可能不执行，从而把未知控制信号伪装成“没有提交”。禁用状态下的数据总线出现 X 通常是合法 don't-care，但**有效使能本身或有效事务的地址/数据出现 X** 应立即失败。

现有 TB 在 reset 时清空自己的 DM，同时通常不打印 DUT 写回。若 DUT 在同步复位有效期间错误拉高 GRF/DM/IG 写使能，这种副作用可能被 TB 的初始化行为遮住。

### 4.6 P7 普通中断与 probe 仍有观察缺口

当前实现中可确认的缺口包括：

- 普通 interrupt block 只消费 schedule 中的第一个目标，而 MARS 参数可包含整个列表；
- 触发前会清掉 `macroscopic_pc` 低两位，错误的非对齐 PC 仍可能触发；
- 没有完整的 `arm -> target -> raise -> handler -> ack -> return -> complete` watchdog；
- probe 对必要记录检查很强，但没有系统禁止所有额外 GRF/合法 DM 写、重复 ACK、额外 handler re-entry；
- timeout / unarmed 类 marker 的生成和最终裁决没有形成闭环；
- 已知 victim 之后的年轻用户指令是否在进入 handler 前错误提交，没有被所有场景统一检查。

相关实现：

- `resources/templates/verilog/p7_interrupt_block.v`
- `resources/templates/verilog/p7_probe_block.v`
- `src/courseTesting/p7ProbeCheck.ts`
- `src/language/verilog/moduleUtils.ts`

### 4.7 P3 的零写事件路径和可选 Instr 列

P3 已经比 P4–P7 多检查了动态 PC，但 Instr 列仍是可选；列映射还可以退化为 appearance/position 推断。当前双方都没有 GRF/DM 写事件时，只要现有 fetch/halt 检查通过，就可能判通过。

因此，一个只把 PC 推到停机点、却没有正确执行中间无写副作用指令的电路，理论上可能通过某些零写测试。严格模式应要求标准 label 和 Instr，并比较完整动态 `(PC, instruction)` 序列。

### 4.8 P3–P6 的算术溢出 oracle 参数可进一步修正

课程 P3–P6 的 `add/sub`（P6 还包含 `addi`）按课程语义不触发异常，而是 32 位环绕。稳定 MARS 已经支持 `ig` 参数来忽略算术溢出，但当前 `src/language/mips/marsArgs.ts` 没有为 P3–P6 的课程 oracle run 固定启用它。

结果是合法的手写溢出测试可能让 MARS 提前终止，正确 CPU 无法被准确比较。这是不修改 MARS 即可修复、成本很低且收益确定的一项：

- P3–P6 的课程 oracle run 固定启用 `ig`，普通用户 MARS 运行仍尊重用户配置；
- P7 禁止启用，因为算术溢出在 P7 是应测试的同步异常；
- 增加 `0x7fffffff + 1`、`0x80000000 - 1`、`addi` 边界 directed cases。

课程依据见：

- `cscore/markdown/P3/P3-1.md`
- `cscore/markdown/P4/P4-1.md`
- `cscore/markdown/P4/P4-7.md`
- `cscore/markdown/P5/project/P5-5-2.md`
- `cscore/markdown/P6/P6-1.md`
- `cscore/markdown/P6/P6-6.md`

## 5. P0：优先实现的裁决闭环

### 5.1 课程专用权威 TB

课程测试命令应始终生成 `.co/isim/co_generated_course_tb.v`，并做到：

1. 严格检查 profile 对应顶层端口的名称、方向和位宽。已正确选择课程 profile/top 而官方必需端口缺失或错配，是确定的设计规范违反，应判 `FAIL`；profile/top 配置选错才是 `ERROR`；只缺少可选 strict/debug pin 时标记降级可信度或 `INCONCLUSIVE`。
2. 在公开接口允许的范围内由插件控制时钟、复位、IM/DM/IG 和 trace observer；P4/P5 只能控制时钟/复位，内部 IM/DM 与课程 trace 仍属于学生设计。
3. TB 带协议版本、case id、随机 run nonce；插件只接受本次运行的结构化记录。
4. 普通用户仿真仍允许用户 TB，两条路径不要混用。
5. 若某 profile 无法生成足够强的 observer，不静默回退，而是标记“降级可信度”或 `INCONCLUSIVE`。

P4/P5 顶层按课程要求只有 `clk/reset`，权威 TB 只能统一激励，GRF/DM trace 仍需依赖学生内部 `$display`。这比 P6/P7 弱，是接口事实，不能通过更复杂的 wrapper 消除。

### 5.2 完成签名、终态握手与 watchdog

内置 ASM 应在标准停机尾之前写入一个带 **case nonce** 的保留 DM completion signature，然后进入源码中的标准 `branch-to-self + nop` 尾。case nonce 在 MARS/oracle 运行前固定并进入机器码与 case hash；它不同于每次 TB 启动才产生、只用于日志防串线的 run nonce。动态模式必须按 profile 解释：P3/P4 不启用延迟槽，只会连续执行 self-branch；P5–P7 则形成 `self-branch -> delay-slot nop` 周期。

1. 生成器把该保留地址从随机访存池排除。
2. TB/trace 必须恰好观察到一次正确 signature。
3. signature 后进入 drain/quiescence 窗口，不得出现额外架构副作用。
4. P6/P7 若能观察公开 PC，再要求观察到标准 halt PC；没有 `valid` 时不能把每个 stage PC 直接当 retire，只能作为辅助证据。
5. 超出预算必须产生明确终止原因，不能依靠 ISim 正常退出。

若 completion signature 是 M-stage store，同一周期仍可能有一条更老的 W-stage GRF commit。TB 必须按流水年龄（W older than M）归一化该周期的事件，允许这一老提交完成，并从整个采样 edge 结算后再开始 quiescence；不能按 `$display` 文本先后简单拒绝。插入 signature 后还必须重新派生 `haltPc`、victim/done PC、interrupt schedule、最大步数和全部 case metadata，不能在已有 PC metadata 后机械追加。

预算不应简单等于 MARS 指令数。建议使用：

```text
绝对预算 = 动态指令数 × profile 保守流水线系数
         + MDU/访存/异常中断上界
         + reset、流水线排空和工具裕量
```

另设“无进展 watchdog”，但 P4/P5 看不到每条 retire，不能把长时间没有写回直接视为死锁。timeout 应按证据分类：违反由规范或 directed case 证明的语义/周期上界时判 `FAIL`；宿主工具、编译或日志基础设施超时判 `ERROR`；没有可证明性能上界、也无法归因的 DUT timeout 判 `INCONCLUSIVE`。

MARS oracle 自己的终止证据也可加强：稳定版运行应同时出现 native max-step 终止 marker，而不是看到一次 halt branch 就接受。P3/P4 的尾部应持续重复 self-branch，P5/P6 应持续重复 `self-branch -> nop`；P7 需要由场景 metadata 允许有限 handler 插入，并证明每次返回 halt，而不能要求纯连续循环。`coL2` 可能很长，建议用流式 parser 维护有限尾部窗口、计数和 checksum，避免为了严格终止检查把全部输出常驻内存。

### 5.3 结构化 TB 协议与严格解析

P6/P7 的插件 observer 应只输出一套版本化记录，例如：

```text
CO_TB_BEGIN v=2 run=<nonce> case=<id> profile=P7
CO_TB_EVENT run=<nonce> seq=17 kind=GRF pc=00003020 target=05 value=12345678
CO_TB_FAIL run=<nonce> seq=18 code=DM_ADDR_RANGE cycle=92 ...
CO_TB_PASS run=<nonce> seq=19 cycle=318 checksum=<...>
```

插件必须验证：

- 恰好一个 BEGIN 和一个终态 marker；
- nonce、profile、case id 与本次运行一致；
- `seq` 连续且事件数/checksum 一致；
- malformed 或重复终态记录是 `ERROR`，而不是忽略；
- 其他普通 `$display` 不能被宽松正则误认为 P6/P7 的插件事件。

P4/P5 不能要求学生的合法课程 `$display` 携带 nonce 或 `CO_TB_EVENT`。应由可信 TB 输出 BEGIN/END framing，在两者之间只接受严格锚定的课程 legacy trace grammar，并独立统计行数/checksum；事件内容仍来自学生模块，无法防止主动伪造。在正常非对抗使用中，严格 framing 可以发现提前结束、接线和格式错误；若要求对抗恶意输出，只能增加可信调试接口或官方 wrapper 直接观察公开端口。

### 5.4 Verilog-2001 兼容的 active-X 与协议断言

ISE 14.7 不宜依赖现代 SVA。可用 case equality、reduction-X 检查和结构化 FAIL marker 实现 procedural assertions。采样应放在不会与 DUT NBA 更新竞争的时刻，例如 negedge 或经过已验证的 delta/小延迟采样。

默认断言：

- reset 解除后的有效控制信号必须为 0/1 known；
- 使能有效时，相关 PC、地址、写数据、目标寄存器、byte-enable 必须全 known；
- 禁用时不要强制 data/address known，避免把合法 don't-care 判错；
- 同步 reset 的首个有效沿后，不得出现 GRF、DM、IG 副作用；
- P6/P7 reset 后取指地址应回到 `0x3000`；
- 正常场景中，意外的有效 PC/访存必须满足 profile 的对齐及物理范围约束；P7 metadata 明确声明的 misaligned/out-of-range fetch/load/store victim 是预期异常输入，不能仅因地址本身 FAIL；
- DM 与 IG 写使能不得同时有效；
- active byte-enable 必须与 store 种类、地址低位及课程大小端规则一致；
- 非法写即使最终不会更新 TB 数组，也必须先记录并失败。

`m_data_addr` 在没有 read-enable 的接口中可能只是 ALU 结果。不能仅因 `m_data_byteen == 0` 时地址越界就失败；需要结合可用的 M-stage PC/机器码、后续 load commit 或其他可信有效性证据。P7 intentional AdEL/AdES victim 应由场景 validator 检查异常和副作用抑制，而不是由通用 range assertion 判错。

### 5.5 严格内存模型：禁止取模别名

TB v2 应改为：

- 合法范围内才索引数组；绝不对地址 `% words`；
- 非法有效写记录 raw address/data/byte-enable 后立即 FAIL；
- 地址不合法时使用确定、场景定义的 neutral/RI poison response，避免不受控 X 污染后被误归因为 DUT；只有 M-stage opcode、可信 valid、后续 load commit 或 metadata 能证明这是意外的有效读时才诊断，P7 intentional fault victim 交给异常场景裁决；
- IM 先填充 poison，再加载最终机器码，另维护 loaded bitmap；
- DM 架构可见范围内的未初始化部分保持课程要求的零值；只在架构 DM 之外的独立 shadow guard 使用 seed 化 canary，不能把非零 canary 放进合法课程 DM；
- 结束时核对 guard/canary 与 shadow DM。

必须注意：流水线可能在分支 flush 前对错误路径进行预取，且 P6/P7 没有 fetch-valid。不能仅因为 `i_inst_addr` 触及未加载 bitmap 就判错。正常场景可结合物理范围/对齐、后续架构副作用或可信 commit 证据强制“必须来自最终镜像”；P7 intentional invalid/misaligned fetch 必须由 metadata 提供确定 response 和预期异常性质，不能被通用取指 guard 提前误杀。

## 6. P1：按课程阶段强化 TB 与观察器

### 6.1 P3：完整动态 PC/Instr 严格模式

建议从 MARS `coL2` 或独立 oracle 生成直到首次稳定停机的完整 `(PC, instruction)` 序列，与 Logisim 每个有效单周期执行行比较：

- 双方都没有写事件时，也必须完整序列和 halt 都一致才能 PASS；
- strict 模式要求标准标签的 `PC` 与 `Instr` 输出，禁止纯位置推断；
- `Instr` 必须与最终机器码镜像一致；
- 对停机尾按 profile 观察稳定模式：P3/P4 连续 self-branch，P5–P7 连续 `self-branch -> delay-slot nop`；两者都要求无副作用 drain，而不是只到达一次 halt PC；
- 推荐增加可选 `clock/cycle` trace pin，用相位采样去除 Logisim table 的组合抖动；不能简单按 PC 去重，因为 self-loop 和合法重复执行会使用同一个 PC。

这不要求修改 CPU 子电路接口，但 strict 测试电路需要导出 Instr，最好也导出 clock/cycle。没有这些 pin 时只能报告较低置信度。

### 6.2 P4/P5：完成签名与可选 debug adapter

课程规定官方顶层只有 `clk/reset`，且不允许修改端口。默认路径能做的最强方案是：

- 插件权威 TB 统一时钟/复位；
- 自检 ASM 写 completion signature；
- 严格解析学生规范 GRF/DM trace；
- P4 使用单周期 directed/reset 程序，P5 使用 hazard/delay-slot/reset 程序，通过最终签名和架构状态间接验错；MDU/HI/LO 从 P6 开始；
- 明确显示“无标准 retire 接口”的置信度限制。

可提供仅仿真启用、官方工程排除的 `co_debug_adapter`，或用 `ifdef CO_TEST` 暴露 `commit_valid/pc/instr`、HI/LO 等信号。它只能是 opt-in，不能破坏官方顶层接口，也不能成为默认通过条件。

### 6.3 P6：在线 commit scoreboard 和总线因果

P6 公开 IM/DM/W 级接口，适合由插件 TB 直接观察：

- 将期望写事件打包成 `expected_commits.hex`，TB `$readmemh` 后在线逐事件 fail-fast；
- 同周期事件按流水线年龄建立固定顺序，不依赖多个 `always` 块的打印先后；
- 同时维护 GPR/DM shadow state，结束时核对完整终态和 canary；
- 保存 raw store 的 EA、byte-enable、wdata，再按课程语义归一化比较，避免 trace 折叠掩盖 byte lane 错误；
- active store 的 `m_inst_addr` 应对应最终镜像中的 store 指令；active GRF commit 的 `w_inst_addr` 应对应可能写 GPR 的指令；
- commit PC 应在合理历史窗口内被取指，但因没有 valid/stall/flush 元数据，窗口断言必须保守。

没有 `commit_valid` 和 load read-enable 时，仍不能无歧义观察每一条无副作用指令或每一个 load 请求。

### 6.4 P7：metadata 驱动的事件 FSM

每个 P7 场景都应由 metadata 生成显式状态机：

```text
ARMED -> TARGET_SEEN -> IRQ_RAISED -> HANDLER_ENTERED
      -> STATE_RECORDED -> ACKED -> RETURNED -> COMPLETED
```

状态机应检查：

- 对外部中断的安全 aligned target，`macroscopic_pc` 必须 known、对齐并精确比较，不得清低两位后再比较；misaligned-fetch 等异常场景按 metadata 的 expected PC 裁决，不能套用全局 alignment 断言；
- 消费 schedule 的全部条目，支持同一 PC 的 occurrence count；
- 每次 raise 持续到恰好一次合法 ACK；拒绝无 raise ACK、重复 ACK，以及地址不在 `0x7f20..0x7f23` 或 byte-enable 全零的 ACK。公开 ACK 语义只要求 IG 地址命中且 byte-enable nonzero；只有场景 metadata 另有明确课程依据时才检查具体 lane；
- 每个阶段有宽松但有限的 watchdog，并真正产生 `timeout` / `raise_unarmed` 终态错误；
- 进入 handler、记录 Cause/Status/EPC、ACK、返回和 completion 的顺序正确；
- 允许 victim 之前已经进入流水线后段的老指令提交；禁止 victim 和已知年轻用户指令在 handler 进入前提交；
- AdES 场景始终禁止受害 store 在 DM/IG 总线产生 byte-enable，而不是只检查少数 probe；
- required retry/continuation commit 次数精确；最终完成后没有额外副作用；
- metadata 给出 required/allowed/forbidden commit、DM/IG transaction 和 handler entry 集合，未知或重复事件不能默认忽略。

看到 `0x4180` 本身不能证明进入异常 handler：课程允许从 `0x417c` 正常顺序执行到 `0x4180`，此时行为与 P6 相同且不得响应中断。`HANDLER_ENTERED` 必须由 pending raise/expected victim、控制流上下文以及 Cause/EXL 等软件记录共同佐证，正常 fall-through 不能计为 handler re-entry。

Timer 与外部中断不应和 MARS 做精确周期对拍。正确目标是检查规范允许的事件顺序、EPC/Cause/BD、优先级、最终状态和有界响应。

### 6.5 独立复位 campaign

复位不能只在每次仿真的开头测试。建议独立生成：

- 先污染代表性 GPR、DM、HI/LO、Timer、CP0；
- 在普通执行，以及 directed 程序预计处于 load-use stall、MDU busy、branch flush、P7 interrupt pending 等状态时拉同步 reset；
- reset 后执行同一 fresh-boot signature 程序；
- 比较第二段行为与全新启动的一致性；
- P7 单独覆盖 reset 与 interrupt 同时有效时的优先级。

P6/P7 只能精确地相对公开 PC、写事件和外部 interrupt 里程碑触发；公开端口没有 stall、MDU busy 或 flush，针对这些内部状态仍需由 directed 微程序推导周期，或使用 opt-in debug adapter。P4/P5 的推导更弱；不同合法微结构可能时序不同，报告必须注明置信度，不能把推导周期写成统一规范时刻。

## 7. P2：第二 oracle 与测试方法升级

### 7.1 独立课程 ISA 解释器

建议逐步实现从**最终机器码**执行的 TypeScript 课程 ISA 规格模型，而不是继续为 MARS 差异叠加越来越多的文本修补：

- 按 profile 建模：P3/P4 无延迟槽；P5/P6 有一条延迟槽；P6 再加入 HI/LO 与 MDU；各阶段都使用对应指令集、零初态 GRF/DM、32 位环绕、课程地址空间、完整动态 PC/Instr 和架构写事件；
- P7 第一层：CP0、同步异常、BD/EPC、异常优先级的指令级模型；
- P7 第二层：Timer/外部中断交给 TB 事件模型，以偏序和有界响应裁决，不强求与 MARS 周期相同。

双 oracle 裁决建议：

| MARS | 课程 spec oracle | DUT | 裁决 |
| --- | --- | --- | --- |
| 一致 | 一致 | 不同 | `FAIL`，证据最强 |
| 与 spec 不同 | 差异已由课程规范裁定、登记并有 conformance test | 匹配 spec | 按 spec 裁决，记录已知 MARS divergence |
| 与 spec 不同 | 差异尚未分类或 spec 未完成验证 | 任意 | `INCONCLUSIVE` |
| 已证明适用于本 case | 不可用 | 匹配 MARS | `PASS`，evidence grade 标明 MARS-only |
| 不可用 | 已证明适用于本 case | 匹配 spec | `PASS`，evidence grade 标明 spec-only |
| 缺失的 oracle 正是覆盖已知缺口所必需 | 不足 | 任意 | `INCONCLUSIVE` |

第二 oracle 本身也可能有 bug，必须：

- 用人工边界向量和课程公开测试做 conformance suite；
- 在共同语义子集上和 MARS differential test；
- decoder/语义不要与随机生成器共享过多实现，避免相关错误；
- 用 mutation testing 验证它能发现预期 fault；
- 只有差异已由课程规范明确裁定、登记为已知 MARS divergence，且相关 spec 语义已有 conformance test 时，才允许由 spec 裁决；其他 oracle 争议永远不静默选择对 DUT 有利或不利的一边。

若还提供独立汇编/机器码输入与 dump 路径，或接受可信的预编译 HexText，这一方向才能解除稳定 MARS 无法覆盖 CompactLargeText/FixedCompactLargeText 最后一词 `0x6ffc` 的限制。只有解释器仍不够，因为稳定 MARS 本身不能可靠汇编/dump 该词；完整链路完成前，该边界必须标为 MARS 不可覆盖。

### 7.2 Metamorphic testing

同一程序生成多个语义等价变体，比单纯增加随机长度更能发现 hazard 和控制错误：

- 安全寄存器重命名；
- 插入 NOP 或无关指令，系统改变 producer-consumer 距离；
- 对无依赖指令进行合法重排；
- 将 DM 工作区整体平移，并对最终 signature 做归一化；
- 在满足对齐、无并发观察的前提下比较 `sw` 与四个 `sb`、`lw` 与字节重组；
- taken/not-taken 对偶；
- 同一同步异常放在普通位置与 delay slot，检查 BD/EPC 关系；
- cold run 与“先污染后 reset 再运行”结果一致。

含 PC/链接值、MMIO、Timer、中断精确窗口的程序必须使用专门关系，不能盲目变换。metamorphic failure 应保存原程序、变体和关系定义。

### 7.3 功能覆盖率而非只统计指令出现

至少报告以下覆盖维度：

- opcode/funct、立即数符号和边界值；
- producer-consumer 类型与依赖距离；
- forwarding 来源、load-use、branch compare、store-data hazard；
- branch taken/not-taken、delay-slot 指令种类、链接寄存器；
- byte/half/word/partial-word 的地址低位、上下边界和端序；
- MDU start/busy/read HI/LO/覆盖写时序；
- P7 异常种类、优先级、普通位置/delay slot、EXL/BD/EPC；
- 中断与 stall、MDU、异常、handler、Timer pending 的交叉；
- reset 所处微结构状态。

完整笛卡尔积过大，应采用 directed cases + pairwise/covering array + constrained random。报告必须展示未覆盖项，不能用“全部随机测试通过”暗示完备。

### 7.4 Mutation testing：测试测试器本身

维护一组小型 mutant CPU/TB，故意注入：

- PC 低位或 branch target 错误；
- delay slot 被跳过/多执行；
- forwarding/stall/flush 少一拍或多一拍；
- byte-enable 错一位、大小端错误、地址高位丢失；
- 越界地址取模；
- reset 期间写回；
- `w_grf_we = X`；
- MDU busy/HI/LO 时序错误；
- P7 年轻指令泄漏、EPC/BD/优先级错误；
- 只处理 schedule 第一个中断、重复 ACK；
- 产生最后一个期望写事件后死锁。

每个 checker 改动都运行 mutation kill matrix。存活 mutant 应直接转化为新的 directed/probe 测试。mutation score 衡量的是已建模 fault family 的检测能力，不是 CPU 正确概率。

### 7.5 可重放、失败缩减与 flaky 裁决

每次 case 保存：

- seed、生成器和模板版本；
- profile、指令集、配置 manifest；
- 最终 ASM、最终机器码、DM 镜像；
- MARS/JAVA/ISE/Logisim 版本和参数；
- interrupt/probe schedule、TB nonce、预算；
- 原始 oracle、DUT、TB 事件流和最终裁决证据。

首次失败后用完全相同工件重跑。若同 seed、同二进制结果不一致，不能随机选择一次结果：任一运行包含可直接证明的协议/规范违反时仍判 `FAIL`；已证明为工具或日志损坏时判 `ERROR`；只有来源无法归因时才标记 `INCONCLUSIVE/flaky`。所有互相矛盾的证据都应保存。

可增加懂控制流、delay slot、handler 和 schedule metadata 的 ASM delta-debugger。只有在失败类型和 oracle 适用性都保持不变时才能接受缩减；原始 case 永远保留。

## 8. 各阶段能够达到的上限

| 阶段 | 不改学生正式顶层时可强化到 | 无法消除的观察边界 |
| --- | --- | --- |
| P3 | 动态 PC/Instr 序列、halt、写事件、X pin；strict 电路可要求 Instr/clock pin | 课程没有统一 CPU 内部接口；插件只能信任导出的 Logisim pin |
| P4 | 权威时钟/复位、自检 signature、GRF/DM trace、directed/reset 程序 | 顶层只有 `clk/reset`；无 retire/PC/HI/LO/flush 可见性 |
| P5 | P4 能力 + hazard/delay-slot 结果和完成性间接检查 | 同样没有标准提交接口，不能逐条观察无写指令或流水线状态 |
| P6 | 严格 IM/DM、raw store、X/协议、stage opcode、写事件 scoreboard、完成/liveness | 无 `commit_valid`、load read-enable、stall/flush/HI/LO 元数据 |
| P7 | P6 能力 + Bridge/IG、异常/中断 FSM、Cause/EPC/BD 软件 probe、设备协议 | CP0、Req、EXL、Timer 内部状态不可见；MARS 不是最终规范 |

教程接口依据：

- `cscore/markdown/P3/P3-2.md`
- `cscore/markdown/P4/P4-7.md`
- `cscore/markdown/P5/project/P5-5-2.md`
- `cscore/markdown/P6/P6-6.md`
- `cscore/markdown/P7/implement/P7-2-6.md`

## 9. 受插件和稳定 MARS 局限而无法准确测试的情况

以下情况必须在 UI/报告中明确告知用户，不能显示为无条件 `PASS`。

### 9.1 稳定 MARS 不输出部分同步异常 victim

稳定 `8b53a49` 的 `coL2` 在 `instruction.simulate()` 成功后才输出指令 header。P7 开启 `efc` 后，部分同步异常会直接转入 handler，而故障指令没有 `@PC` header。

现有静态兜底可以覆盖一部分 `$gp/$sp`、IG 和常量地址情形，但不能完备恢复：

- 任意寄存器数据流计算出的故障地址；
- handler 内再次发生同步异常；
- handler 内新 HWInt 或复杂嵌套；
- 无法从普通 handler 软件记录反推出的 victim 读集和副作用。

静态兜底还是保守过近似：它可能扫描到实际不可达的 fault candidate，或者在控制转移后失去“寄存器已初始化”的证明，进而拒绝一个正确外部程序。因此这里既有漏检风险，也有误报风险。

安全策略：受控 probe、独立 spec oracle 或足够静态证明存在时可以判；一般外部 ASM 无法证明时返回 `INCONCLUSIVE/unsupported`，保守 oracle 兼容性拒绝不能呈现为 CPU 功能 `FAIL`。

### 9.2 P7 的规范模型不是 MARS

P7 教程明确说明 SMRL/课程规范与 MARS 存在差异，最终评测不以 MARS 为标准。已知差异过滤只能避免部分明显误判，不能把 MARS 变成完备的 P7 黄金模型。

安全策略：同步异常/CP0 逐步交给课程 spec oracle；Timer/外部中断使用 TB property/probe。只有已由课程规范裁定、登记并有 conformance test 的已知 MARS divergence 才按 spec 处理；其他分歧报告 `INCONCLUSIVE`。

### 9.3 Timer 与外部中断不能做精确周期对拍

稳定 MARS 按指令推进 Timer，RTL 按时钟推进；流水线 stall、flush、MDU 和中断采样会进一步扩大差异。当前 `p7irq` 的目标映射只适合生成器约束的安全 anchor，不代表任意手写分支/重复 PC 都能精确调度。

安全策略：只比较事件偏序、EPC/Cause/BD、最终设备状态、原子性和宽松有界响应，不比较与 MARS 相同的中断周期。

### 9.4 公开接口不足导致内部行为不可辨识

- P4/P5 只有 `clk/reset`；没有可信 retire/debug 接口。
- P3 没有统一内部接口，只能读取用户导出的 pin。
- P6/P7 没有 `commit_valid`、load read-enable、CP0/HI/LO、异常/flush 元数据。

若两个实现对所有公开观察量相同，插件无法判断它们内部 stall/flush/状态更新是否不同。尤其是“错误状态从未被后续程序读取”的情况，本来就不会出现在黑盒 trace 中。

安全策略：默认通过只能声明“对本次公开行为未发现差异”；需要内部保证时使用 opt-in debug adapter、形式验证或官方评测接口。

### 9.5 MARS 的内存与程序边界

- 稳定 CompactLargeText/FixedCompactLargeText 无法可靠汇编、dump 并作为硬件最后一个 text word `0x6ffc` 的 oracle；当前只能安全覆盖 4095 个连续 word。解除限制需要独立机器码输入/dump 路径与 spec oracle，不能只增加解释器。
- 课程 DM 为零初态，非零 `.data` 初态不能直接假设一致，只能用程序内 store 初始化或独立 oracle。
- P3–P6 的 host syscall/stdin 不存在于课程 CPU，应拒绝；P7 `syscall` 只能按课程同步异常语义测试。
- 稳定 MARS 的默认 `$gp/$sp` 与课程全零复位不同；插件只能拒绝不兼容读法或由第二 oracle 接管。

### 9.6 有限随机测试不能证明正确

随机和场景测试只能证明已运行样本。不同 hazard、数据、异常和中断重叠组合不是独立同分布事件，不能把通过 N 次简单解释为某个“CPU 正确概率”。

安全策略：报告 coverage matrix、未覆盖项、seed ledger 和 mutation detection；统计区间只能标注为特定 fault model 下的经验指标。

### 9.7 observer 的信任边界

P4/P5 trace 和 P3 pins 由学生工程提供。插件能发现常见接错、格式错误、X、序列矛盾，但若考虑主动伪造 `$display` 或将测试 pin 接到伪造逻辑，软件无法证明输出来自真实 CPU 状态。

安全策略：课程自动测试默认采用非对抗假设；高可信模式需要官方 wrapper 直接连接规范公开端口或可信 debug adapter。

### 9.8 RTL 功能仿真的物理边界

强 TB 只能提高 RTL 功能和协议置信度，不能证明：

- 综合后静态时序收敛；
- 亚稳态、跨时钟域和板级电气行为；
- FPGA RAM/寄存器上电初态与仿真一致；
- 实际关键路径频率。

这些需要综合、STA、实现后仿真和上板测试；不能由 MARS 或当前功能 TB 替代。

## 10. 建议实施顺序与验收条件

### 里程碑 A：先堵住明确漏洞

实施：

1. P3–P6 的课程 oracle run 固定加入 `ig`，P7 禁止；普通用户运行不强制改写。
2. 课程命令始终使用权威 TB。
3. completion signature + 终态 marker + watchdog。
4. 移除所有 TB 地址取模和越界写静默丢弃。
5. active-X、reset 副作用、地址/byte-enable 协议断言。
6. 严格 trace framing 和四态裁决。

验收：

- 每次课程仿真恰有一个可验证终态；
- “最后写回后死锁” mutant 被杀死；
- 越界别名、X enable、reset 写、错误 byte-enable mutant 全部被杀死；
- 已知正确参考设计和现有合法测试不出现新增误报；
- 超时、oracle 不适用、工具失败不会显示为 PASS。

### 里程碑 B：按 profile 加强

实施：

- P3 完整动态 PC/Instr strict 模式；
- P6 在线 scoreboard、raw bus 和 shadow state；
- P7 metadata FSM、完整 schedule、重复/额外事务检查；
- 独立 reset campaign。

验收：

- P3 零写程序不能仅凭到达 halt 通过；
- 多目标/重复 PC interrupt schedule 全部被消费；
- raise/ACK/handler/return 每个阶段的 timeout 和重复事件都有明确失败；
- victim 后年轻指令泄漏、额外合法 DM 写、重复 ACK mutant 被杀死；
- 关闭/缺少严格观测时明确显示降级置信度。

### 里程碑 C：第二 oracle 与质量闭环

实施：

- P3–P6 独立课程 ISA 解释器，之后逐步加入 P7 同步异常层；
- metamorphic 变体；
- functional coverage、mutation score、seed ledger；
- flaky 重放与 ASM 自动缩减。

验收：

- 共同子集上 spec oracle 与稳定 MARS 的差异都有分类和回归用例；
- oracle 争议自动进入 `INCONCLUSIVE`；
- 报告能展示 opcode/hazard/边界/异常中断交叉的已覆盖与未覆盖项；
- 每个主要 fault family 至少有一个能被稳定杀死的 mutant；
- 失败可由保存工件离线重放，缩减后仍保留同一失败证据。

## 11. 实现时应避免的做法

- 不要用 MARS 周期与流水线 RTL 周期逐拍比较。
- 不要因无 fetch-valid 的 `i_inst_addr` 一次进入未加载区域就直接失败。
- 不要对禁用事务的 data/address 总线做无条件 X 检查。
- 不要通过硬编码学生内部层级路径来假装获得统一 commit 接口。
- 不要在强 TB 不可用时静默降级到用户 TB并仍显示普通 PASS。
- 不要把“重复随机测试通过”描述为形式完备或 CPU 正确概率。
- 不要忽略 malformed trace、额外事件、越界写或未知 marker。
- 不要为了减少误报而无限放宽 timeout；应区分功能失败、不可判定和工具错误。

## 12. 预计涉及的插件模块

若后续实施，建议保持关注点分离，避免把协议、解析和 UI 堆进同一文件：

- TB 协议/模板：`resources/templates/verilog/`、独立的 TB protocol builder；
- TB 选择：`src/verilog/testbenchResolver.ts`；
- 外置内存与 observer 生成：`src/language/verilog/moduleUtils.ts`；
- ISim 运行和终态：`src/verilog/isimRunner.ts`、`resources/templates/isim/run.tcl`；
- trace framing/parser：独立于 `traceCompare` 的严格 parser；
- oracle 适用性：`src/courseTesting/marsOracleCompatibility.ts`、`marsImageCompatibility.ts`；
- P3 动态序列：`src/courseTesting/logisimTrace.ts`；
- P7 FSM：从 `src/courseTesting/p7ProbeCheck.ts` 拆出可复用 scenario validator；
- 课程 spec oracle：新建独立 decoder/state/semantics 模块，不与生成器共享可疑语义；
- coverage、mutation、replay：新建测试质量模块和机器可读报告，不放进 VS Code command handler。

## 13. 最终建议

第一阶段不要继续单纯扩大随机程序长度。先让每一次测试都能回答三件事：

1. **我比较的是不是这次运行、完整且可信的事件流？**
2. **DUT 是否真的完成，而不只是产生了一个正确前缀？**
3. **当前 oracle 和公开接口是否足以作出判断？**

权威 TB、完成签名、严格 memory/X/协议断言和四态裁决能最快减少漏检与误报；P7 FSM 和 P3 动态序列随后补齐各阶段最明显的观察缺口；独立课程 ISA oracle、metamorphic 和 mutation testing 则负责长期降低对稳定 MARS 单一实现的依赖。

对于本文第 9 节列出的不可观察或 MARS 不适用情况，正确产品行为不是“尽量猜一个结果”，而是把限制、已验证性质和未验证性质明确展示给用户。

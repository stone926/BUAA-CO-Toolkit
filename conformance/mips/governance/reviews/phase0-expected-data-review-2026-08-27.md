# 阶段 0 expected data 审阅记录（2026-08-27）

> 审阅执行者：**Claude（Opus 5）**，在仓库所有者 `stone926` 于本次会话中明确授予审批权的前提下执行。
>
> 审批信封格式说明：`governance/approval-envelope.schema.json` 的每一层都是
> `additionalProperties: false`，且 `review.reviewer` 被硬编码为 `const: "stone926"`，
> 信封内**没有可以记录"由谁实际执行审阅"的字段**。因此本文件是那 16 份信封的
> provenance 说明：信封上的 `stone926` 表示"所有者承担该批准"，实际审阅工作与证据
> 由本文件记录。任何后续审计应把二者合起来读。
>
> 审阅对象提交：`3eb32fb`（阶段 0/1 加固）之上；批准信封写入见本文件所在提交。
>
> 位置说明：本文件放在 `conformance/mips/governance/reviews/` 而不是 `.agents/docs/`，
> 因为后者被 .gitignore 排除，而前者受 CODEOWNERS 保护并紧邻它所解释的审批信封。

## 1. 审阅范围

| artifact kind | id | 候选作者 | 结果 |
| --- | --- | --- | --- |
| corpus | corpus-manifest（11 cases） | codex-phase0-corpus | 批准 |
| courseVector | 10 个 COURSE-VEC-* | codex-phase0-corpus | 批准 |
| isaGolden | course-basic-v1（33 指令 + 5 counterexample） | codex-gpt-5 | 重新绑定 catalog 后批准 |
| marsGolden | 4 个固定 legacy-course-executor 录制 | codex-phase0-corpus | 批准 |

审阅者与候选作者不同主体，满足 `assertIndependentPolicyReviewer` 的独立性要求。

## 2. 审阅方法

刻意使用**三个互不依赖的来源**，任意两者不一致即阻断批准：

1. **手工推导**：直接依据教程条款与 MIPS 编码规范逐字段计算期望值，不读取生产 catalog。
2. **固定 MARS v0.6.3**：用 pinned reference 汇编语料，产生 image / coL2 final state。
3. **阶段 2/3 新建的 TypeScript 执行器**：经版本化 JSONL CLI（`machine.execute` /
   `device.cycleVector`）独立执行同一 image。该执行器由教程契约实现，与候选数据的
   生成链无共同来源，因此是有效的交叉核对而非循环论证。

> 注意：交叉核对只用于**验证**独立编写的期望值，绝不用于**派生**期望值。
> courseVector 的 expected 仍然不得来自生产实现。

## 3. courseVector 逐项结果

| case | 模式 | 独立验证 |
| --- | --- | --- |
| COURSE-VEC-P3-ARITH-001 | mars-compatible-final-state | 手工 ✔ / MARS ✔ / TS ✔ |
| COURSE-VEC-P3-BOUNDARY-001 | manual-final-state | 手工 ✔ / TS ✔（MARS 刻意不作 oracle） |
| COURSE-VEC-P3-BRANCH-001 | mars-compatible-final-state | MARS ✔ / TS ✔ |
| COURSE-VEC-P3-MEMORY-001 | mars-compatible-final-state | MARS ✔ / TS ✔ |
| COURSE-VEC-P4-CONTROL-001 | mars-compatible-final-state | MARS ✔ / TS ✔ |
| COURSE-VEC-P5-DELAY-LINK-001 | mars-compatible-final-state | MARS ✔ / TS ✔ |
| COURSE-VEC-P6-BYTE-MDU-001 | mars-compatible-final-state | MARS ✔ / TS ✔ |
| COURSE-VEC-P7-CP0-EXCEPTION-001 | independent-directed-oracle | 手工核对全部 9 个快照 ✔ |
| COURSE-VEC-P7-EXTERNAL-IRQ-001 | independent-directed-oracle | 手工核对全部 5 步 ✔ |
| COURSE-VEC-P7-TIMER-001 | independent-directed-oracle | 手工 ✔ / TS 设备复现全部 14 个快照 ✔ |

7 个 program-final-state 向量由 pinned MARS 汇编后交给 TS 执行器运行，final GPR/DM、
haltPc 与 `writes.gpr` 集合逐项一致。

### P7-CP0-EXCEPTION-001 手工核对要点

- `write-status 0xffffffff → 0x0000fc03`：与 `COURSE-P7-CP0-002` 的 IM(15:10)|EXL(1)|IE(0) 可写面一致。
- `request victimPc=0x3008 delaySlot=false code=12` → `cause=0x00000030`（12<<2，BD 清零）、
  `epc=0x00003008`、`status |= EXL`：符合 `COURSE-P7-EXC-003/009/015`。
- `request victimPc=0x3018 delaySlot=true code=8` → `cause=0x80000020`（BD=1 | 8<<2）、
  `epc=0x00003014 = victimPc-4`：符合 `COURSE-P7-EXC-009`。
- `eret` 清 EXL 而保留 Cause/EPC：符合 `COURSE-P7-EXC-001`。
- 快照中的 `request` 字段语义为「本步是否接受了 Req」，不是常驻中断资格信号；
  `sample-hardware` 步的 `request:false` 因此正确（评估器实现见
  `runner/courseVectorArtifact.mjs:150-198`）。

### P7-EXTERNAL-IRQ-001 手工核对要点

评估器条件与官方 `tb_interrupt_demo.v` 一致：
`asserted && (address & ~3) === 0x7f20 && byteEnable !== 0` 才撤销请求。
5 步（reset / raise / 存 0x7f00 be=15 / 存 0x7f20 be=0 / 存 0x7f23 be=1）的
`asserted` 序列 `false,true,true,true,false` 逐项正确。

## 4. ISA golden：catalog 指纹重新绑定

批准前发现 `verify:ts-cli` 失败：golden 记录的 `catalogSha256 = f480ea2e…` 与生产
catalog 不符。追查结论：

- `f480ea2e…` 是提交 `eba255b` 中 generated catalog 的指纹，当时二者是匹配的。
- 阶段 0/1 加固变更为 `resources/mips/isa.json` **新增了 `generator` 展示顺序/策略段**，
  generated catalog 指纹随之变为 `5f50a468…`，按设计使旧审批绑定失效。
- 对该变更做了语义 diff：82 条指令的 `format`/`runtimeMatch`/`canonicalEncodingConstraints`/
  `effects`/`control`/`memoryAccess`/`availability` **一字未改**，属编码中性变更。

处置：重新审阅 golden 的期望数据本身——手工逐条复核 33 个 word 的 R/I/J 型字段布局
与 5 个 runtime counterexample（非 canonical shamt/rt/rs、课程外 CP0 rd、未知 opcode），
全部正确；随后把 `catalogSha256` 重新绑定到 `5f50a468…`、`--refresh-integrity`
（该操作会强制降级为 candidate）、`--verify`，最后 `verify:ts-cli` 通过
（33 指令 + 5 counterexample 经 CLI 全部复核），才执行 `--approve`。

## 5. 记录在案的发现（非阻断）

1. **timer-sequence 评估器不建模 WE 周期抑制。** 它把寄存器写当作零周期逻辑步，
   因此无法把 `COURSE-P7-TIMER-006`（写优先于同周期自动更新）作为**周期**性质来考核。
   该性质的真实覆盖依赖 official-RTL decision lane
   （`COURSE-P7-TIMER-RESTART-001`，11 个向量，需 Icarus 直接编译官方 Verilog）。
   向量本身的状态迁移序列是正确的，已由 TS 设备在约定映射下逐拍复现。
2. **CP0 评估器在 `EXL=1` 时抑制异常 Req，阶段 2/3 执行器则接受。** 二者都落在课程
   未定义域外（`COURSE-P7-EXC-006` 不要求嵌套；P7-2-6 保证 handler 内不发生异常），
   不构成契约冲突。若将来把设备/CP0 lane 接到 TS 引擎，需要先裁决该角落。
3. **`COURSE-VEC-P3-ARITH-001` 的注释把 `add $t5,$t2,$t2` 称为 "wrap test"，
   但 0x12340000+0x12340000 = 0x24680000 并不回绕。** 仅注释不准确，期望值正确。
4. **TS 执行器与 timer 向量的 API 约定不同**（向量：`write` 即一个 WE 时钟沿；
   执行器：按计划第 5.3 节，`commit` 不推进周期，WE 沿记在随后的 `tick` 上）。
   二者描述同一 RTL，接线时需要 `write → write + 1 tick` 的映射。

## 6. 未由本次审阅覆盖的门槛

以下属于环境/远端证据，**不能**由本机审阅或人工批准替代：

- `COURSE-P7-TIMER-RESTART-001` official-RTL lane：本机无 `iverilog`/`vvp`，
  `verify:decisions --require-rtl` 按设计 fail closed，必须由 CI（已在 `ci.yml` 安装 Icarus）实跑。
- 固定 runner benchmark：只认 GitHub Actions `windows-2025` 与 `ubuntu-24.04`
  成对 candidate/approval，本机 smoke 不入基线。
- `phase1-portability.yml` 两平台真实证据。
- `main` 的 branch protection / code-owner 强制。

---
name: p7-test-system-findings
description: Key facts for building P7 one-click automated testing (generator+Mars+testbench) in the CO extension
metadata:
  type: project
---

Goal: P7 one-click differential testing (generate ASM → MARS dump machine code → ISim runs testbench → MARS golden run → compare GRF/DM traces), looping. Focus: external interrupts.

**Big discovery: most infrastructure already exists; P7 is just gated off.**
- The full trace loop already works for P4/P5/P6 in `src/courseTest.ts` (`runCourseTraceCase`, `startContinuousGeneratedTraceTests`). P7 is blocked by `rejectP7TraceAutomation()` (courseTest.ts:1281) and `rejectP7TraceCompare()` (traceCompare.ts). `shouldShowTraceTestActions()` (sidebar.ts:315) excludes P7.
- Generator `src/courseTesting/` already models CPU state (`cpuState.ts`: GPR/HI/LO/DM/CP0 SR,Cause,EPC), emits `.ktext 0x4180` handler when syscall enabled, P7 capped at 1118 instrs (before 0x4180). No external-interrupt modeling yet.
- Testbench builder `src/language/verilog/moduleUtils.ts` `buildP7OfficialTestbench()` already emits the official `tb_norm_demo.v` byte-for-byte but with the interrupt block COMMENTED (`commentedP7InterruptBlock`).

**Mars fork (E:/VSCode/BUAA-CO/Mars-with-BUAA-CO-extension) is essentially a ready P7 golden model** (README is outdated):
- `efc` flag = enable P7 exception/interrupt handling. `p7irq=0x3010,0x3020` = PC-scheduled external interrupt (sets HWInt bit2 when committed PC hits a scheduled PC, fires once). `coL1` = trace `@PC: $rd <= val` / `@PC: *addr <= val` (no cycle).
- `Coprocessor0.java`/`Exceptions.setRegisters`: EPC=PC−4 (interrupted instr), BD bit + EPC−4 for delay slot, ExcCode<<2, EXL=1 — EXACTLY matches Verilog CP0. `prevIRQ` 1-instruction delay models pipeline latency (both Mars & Verilog defer to target_pc+4).
- `Memory.java`: writes to 0x7F00/0x7F10 (timers) and 0x7F20 (int-ack) intercepted & return early → NO DM trace (matches Verilog). MemoryConfigurations: `CompactLargeText` → exception handler 0x4180.
- `TimerOne/TimerTwo.java`: timers count PER-INSTRUCTION; Verilog timer counts PER-CYCLE → timer-IRQ对拍 INFEASIBLE. Only PC-scheduled external interrupt is deterministic across both.
- Settings.java has setExceptionForCourse/setP7IrqPcList/hasP7IrqAt/markP7IrqFired. Build via CreateMarsJar.bat / CompileMarsClass.bat. Extension's `buildMarsArgs` (mips.ts) does NOT pass efc/p7irq yet (net-new).

**Course-mandated P7 conventions (confirmed in tutorial + both example CPUs hlc-mips-cpu & oGYCo-co/P7):**
- Memory map: DM [0,0x3000), Timer0 0x7F00-0x7F0B, Timer1 0x7F10-0x7F1B, Int-ack 0x7F20-0x7F23. Text 0x3000+, handler 0x4180.
- `HWInt = {3'b0, interrupt, timer1_IRQ, timer0_IRQ}` → IP bits 12/11/10. macroscopic_pc = M-stage PC. w_grf_*=W-stage.
- CP0: SR IM=[15:10], EXL=bit1, IE=bit0; Cause BD=bit31, IP=[15:10], ExcCode=[6:2]. ExcCode: Int=0, AdEL=4, AdES=5, Syscall=8, RI=10, Ov=12.
- Verilog CP0 resets SR=0 (IE=0); Mars defaults SR=0xFF11 (IE=1) → programs MUST init SR (`ori $t0,$0,0x1001; mtc0 $t0,$12` = IE + external IM) to converge.
- Official handler: distinguishes Int (ExcCode 0 → restore & eret, re-execute) from exception (EPC+=4, skip). `eret` has NO delay slot. External interrupt MUST be cleared by `sw` to 0x7F20 or Verilog storms (Mars auto-clears bit2 on entry).
- Trace compare ignores cycles (`defaultTraceCompareMode.compareCycles=false`).

Tutorial: cscore/.../tutorial/P7 (theory P7-1-*, implement P7-2-*); official TBs at P7/implement/assets/tb_{norm,interrupt}_demo.v (interrupt demo uses `target_pc=0x3010`).

## Implemented & VERIFIED (2026-06-08)

Built the full P7 one-click loop. Status: tsc clean, 698 unit tests pass, and **end-to-end对拍 PASSES on the real `hlc-mips-cpu` via ISim (D:/ISE/14.7/ISE_DS), diff=0 across multiple seeds**, covering external interrupt + injected exceptions (Ov/AdEL/AdES/syscall); a deliberately bugged GRF was correctly caught.

**Critical validated alignment rule (non-obvious):** MARS `p7irq=X` commits X then defers X+4 (its prevIRQ delay). A standard BUAA CPU samples the interrupt against the M-stage `macroscopic_pc` and defers *that* instruction. So to make both defer the same instruction:
- generator's `interruptSchedule` = the testbench `target_pc` = the deferred instruction = **k+1** (chosen as a contiguous safe ALU pair (k,k+1), both always-executed simple ops so Cause.BD=0).
- testbench uses `interruptSchedule` directly (`buildP7OfficialTestbench` active block).
- `buildMarsArgs` (mips.ts) fires MARS at **`target - 4`** (= k). Both then defer k+1.

**Handler must write 0x7F20 FIRST, then read Cause.** MARS auto-clears external IP at exception entry; the Verilog testbench holds `interrupt` until the 0x7F20 ack. Reading Cause before the ack would disagree on IP bits. Writing 0x7F20 first makes both read Cause with IP=0 (so the traced `$k0 <= Cause` matches). Confirmed: interrupt handler trace shows `$26 <= 00000000`.

Other essentials: golden run needs `db` (delayed branching) or delay slots diverge; P7 uses `mc CompactLargeText` (handler entry 0x4180); body restricts CP0 to `mfc0 $12` only (SR held constant by the SR prologue `ori $k0,0x1001; mtc0 $k0,$12`); faulting/exception instructions emitted with no modeled state change (handler EPC+=4 skips); never put syscall in a delay slot. Interrupts are gated by `co.test.p7.interrupt` (default true) so users with non-standard pipeline timing can fall back to deterministic exception-only对拍; `co.test.p7.exceptionRate` (default 0.08) controls injected internal exceptions.

To re-run e2e对拍 manually: ISE at D:/ISE/14.7/ISE_DS; one-click button is "P7 一键测试" → `co.test.startContinuousGeneratedTraceTests`.


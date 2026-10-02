// @index mips-debug — Workbench projections of shared engine state and reference data
import type { DebugMode, DebugSnapshot } from '../core/debug/api';
import { gprNames } from '../core/assembler/registers';
import { getMarsMemoryLayout } from '../core/profiles/marsMemoryLayout';
import { marsSyscallCatalog } from '../core/mars/syscallCatalog';
import type { WorkbenchRegister, WorkbenchState } from './protocol';

export function modeLabel(mode: DebugMode): string {
  return mode.kind === 'course' ? `${mode.profile} 课程 CPU` : `MARS · ${mode.memoryConfiguration ?? 'Default'} · 延迟槽${mode.delayedBranching ? '开启' : '关闭'}`;
}

export function initialWorkbenchState(title: string, mode: DebugMode): WorkbenchState {
  const layout = getMarsMemoryLayout(mode.kind === 'mars' ? mode.memoryConfiguration : 'CompactDataAtZero');
  const memoryRegions = mode.kind === 'course'
    ? [{ name: '数据段', address: 0 }, { name: '指令段', address: 0x3000 }, { name: '异常入口', address: 0x4180 }]
    : [{ name: '数据段', address: layout.sectionLayout.data.base }, { name: '堆', address: layout.heapBase },
      { name: '栈顶', address: Math.max(layout.stackLimit, layout.stackPointer - 124) },
      { name: '指令段', address: layout.sectionLayout.text.base }, { name: '内核', address: layout.exceptionHandler }];
  return {
    title, mode: mode.kind === 'course' ? mode.profile : 'mars', modeLabel: modeLabel(mode),
    status: 'empty', message: '点击「汇编」载入程序，然后单步观察或运行到断点。',
    sourceChanged: false, steps: 0, delaySlot: false, instructions: [], registers: [], floatingPoint: [], cp0: [],
    memory: [], memoryAddress: memoryRegions[0].address, memoryRegions, symbols: [], breakpoints: [], console: '',
    syscalls: marsSyscallCatalog, instructionOffset: 0, instructionCount: 0
  };
}

export function projectSnapshot(state: WorkbenchState, snapshot: DebugSnapshot, previous?: DebugSnapshot): WorkbenchState {
  const register = (name: string, value: number, before?: number, detail?: string): WorkbenchRegister =>
    ({ name, value, changed: before !== undefined && value !== before, ...(detail ? { detail } : {}) });
  const status = snapshot.status === 'fault' || snapshot.status === 'step-limit' ? 'error' : snapshot.status;
  const reason = snapshot.diagnostic?.message ?? (
    snapshot.status === 'exited' ? `程序结束 · 退出码 ${snapshot.exitCode ?? 0}，可继续查看寄存器与内存。` :
    snapshot.reason === 'breakpoint' ? '已到达断点，下一条指令尚未执行。' :
    snapshot.reason === 'entry' ? '汇编成功 · 已停在入口，可单步或运行。' :
    snapshot.reason === 'step' ? '已执行一条机器指令。伪指令可能展开为多条。' :
    snapshot.status === 'running' ? '正在运行 · 可随时暂停。' : '已暂停。');
  const oldMemory = new Map(previous?.memory.words.map(word => [word.address, word.value]));
  const fpView = new DataView(new ArrayBuffer(4));
  const cp0 = snapshot.cp0;
  return {
    ...state, status, message: reason, pc: snapshot.pc, steps: snapshot.instructions,
    delaySlot: snapshot.pendingBranch !== undefined, breakpoints: snapshot.breakpoints,
    inputPrompt: undefined,
    registers: [...snapshot.gpr.map((value, index) => register(gprNames[index].names[0], value, previous?.gpr[index], `$${index}`)),
      register('HI', snapshot.hi, previous?.hi, snapshot.hiDefined ? undefined : '尚未定义'),
      register('LO', snapshot.lo, previous?.lo, snapshot.loDefined ? undefined : '尚未定义')],
    floatingPoint: (snapshot.fpr ?? []).map((value, index) => {
      fpView.setUint32(0, value, true);
      return register(`$f${index}`, value, previous?.fpr?.[index], `float ${String(fpView.getFloat32(0, true))}`);
    }),
    cp0: cp0 ? [register('Status', cp0.status, previous?.cp0?.status, `EXL=${(cp0.status >>> 1) & 1} · IE=${cp0.status & 1}`),
      register('Cause', cp0.cause, previous?.cp0?.cause, `ExcCode=${(cp0.cause >>> 2) & 31} · BD=${cp0.cause >>> 31}`),
      register('EPC', cp0.epc, previous?.cp0?.epc),
      ...(cp0.badVaddr === undefined ? [] : [register('BadVAddr', cp0.badVaddr, previous?.cp0?.badVaddr)])] : [],
    memoryAddress: snapshot.memory.address,
    memory: snapshot.memory.words.map(word => ({ address: word.address, value: word.value,
      changed: oldMemory.has(word.address) && oldMemory.get(word.address) !== word.value }))
  };
}

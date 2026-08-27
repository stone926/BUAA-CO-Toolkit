// @index mips-core — 取指/译码/求值到 InstructionEffect：异常检测与可比较域分类，不提交任何状态
import { matchRuntimeInstruction } from '../isa/decoder';
import { InstructionScope } from '../isa/decoder';
import { IsaInstructionEntry } from '../generated/isaCatalog';
import {
  Cp0Write,
  ExecutionDiagnostic,
  executionDiagnostic,
  HiLoWrite,
  OutOfDomainReason,
  RegisterWrite
} from '../events/commitEvent';
import { PreparedDeviceAccess } from '../devices/deviceBus';
import {
  CourseExceptionName,
  CourseExecutionProfile,
  cp0RegisterNumbers,
  ExceptionStage
} from '../profiles/profile';
import {
  addSigned32WithOverflow,
  hex8Address,
  low32,
  multiplySigned64,
  signExtend16,
  u32
} from '../values';
import { MemoryBus, MemoryFault, PreparedMemoryAccess } from './memoryBus';
import {
  branchCondition,
  immediateAlu,
  immediateTrapCondition,
  loadWordLeft,
  loadWordRight,
  multiplyDivide,
  registerAlu,
  storeWordLeft,
  storeWordRight,
  trapCondition
} from './semantics';
import { MachineState, PendingBranch } from './state';

/**
 * `evaluateInstruction` 只计算 effect，绝不写状态（计划第 5.3 节）：
 * 结构上保证异常受害指令不会留下部分 GPR/DM/CP0 写。
 *
 * 异常检测按 `F > D > E > M` 的最早阶段返回，因此同一受害指令的优先级
 * （COURSE-P7-EXC-PRIORITY-001）由求值顺序天然保证，而不是靠事后排序。
 * P3–P6 没有架构异常，同样的 fault 被分类为可比较域之外的输入。
 */

export type UndefinedBehaviorPolicy = 'fail-closed' | 'deterministic';

export interface TransitionContext {
  readonly profile: CourseExecutionProfile;
  readonly state: MachineState;
  readonly memory: MemoryBus;
  readonly scope: InstructionScope;
  readonly undefinedBehavior: UndefinedBehaviorPolicy;
}

export interface PendingException {
  readonly name: CourseExceptionName;
  readonly stage: ExceptionStage;
  readonly address?: number;
  readonly message: string;
}

export interface StoreEffect {
  readonly prepared: PreparedMemoryAccess;
  readonly rawValue: number;
  readonly valueBefore: number;
  readonly valueAfter: number;
}

export interface LoadEffectRecord {
  readonly prepared: PreparedMemoryAccess;
  /** Aligned word behind the access, before any extension or merge. */
  readonly wordValue: number;
  /** Value delivered to the destination register. */
  readonly value: number;
}

export interface InstructionEffect {
  readonly pcBefore: number;
  readonly word?: number;
  readonly mnemonic?: string;
  /** PC after this instruction commits; already accounts for a consumed delay slot. */
  readonly nextPc: number;
  /** Control transfer that starts a delay slot on delay-slot profiles. */
  readonly pendingBranch?: PendingBranch;
  readonly delaySlot: boolean;
  readonly branchOriginPc?: number;
  readonly controlTransfer: boolean;
  readonly gprWrites: readonly RegisterWrite[];
  readonly hiLoWrites: readonly HiLoWrite[];
  readonly cp0Writes: readonly Cp0Write[];
  /** `mul` leaves HI/LO architecturally undefined (MIPS32 UNPREDICTABLE). */
  readonly invalidateHiLo?: boolean;
  readonly store?: StoreEffect;
  readonly load?: LoadEffectRecord;
  /** Present on control-transfer instructions; `false` records a not-taken branch. */
  readonly branchTaken?: boolean;
  /** Address the control transfer resolved to, including a not-taken fall-through. */
  readonly controlTarget?: number;
  /** Device transaction to commit or abort together with the CPU effect. */
  readonly deviceAccess?: PreparedDeviceAccess;
  /** `eret` return target; the instruction has no delay slot. */
  readonly eretTargetPc?: number;
  readonly exception?: PendingException;
  readonly outOfDomain?: ExecutionDiagnostic;
}

const controlTransferKinds = new Set(['branch', 'jump', 'jump-register', 'eret']);

export function evaluateInstruction(context: TransitionContext): InstructionEffect {
  const { profile, state, memory, scope } = context;
  const pcBefore = u32(state.pc);
  const pending = state.pendingBranch;
  const delaySlot = pending !== undefined;
  const sequential = u32(pcBefore + 4);
  const fallThrough = pending ? u32(pending.targetPc) : sequential;
  const base = {
    pcBefore,
    nextPc: fallThrough,
    delaySlot,
    ...(pending ? { branchOriginPc: pending.originPc } : {}),
    controlTransfer: false,
    gprWrites: [] as RegisterWrite[],
    hiLoWrites: [] as HiLoWrite[],
    cp0Writes: [] as Cp0Write[]
  };

  // ── F stage ────────────────────────────────────────────────────────────────
  const fetched = memory.fetch(pcBefore);
  if (fetched.fault) {
    if (fetched.fault.reason === 'unloaded-instruction') {
      return {
        ...base,
        outOfDomain: executionDiagnostic('unloaded-instruction', fetched.fault.message, {
          pc: pcBefore, contractId: 'COURSE-P7-UNLOADED-IM-001'
        })
      };
    }
    return withFault(base, profile, fetched.fault, 'fetch', pcBefore);
  }
  const word = u32(fetched.word ?? 0);

  // ── D stage ────────────────────────────────────────────────────────────────
  const match = matchRuntimeInstruction(word, scope);
  if (!match) {
    if (profile.exceptions) {
      return {
        ...base,
        word,
        exception: {
          name: 'ri', stage: 'decode',
          message: `${hex8Address(pcBefore)} 的机器码 ${hex8Address(word)} 不在 profile ${profile.id} 的运行期指令集内`
        }
      };
    }
    return {
      ...base,
      word,
      outOfDomain: executionDiagnostic(
        'unrecognized-instruction',
        `${hex8Address(pcBefore)} 的机器码 ${hex8Address(word)} 不在 profile ${profile.id} 的指令集内`,
        { pc: pcBefore, instructionWord: word }
      )
    };
  }
  const entry = match.exactInstruction;
  if (!entry) {
    // Runtime recognition succeeded on opcode/funct, but the secondary selector
    // (REGIMM rt / COP0 rs) has no course semantics. The course guarantees such
    // encodings do not appear in tests, so fail closed instead of inventing one.
    return {
      ...base,
      word,
      outOfDomain: executionDiagnostic(
        'unrecognized-instruction',
        `${hex8Address(pcBefore)} 的机器码 ${hex8Address(word)} 命中 `
        + `${match.candidates.map((item) => item.mnemonic).join('/')} 的 opcode，但次级选择域没有课程语义`,
        { pc: pcBefore, instructionWord: word }
      )
    };
  }

  const decoded = { ...base, word, mnemonic: entry.mnemonic };
  if (delaySlot && profile.delaySlot && controlTransferKinds.has(entry.controlKind)) {
    return {
      ...decoded,
      outOfDomain: executionDiagnostic(
        'double-delay-slot',
        `${hex8Address(pcBefore)} 在延迟槽内再次执行控制转移指令 ${entry.mnemonic}`,
        { pc: pcBefore, instructionWord: word, contractId: 'COURSE-P56-DOMAIN-001' }
      )
    };
  }

  return dispatch(context, decoded, entry, {
    pcBefore, sequential, fallThrough, delaySlot, word
  });
}

interface DispatchInput {
  readonly pcBefore: number;
  readonly sequential: number;
  readonly fallThrough: number;
  readonly delaySlot: boolean;
  readonly word: number;
}

type DecodedBase = InstructionEffect & { readonly word: number; readonly mnemonic: string };

function dispatch(
  context: TransitionContext,
  decoded: DecodedBase,
  entry: IsaInstructionEntry,
  input: DispatchInput
): InstructionEffect {
  const { profile, state } = context;
  const { word, pcBefore, sequential } = input;
  const handler = entry.semanticHandlerId;
  const rsIndex = (word >>> 21) & 0x1f;
  const rtIndex = (word >>> 16) & 0x1f;
  const rdIndex = (word >>> 11) & 0x1f;
  const shamt = (word >>> 6) & 0x1f;
  const immediate = word & 0xffff;
  const jumpIndex = word & 0x03ff_ffff;
  const rsValue = state.gpr.read(rsIndex);
  const rtValue = state.gpr.read(rtIndex);

  if (handler === 'nop') {
    return decoded;
  }

  // ── E stage: register/immediate ALU ───────────────────────────────────────
  const registerResult = registerAlu(handler, rsValue, rtValue, shamt);
  if (registerResult) {
    if (registerResult.overflow && profile.overflow === 'trap') {
      return overflowException(decoded, entry.mnemonic, pcBefore);
    }
    return { ...decoded, gprWrites: [{ register: rdIndex, value: registerResult.value }] };
  }
  const immediateResult = immediateAlu(handler, rsValue, immediate);
  if (immediateResult) {
    if (immediateResult.overflow && profile.overflow === 'trap') {
      return overflowException(decoded, entry.mnemonic, pcBefore);
    }
    return { ...decoded, gprWrites: [{ register: rtIndex, value: immediateResult.value }] };
  }

  switch (handler) {
    case 'movz':
    case 'movn': {
      const move = handler === 'movz' ? u32(rtValue) === 0 : u32(rtValue) !== 0;
      return move ? { ...decoded, gprWrites: [{ register: rdIndex, value: rsValue }] } : decoded;
    }

    case 'mfhi':
    case 'mflo': {
      const defined = handler === 'mfhi' ? state.hiDefined : state.loDefined;
      const value = handler === 'mfhi' ? state.hi : state.lo;
      if (!defined) {
        if (context.undefinedBehavior === 'fail-closed') {
          return {
            ...decoded,
            outOfDomain: executionDiagnostic(
              'undefined-hi-lo-read',
              `${hex8Address(pcBefore)} 执行 ${entry.mnemonic}，但 ${handler === 'mfhi' ? 'HI' : 'LO'} 尚未由乘除或 mthi/mtlo 定义`,
              { pc: pcBefore, instructionWord: word, contractId: 'COURSE-P56-DOMAIN-001' }
            )
          };
        }
        return { ...decoded, gprWrites: [{ register: rdIndex, value, defined: false }] };
      }
      return { ...decoded, gprWrites: [{ register: rdIndex, value }] };
    }

    case 'mthi':
      return { ...decoded, hiLoWrites: [{ register: 'hi', value: rsValue }] };
    case 'mtlo':
      return { ...decoded, hiLoWrites: [{ register: 'lo', value: rsValue }] };

    case 'mult':
    case 'multu':
    case 'div':
    case 'divu':
    case 'madd':
    case 'maddu':
    case 'msub':
    case 'msubu':
      return multiplyDivideEffect(context, decoded, entry, {
        handler, rsValue, rtValue, pcBefore, word
      });

    case 'mul': {
      // MIPS32 MUL writes only its GPR destination; HI/LO become UNPREDICTABLE.
      const product = low32(multiplySigned64(rsValue, rtValue));
      return {
        ...decoded,
        gprWrites: [{ register: rdIndex, value: product }],
        invalidateHiLo: true
      };
    }

    case 'jr':
      return {
        ...decoded,
        controlTransfer: true,
        ...controlTransferTargets(profile, pcBefore, sequential, u32(rsValue), true)
      };

    case 'jalr': {
      const destination = rdIndex === 0 ? 31 : rdIndex;
      if (rsIndex === destination) {
        if (context.undefinedBehavior === 'fail-closed') {
          return {
            ...decoded,
            outOfDomain: executionDiagnostic(
              'jalr-same-register',
              `${hex8Address(pcBefore)} 执行 jalr，目标与链接寄存器同为 $${rsIndex}`,
              { pc: pcBefore, instructionWord: word, contractId: 'COURSE-P56-DOMAIN-001' }
            )
          };
        }
      }
      return {
        ...decoded,
        controlTransfer: true,
        gprWrites: [{ register: destination, value: u32(pcBefore + profile.linkOffset) }],
        ...controlTransferTargets(profile, pcBefore, sequential, u32(rsValue), true)
      };
    }

    case 'j':
    case 'jal': {
      const target = u32((sequential & 0xf000_0000) | (jumpIndex << 2));
      const link: RegisterWrite[] = handler === 'jal'
        ? [{ register: 31, value: u32(pcBefore + profile.linkOffset) }]
        : [];
      return {
        ...decoded,
        controlTransfer: true,
        gprWrites: link,
        ...controlTransferTargets(profile, pcBefore, sequential, target, true)
      };
    }

    case 'beq':
    case 'bne':
    case 'blez':
    case 'bgtz':
    case 'bltz':
    case 'bgez':
    case 'bltzal':
    case 'bgezal': {
      const taken = branchCondition(handler, rsValue, rtValue) === true;
      const target = u32(sequential + (signExtend16(immediate) << 2));
      // MIPS writes the link register of BLTZAL/BGEZAL unconditionally.
      const link: RegisterWrite[] = handler === 'bltzal' || handler === 'bgezal'
        ? [{ register: 31, value: u32(pcBefore + profile.linkOffset) }]
        : [];
      return {
        ...decoded,
        controlTransfer: true,
        gprWrites: link,
        ...controlTransferTargets(profile, pcBefore, sequential, target, taken)
      };
    }

    case 'syscall':
      if (!profile.exceptions) {
        return unsupportedInCourseProfile(decoded, profile, entry.mnemonic, pcBefore, word);
      }
      return {
        ...decoded,
        exception: {
          name: 'syscall', stage: 'decode',
          message: `${hex8Address(pcBefore)} 执行 syscall`
        }
      };

    case 'tge':
    case 'tgeu':
    case 'tlt':
    case 'tltu':
    case 'teq':
    case 'tne':
    case 'tgei':
    case 'tgeiu':
    case 'tlti':
    case 'tltiu':
    case 'teqi':
    case 'tnei': {
      const taken = immediateTrapHandlers.has(handler)
        ? immediateTrapCondition(handler, rsValue, immediate) === true
        : trapCondition(handler, rsValue, rtValue) === true;
      if (!taken) {
        return decoded;
      }
      return {
        ...decoded,
        outOfDomain: executionDiagnostic(
          'unsupported-instruction',
          `${hex8Address(pcBefore)} 的 ${entry.mnemonic} 条件成立，但课程契约没有定义 Tr 异常码`,
          { pc: pcBefore, instructionWord: word }
        )
      };
    }

    case 'mfc0':
    case 'mtc0':
    case 'eret':
      return cp0Effect(context, decoded, entry, { rtIndex, rdIndex, rtValue, pcBefore, word });

    case 'lb':
    case 'lbu':
    case 'lh':
    case 'lhu':
    case 'lw':
    case 'lwl':
    case 'lwr':
      return loadEffect(context, decoded, entry, {
        handler, rsValue, rtIndex, rtValue, immediate, pcBefore, word
      });

    case 'sb':
    case 'sh':
    case 'sw':
    case 'swl':
    case 'swr':
      return storeEffect(context, decoded, entry, {
        handler, rsValue, rtValue, immediate, pcBefore, word
      });

    default:
      return unsupportedInCourseProfile(decoded, profile, entry.mnemonic, pcBefore, word);
  }
}

const immediateTrapHandlers = new Set([
  'tgei', 'tgeiu', 'tlti', 'tltiu', 'teqi', 'tnei'
]);

// ── helpers ──────────────────────────────────────────────────────────────────

function controlTransferTargets(
  profile: CourseExecutionProfile,
  pcBefore: number,
  sequential: number,
  target: number,
  taken: boolean
): Pick<InstructionEffect, 'nextPc' | 'pendingBranch' | 'branchTaken' | 'controlTarget'> {
  if (!profile.delaySlot) {
    return {
      nextPc: taken ? u32(target) : sequential,
      branchTaken: taken,
      controlTarget: taken ? u32(target) : sequential
    };
  }
  // The delay slot always executes; a not-taken branch falls through to pc + 8.
  const resolved = taken ? u32(target) : u32(pcBefore + 8);
  return {
    nextPc: sequential,
    pendingBranch: { targetPc: resolved, originPc: pcBefore },
    branchTaken: taken,
    controlTarget: resolved
  };
}

function overflowException(
  decoded: DecodedBase,
  mnemonic: string,
  pcBefore: number
): InstructionEffect {
  return {
    ...decoded,
    gprWrites: [],
    exception: {
      name: 'ov', stage: 'execute',
      message: `${hex8Address(pcBefore)} 的 ${mnemonic} 发生有符号 32 位溢出`
    }
  };
}

function unsupportedInCourseProfile(
  decoded: DecodedBase,
  profile: CourseExecutionProfile,
  mnemonic: string,
  pcBefore: number,
  word: number
): InstructionEffect {
  return {
    ...decoded,
    outOfDomain: executionDiagnostic(
      'unsupported-instruction',
      `${hex8Address(pcBefore)} 的 ${mnemonic} 没有 profile ${profile.id} 的课程语义`,
      { pc: pcBefore, instructionWord: word }
    )
  };
}

function multiplyDivideEffect(
  context: TransitionContext,
  decoded: DecodedBase,
  entry: IsaInstructionEntry,
  input: {
    readonly handler: string;
    readonly rsValue: number;
    readonly rtValue: number;
    readonly pcBefore: number;
    readonly word: number;
  }
): InstructionEffect {
  const { state } = context;
  const { handler, rsValue, rtValue, pcBefore, word } = input;
  const dividesByZero = (handler === 'div' || handler === 'divu') && u32(rtValue) === 0;
  if (dividesByZero && context.undefinedBehavior === 'fail-closed') {
    return {
      ...decoded,
      outOfDomain: executionDiagnostic(
        'divide-by-zero',
        `${hex8Address(pcBefore)} 执行 ${entry.mnemonic}，除数寄存器为 0（课程未定义行为 DivZero）`,
        { pc: pcBefore, instructionWord: word, contractId: 'COURSE-P56-DOMAIN-001' }
      )
    };
  }
  const accumulates = handler.startsWith('madd') || handler.startsWith('msub');
  if (accumulates && !(state.hiDefined && state.loDefined)) {
    if (context.undefinedBehavior === 'fail-closed') {
      return {
        ...decoded,
        outOfDomain: executionDiagnostic(
          'undefined-hi-lo-read',
          `${hex8Address(pcBefore)} 执行 ${entry.mnemonic}，但 HI/LO 尚未全部定义`,
          { pc: pcBefore, instructionWord: word, contractId: 'COURSE-P56-DOMAIN-001' }
        )
      };
    }
  }
  if (dividesByZero) {
    return {
      ...decoded,
      hiLoWrites: [
        { register: 'hi', value: 0, defined: false },
        { register: 'lo', value: 0, defined: false }
      ]
    };
  }
  const result = multiplyDivide(handler, rsValue, rtValue, state.hi, state.lo);
  if (!result) {
    return unsupportedInCourseProfile(decoded, context.profile, entry.mnemonic, pcBefore, word);
  }
  const defined = !accumulates || (state.hiDefined && state.loDefined);
  return {
    ...decoded,
    hiLoWrites: [
      { register: 'hi', value: result.hi, ...(defined ? {} : { defined: false }) },
      { register: 'lo', value: result.lo, ...(defined ? {} : { defined: false }) }
    ]
  };
}

function cp0Effect(
  context: TransitionContext,
  decoded: DecodedBase,
  entry: IsaInstructionEntry,
  input: {
    readonly rtIndex: number;
    readonly rdIndex: number;
    readonly rtValue: number;
    readonly pcBefore: number;
    readonly word: number;
  }
): InstructionEffect {
  const { profile, state } = context;
  const { rtIndex, rdIndex, rtValue, pcBefore, word } = input;
  if (!profile.exceptions || !state.cp0) {
    return unsupportedInCourseProfile(decoded, profile, entry.mnemonic, pcBefore, word);
  }
  const cp0 = state.cp0;
  if (entry.semanticHandlerId === 'eret') {
    return {
      ...decoded,
      controlTransfer: true,
      eretTargetPc: u32(cp0.epc),
      nextPc: u32(cp0.epc),
      cp0Writes: [{
        register: cp0RegisterNumbers.status,
        valueBefore: cp0.status,
        value: u32(cp0.status & ~profile.exceptions.cp0.statusExceptionLevelBit)
      }]
    };
  }
  if (entry.semanticHandlerId === 'mfc0') {
    if (!cp0.isReadable(rdIndex)) {
      return unsupportedCp0(decoded, 'mfc0', rdIndex, pcBefore, word);
    }
    return { ...decoded, gprWrites: [{ register: rtIndex, value: cp0.read(rdIndex) }] };
  }
  if (!cp0.isWritable(rdIndex)) {
    return unsupportedCp0(decoded, 'mtc0', rdIndex, pcBefore, word);
  }
  return {
    ...decoded,
    cp0Writes: [{
      register: rdIndex,
      valueBefore: cp0.read(rdIndex),
      value: cp0.maskedWrite(rdIndex, rtValue)
    }]
  };
}

function unsupportedCp0(
  decoded: DecodedBase,
  mnemonic: string,
  register: number,
  pcBefore: number,
  word: number
): InstructionEffect {
  return {
    ...decoded,
    outOfDomain: executionDiagnostic(
      'unsupported-instruction',
      `${hex8Address(pcBefore)} 的 ${mnemonic} 访问课程未实现的 CP0 寄存器 $${register}`,
      { pc: pcBefore, instructionWord: word, contractId: 'COURSE-P7-CP0-001' }
    )
  };
}

interface EffectiveAddress {
  readonly address: number;
  readonly overflow: boolean;
}

/** `base + signExtend(offset)`; a signed 32-bit overflow is an address error. */
export function effectiveAddress(base: number, immediate: number): EffectiveAddress {
  const { result, overflow } = addSigned32WithOverflow(base, signExtend16(immediate));
  return { address: result, overflow };
}

function loadEffect(
  context: TransitionContext,
  decoded: DecodedBase,
  entry: IsaInstructionEntry,
  input: {
    readonly handler: string;
    readonly rsValue: number;
    readonly rtIndex: number;
    readonly rtValue: number;
    readonly immediate: number;
    readonly pcBefore: number;
    readonly word: number;
  }
): InstructionEffect {
  const { profile, memory } = context;
  const { handler, rsValue, rtIndex, rtValue, immediate, pcBefore } = input;
  const access = entry.memoryAccess;
  if (!access) {
    return unsupportedInCourseProfile(decoded, profile, entry.mnemonic, pcBefore, input.word);
  }
  const { address, overflow } = effectiveAddress(rsValue, immediate);
  const partial = handler === 'lwl' || handler === 'lwr';
  const prepared = memory.prepare({
    kind: 'load',
    address,
    width: partial ? 4 : (access.width as 1 | 2 | 4),
    ...(partial ? { alignment: 1 as const } : {}),
    addressOverflow: overflow
  });
  if (isMemoryFault(prepared)) {
    return withFault(decoded, profile, prepared, 'load', address);
  }
  const wordValue = memory.readWord(prepared);
  const value = partial
    ? (handler === 'lwl'
      ? loadWordLeft(rtValue, wordValue, address)
      : loadWordRight(rtValue, wordValue, address))
    : memory.read(prepared, access.signExtend);
  return {
    ...decoded,
    gprWrites: [{ register: rtIndex, value }],
    load: { prepared, wordValue, value },
    ...(prepared.device ? { deviceAccess: prepared.device } : {})
  };
}

function storeEffect(
  context: TransitionContext,
  decoded: DecodedBase,
  entry: IsaInstructionEntry,
  input: {
    readonly handler: string;
    readonly rsValue: number;
    readonly rtValue: number;
    readonly immediate: number;
    readonly pcBefore: number;
    readonly word: number;
  }
): InstructionEffect {
  const { profile, memory } = context;
  const { handler, rsValue, rtValue, immediate, pcBefore } = input;
  const access = entry.memoryAccess;
  if (!access) {
    return unsupportedInCourseProfile(decoded, profile, entry.mnemonic, pcBefore, input.word);
  }
  const { address, overflow } = effectiveAddress(rsValue, immediate);
  const partial = handler === 'swl'
    ? storeWordLeft(rtValue, address)
    : handler === 'swr' ? storeWordRight(rtValue, address) : undefined;
  const prepared = memory.prepare({
    kind: 'store',
    address,
    width: partial ? 4 : (access.width as 1 | 2 | 4),
    ...(partial ? { alignment: 1 as const, byteMask: partial.byteMask } : {}),
    addressOverflow: overflow,
    value: partial ? partial.word : rtValue
  });
  if (isMemoryFault(prepared)) {
    return withFault(decoded, profile, prepared, 'store', address);
  }
  const rawValue = partial ? partial.word : u32(rtValue);
  const { valueBefore, valueAfter } = memory.storePreview(prepared, rawValue);
  return {
    ...decoded,
    store: { prepared, rawValue, valueBefore, valueAfter },
    ...(prepared.device ? { deviceAccess: prepared.device } : {})
  };
}

function isMemoryFault(value: PreparedMemoryAccess | MemoryFault): value is MemoryFault {
  return (value as MemoryFault).reason !== undefined;
}

/** Map a bus fault to an architectural exception (P7) or an out-of-domain classification. */
function withFault<T extends InstructionEffect>(
  effect: T,
  profile: CourseExecutionProfile,
  fault: MemoryFault,
  direction: 'fetch' | 'load' | 'store',
  address: number
): InstructionEffect {
  if (fault.reason === 'device-schedule-missing') {
    // A Timer transaction without a declared cycle schedule is out of the
    // comparable domain, never an architectural address error (计划第 5.4 节).
    return {
      ...effect,
      gprWrites: [],
      outOfDomain: executionDiagnostic('device-schedule-missing', fault.message, {
        pc: effect.pcBefore, address, contractId: 'COURSE-P7-TIMER-MODE-001'
      })
    };
  }
  if (profile.exceptions) {
    const stage: ExceptionStage = direction === 'fetch' ? 'fetch' : 'memory';
    return {
      ...effect,
      gprWrites: [],
      exception: {
        name: direction === 'store' ? 'ades' : 'adel',
        stage,
        address,
        message: fault.message
      }
    };
  }
  const reason: OutOfDomainReason = fault.reason === 'misaligned'
    ? 'misaligned-access'
    : 'address-out-of-region';
  return {
    ...effect,
    gprWrites: [],
    outOfDomain: executionDiagnostic(reason, fault.message, {
      pc: effect.pcBefore, address, contractId: 'COURSE-P56-DOMAIN-001'
    })
  };
}

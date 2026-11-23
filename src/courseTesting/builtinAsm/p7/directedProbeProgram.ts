// @index p7-probe — Shared assembly and CP0 record protocol for directed P7 programs
import { randomBytes } from 'crypto';
import { generatedSourceMnemonics } from '../customGeneratorCompatibility';
import { ProgramWriter } from '../programWriter';
import { BuiltinAsmGeneratorError, BuiltinAsmGeneratorOptions, BuiltinAsmGeneratorResult, resolveBuiltinInstructionSet } from '../randomBody';
import type { P7ProbeCommitExpectation, P7ProbeMetadata, P7ProbeScenario, P7ProbeScenarioKind } from '../types';
import {
  p7CauseExcCodeMask, p7DataMemoryWords, p7ExceptionHandlerAddress, p7Hardware, p7Hex, p7ProbeEretPoisonAddress,
  p7ProbeLogBase, p7ProbeMagic, p7ProbeRecordWords, p7UserTextBaseAddress
} from './constants';
import { emitClearTimers, emitLoadImmediate } from './probeAsm';
import { expectedExcCode, expectedIpMask } from './probeScenarios';

type DirectedShard = 'architecture' | 'im-boundaries';
type DirectedCase = { id: number; kind: P7ProbeScenarioKind; variant: string; resume: string };
type CaseObservations = Pick<P7ProbeScenario, 'victimPc' | 'waitPc' | 'requiredPreHandlerCommits'
  | 'requiredCommits' | 'forbiddenCommitPcs'> & {
    statusBeforeException: number;
    allowedEpc: number[];
    ipMask?: number;
    bd?: boolean;
  };

export class DirectedProbeProgram {
  readonly main = new ProgramWriter(p7UserTextBaseAddress);
  private readonly scenarios: P7ProbeScenario[] = [];
  private readonly initialCp0: NonNullable<P7ProbeMetadata['initialCp0']> = {};
  private readonly seed: string;
  private readonly instructionSet: string[];

  constructor(private readonly options: BuiltinAsmGeneratorOptions, private readonly shard: DirectedShard) {
    if (options.profile !== 'P7') throw new BuiltinAsmGeneratorError('Directed P7 probes require the P7 profile.');
    this.instructionSet = resolveBuiltinInstructionSet(options.profile, options.instructionText, options.customRegistry).mnemonics;
    this.seed = options.seed?.trim() || `${Date.now()}-${randomBytes(4).toString('hex')}`;
    for (const line of [
      '# Built-in BUAA CO P7 probe ASM test', '# profile: P7', `# seed: ${this.seed}`,
      `# generated: ${(options.generatedAt ?? new Date()).toISOString()}`, `# instruction_set: ${this.instructionSet.join(' ')}`,
      `# probe_shard: ${shard}`, '.data', `    .space ${p7DataMemoryWords * 4}`, '.text', '.globl main'
    ]) this.main.raw(line);
    this.main.label('main');
  }

  next(kind: P7ProbeScenarioKind, variant: string): DirectedCase {
    const id = this.scenarios.length + 1;
    return { id, kind, variant, resume: `_co_directed_s${id}_resume` };
  }

  prepare(item: DirectedCase): void {
    const { main } = this;
    main.raw(`\n# probe scenario ${item.id}: ${item.kind}/${item.variant}`);
    main.emit(`ori $16, $0, ${item.id}`);
    main.emit(`ori $17, $0, ${p7Hardware.probe.kind[item.kind]}`);
    main.emit(`ori $18, $0, ${item.resume}`);
  }

  complete(item: DirectedCase, observations: CaseObservations): P7ProbeScenario {
    const { statusBeforeException, allowedEpc, ipMask = expectedIpMask(item.kind), bd, ...commits } = observations;
    this.main.label(item.resume);
    const donePc = this.main.pc();
    this.main.emit(`ori $1, $0, ${item.id}`);
    const branchDelay = bd === undefined ? {} : { expectedBd: bd };
    const scenario: P7ProbeScenario = {
      id: item.id, kind: item.kind, variant: item.variant, expectedExcCode: expectedExcCode(item.kind),
      expectedIpMask: ipMask, allowedEpc, ...branchDelay, donePc, requireCompletion: true, ...commits,
      expectedRecords: [{ expectedIpMask: ipMask, expectedExcCode: expectedExcCode(item.kind),
        statusBeforeException, ...branchDelay, allowedEpc }]
    };
    this.scenarios.push(scenario);
    return scenario;
  }

  observeResetCp0(): void {
    for (const [field, register, address] of [['status', 12, 0x610], ['cause', 13, 0x614], ['epc', 14, 0x618]] as const) {
      this.main.emit(`mfc0 $8, $${register}`);
      this.initialCp0[field] = expectStore(this.main, `sw $8, ${address}($0)`, address, 0);
    }
  }

  handler(naturalEntry?: string): ProgramWriter {
    const handler = new ProgramWriter(p7ExceptionHandlerAddress);
    // An IM-boundary program uses one continuous .text image, including the physical vector.
    // The course assembler's .ktext section otherwise reserves space only through 0x4ffc.
    handler.raw(`${naturalEntry ? '.text' : '.ktext'} ${p7Hex(p7ExceptionHandlerAddress)}`);
    handler.emit('mfc0 $24, $12');
    if (naturalEntry) {
      handler.emit('andi $27, $24, 2');
      handler.emit(`beq $27, $0, ${naturalEntry}`);
      handler.emit('nop');
    } else {
      // At reset the first instruction is a syscall. Initialize its record and return route
      // here, using reset GPR state before main has executed any setup or mtc0.
      handler.emit('bne $16, $0, _co_directed_capture');
      handler.emit('nop');
      handler.emit('ori $16, $0, 1');
      handler.emit(`ori $17, $0, ${p7Hardware.probe.kind.syscall}`);
      handler.emit(`ori $18, $0, _co_directed_s1_resume`);
    }
    handler.label('_co_directed_capture');
    handler.emit('mfc0 $25, $13');
    handler.emit('mfc0 $26, $14');
    emitLoadImmediate(handler, '$27', p7ProbeMagic);
    for (const [index, register] of [27, 16, 17, 24, 25, 26, 0, 0].entries()) {
      handler.emit(`sw $${register}, ${p7Hex(p7ProbeLogBase + index * 4)}($19)`);
    }
    handler.emit(`addi $19, $19, ${p7ProbeRecordWords * 4}`);
    handler.emit(`andi $27, $25, ${p7Hex(p7CauseExcCodeMask)}`);
    handler.emit('bne $27, $0, _co_directed_return');
    handler.emit('nop');
    emitClearTimers(handler);
    handler.label('_co_directed_return');
    handler.emit('mtc0 $18, $14');
    handler.emit('eret');
    handler.emit(`sw $0, ${p7Hex(p7ProbeEretPoisonAddress)}($0)`);
    return handler;
  }

  finish(...segments: ProgramWriter[]): BuiltinAsmGeneratorResult {
    this.main.label('_co_directed_halt');
    this.main.emit('beq $0, $0, _co_directed_halt');
    this.main.emit('nop');
    if (this.main.pc() > p7ExceptionHandlerAddress || this.scenarios.length > p7Hardware.probe.maxScenarioCount) {
      throw new BuiltinAsmGeneratorError('Directed P7 probe exceeds its user-text or record budget.');
    }
    const text = [...this.main.render(), ...segments.flatMap(segment => segment.render())].join('\n') + '\n';
    return {
      text, seed: this.seed, profile: 'P7', instructionSet: this.instructionSet, instructionCount: this.main.count(),
      usedInstructions: [...new Set(generatedSourceMnemonics(text))].sort(), interruptSchedule: [], mode: 'probe',
      probe: { version: 1, shard: this.shard, scope: 'standard', logBase: p7ProbeLogBase, recordWords: p7ProbeRecordWords,
        ...(Object.keys(this.initialCp0).length ? { initialCp0: this.initialCp0 } : {}), scenarios: this.scenarios }
    };
  }
}

export function expectStore(writer: ProgramWriter, instruction: string, target: number, value: number): P7ProbeCommitExpectation {
  const pc = writer.pc();
  writer.emit(instruction);
  return { pc, kind: 'dm', target, value };
}

export function expectRegister(writer: ProgramWriter, instruction: string, target: number, value: number): P7ProbeCommitExpectation {
  const pc = writer.pc();
  writer.emit(instruction);
  return { pc, kind: 'grf', target, value };
}

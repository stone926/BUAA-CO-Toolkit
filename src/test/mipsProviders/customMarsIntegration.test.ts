import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import { createTestServices } from '../helpers/appServices';

const state = vi.hoisted(() => ({ root: '', profile: 'P5', jar: '', timeout: 30000 }));
vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('../helpers/vscodeMock');
  const mock = createVscodeModuleMock(createVscodeMockState(), vi.fn);
  mock.workspace.getWorkspaceFolder = () => ({ uri: URI.file(state.root), name: 'custom' });
  mock.workspace.fs.readFile.mockImplementation((uri) => fs.readFile(uri.fsPath));
  mock.workspace.fs.writeFile.mockImplementation((uri, bytes) => fs.writeFile(uri.fsPath, bytes));
  mock.workspace.fs.createDirectory.mockImplementation(async (uri) => { await fs.mkdir(uri.fsPath, { recursive: true }); });
  return mock;
});
vi.mock('../../config', () => ({
  getProfile: () => state.profile, getMarsJar: () => state.jar, getJava: () => 'java',
  getRunTimeout: () => state.timeout, getMemoryConfiguration: () => 'Default',
  useDelayedBranching: () => ['P5', 'P6', 'P7'].includes(state.profile),
  getMachineCode: () => 'code.txt', shouldRevealOutput: () => false
}));
import { createAsmCaseFromAsm, prepareAsmCaseMachineCode, recordAsmCaseOracleResult, updateAsmCaseArtifacts } from '../../asmCaseStore';
import { executeWithPreflight } from '../../mips/providers/providerResolver';
import { resolveCourseEnginePlan } from '../../mips/providers/courseEnginePolicy';
import { courseProgramImagePolicyIssues } from '../../courseTesting/pipeline/courseImagePolicy';
import { runCustomMarsConsole } from '../../mips/host/customMarsConsole';
import { runMarsFile } from '../../mips';
import type { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { buildTestbench, parseModules } from '../../language/verilog/parser';
import { compareTraceIterables } from '../../language/mips/traceCompare';
import { iterCpuTraceEvents } from '../../language/mips/traceParser';
import { runProcessCore } from '../../processCore';
import { resolveIverilogRuntime, buildIverilogEnvironment, buildIverilogRuntimeArgs, buildIverilogIncludeArgs } from '../../verilog/iverilogRuntime';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { courseInstructionImageWords, wordsToHexText } from '../../mips/core/assembler/artifacts';
import { runLiveP7CpuProbe } from '../helpers/liveP7Cpu';

const jar = process.env.CO_MARS_JAR;
const fixtures = process.env.CO_CUSTOM_INSTRUCTION_FIXTURES;
describe.runIf(Boolean(jar && fixtures))('real custom Mars provider, case evidence and immutable class closure', () => {
  beforeEach(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-custom-mars-真实 空格-'));
    state.jar = jar!; state.profile = 'P5';
    await fs.mkdir(path.join(state.root, '.co', 'custom-instructions'), { recursive: true });
  });
  afterEach(async () => {
    expect(path.dirname(path.resolve(state.root))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(state.root)).toMatch(/^co-custom-mars-/);
    await fs.rm(state.root, { recursive: true, force: true });
  });
  async function create(profile: CourseProfile, fixture: string, instruction: string, prefix = '', sourceText?: string) {
    state.profile = profile;
    await fs.copyFile(path.join(fixtures!, fixture), path.join(state.root, '.co', 'custom-instructions', path.basename(fixture)));
    const source = URI.file(path.join(state.root, '程序.asm'));
    await fs.writeFile(source.fsPath, sourceText ?? `${prefix}.text\nori $1,$0,1\nori $2,$0,2\n${instruction}\nhalt: beq $0,$0,halt\nnop\n`);
    const services = createTestServices();
    const asmCase = await createAsmCaseFromAsm(source, { resource: source, enginePlan: resolveCourseEnginePlan('auto', profile) });
    const dump = await prepareAsmCaseMachineCode(services, asmCase, { resource: source, courseTrace: true,
      enginePlan: resolveCourseEnginePlan('auto', profile) });
    expect(dump?.ok, dump?.status.stderr).toBe(true);
    expect(dump?.enginePlan?.primaryEngineId).toBe('custom-mars');
    expect(dump?.customInstructionEncodings).toHaveLength(1);
    return { source, services, asmCase, dump: dump! };
  }
  const programs = [
    ['P3', 'P3_L10_addm_2023/files/addm.class', 'addm $3,$1,$2', '00000003'],
    ['P4', 'P4_L10_pcadd_2023/files/pcadd.class', 'pcadd $3,$1', '00003009'],
    ['P5', 'P5_L4_addei_2022/files/addei.class', 'addei $3,$1,2', 'ffff0003'],
    ['P6', 'P5_L4_addei_2022/files/addei.class', 'addei $3,$1,2', 'ffff0003'],
    ['P7', 'P5_L4_addei_2022/files/addei.class', 'addei $3,$1,2', 'ffff0003']
  ] as const;
  it.each(programs)('%s binds the external assembler and oracle and records complete text evidence', async (profile, fixture, instruction, value) => {
    const { services, asmCase, dump } = await create(profile, fixture, instruction);
    expect(courseProgramImagePolicyIssues(profile, dump.image!, dump.courseHaltPc)).toEqual([]);
    const execution = await executeWithPreflight(services, { image: dump.image!, executionBinding: dump.executionBinding,
      profile, requirements: { profile }, courseTrace: true, haltPc: dump.courseHaltPc, maxSteps: 1000,
      runOutputFile: URI.file(path.join(asmCase.dir.fsPath, 'oracle', 'trace.out')) }, undefined, dump.enginePlan);
    expect(execution.result?.ok, execution.result?.status.stderr).toBe(true);
    expect(execution.result?.trace?.rawText).toContain(value);
    expect(execution.result?.engineArtifact).toEqual(dump.engineArtifact);
    await updateAsmCaseArtifacts(asmCase, 'oracle', { traceOut: execution.result!.outputFile!.fsPath });
    await recordAsmCaseOracleResult(asmCase, execution.result!, { profile, memoryConfiguration: 'course-contract-v1',
      courseTrace: true, maxSteps: 1000, haltPc: dump.courseHaltPc }, { stopReason: 'halt-loop' });
    const saved = JSON.parse(await fs.readFile(asmCase.manifestUri.fsPath, 'utf8'));
    expect(saved.oracle.engine.id).toBe('custom-mars');
    expect(saved.oracle.engine.artifact.dependencies.length).toBe(2);
    expect(saved.metadata['reference.javaVersion']).toBeTruthy();
  });
  it('uses frozen class bytes if the workspace class is replaced after assembly', async () => {
    const { services, asmCase, dump } = await create('P5', programs[2][1], programs[2][2]);
    await fs.writeFile(path.join(state.root, '.co', 'custom-instructions', 'addei.class'), 'invalid class bytes');
    const execution = await executeWithPreflight(services, { image: dump.image!, executionBinding: dump.executionBinding,
      profile: 'P5', courseTrace: true, haltPc: dump.courseHaltPc, maxSteps: 1000,
      runOutputFile: URI.file(path.join(asmCase.dir.fsPath, 'oracle.out')) }, undefined, dump.enginePlan);
    expect(execution.result?.ok, execution.result?.status.stderr).toBe(true);
    const rerun = await prepareAsmCaseMachineCode(services, asmCase, { resource: URI.file(path.join(state.root, '程序.asm')),
      courseTrace: true, expectedEngineArtifact: dump.engineArtifact, enginePlan: resolveCourseEnginePlan('mars', 'P5') });
    expect(rerun?.ok).toBe(false);
    expect(rerun?.status.stderr).toContain('原测试点记录的版本不同');
  });
  it('rejects nonzero initial DM before executing the custom oracle', async () => {
    const { services, dump } = await create('P6', programs[2][1], programs[2][2], '.data\n.word 1\n');
    const execution = await executeWithPreflight(services, { image: dump.image!, executionBinding: dump.executionBinding,
      profile: 'P6', courseTrace: true, haltPc: dump.courseHaltPc, maxSteps: 1000 }, undefined, dump.enginePlan);
    expect(execution.ok).toBe(false);
    expect(execution.preflight.diagnostics.some((d) => d.code === 'course-image.nonzero-data-initialization')).toBe(true);
  });
  it('preserves include source locations and real symbols in custom ProgramImage', async () => {
    await fs.writeFile(path.join(state.root, '指令 include.asm'), '.text\ncustom_body:\n  addei $3,$0,2\n');
    const { dump } = await create('P5', programs[2][1], '', '', '.include "指令 include.asm"\n.text\nhalt: beq $0,$0,halt\nnop\n');
    expect(dump.image!.symbols.some((symbol) => symbol.name === 'custom_body' && symbol.value === 0x3000)).toBe(true);
    const mappedIds = new Set(dump.image!.sourceMap.map((entry) => entry.sourceId));
    expect(mappedIds.size).toBe(2);
    expect(dump.image!.inputGraph.every((unit) => mappedIds.has(unit.id))).toBe(true);
  });
  it('keeps active Timer available in custom P7 execution and identifies its reference timing scope', async () => {
    const { services, asmCase, dump } = await create('P7', programs[2][1], '', '',
      '.text\naddei $3,$0,2\nori $8,$0,0x7f00\nori $9,$0,10\nsw $9,4($8)\nori $9,$0,9\nsw $9,0($8)\nlw $10,8($8)\nhalt: beq $0,$0,halt\nnop\n');
    const execution = await executeWithPreflight(services, { image: dump.image!, executionBinding: dump.executionBinding,
      profile: 'P7', courseTrace: true, haltPc: dump.courseHaltPc, maxSteps: 1000,
      runOutputFile: URI.file(path.join(asmCase.dir.fsPath, 'oracle.out')) }, undefined, dump.enginePlan);
    expect(execution.result?.ok, execution.result?.status.stderr).toBe(true);
    expect(execution.result?.referenceTiming).toBe('p7-timer-observed');
    expect(execution.result?.trace?.rawText).not.toContain('*00007f');
  });
  it('keeps ordinary custom execution on console syscalls and preserves stdin', async () => {
    await fs.copyFile(path.join(fixtures!, programs[2][1]), path.join(state.root, '.co', 'custom-instructions', 'addei.class'));
    const source = URI.file(path.join(state.root, '控制台.asm'));
    await fs.writeFile(source.fsPath, '.text\naddei $3,$0,2\nli $v0,5\nsyscall\nmove $a0,$v0\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n');
    const output = await runMarsFile(createTestServices(), source, 'run', { nonInteractive: true, stdin: '42\n' });
    expect(output!.result.ok, output!.result.stderr).toBe(true);
    expect(output!.result.stdout).toBe('42');
    expect(output!.result.commandLine).toContain('co.mars.bridge.Main');
    expect(await fs.readFile(output!.outputFile!.fsPath, 'utf8')).toBe('42');
  });
  it('streams interactive stdin and releases a pending input read when the process exits', async () => {
    await fs.copyFile(path.join(fixtures!, programs[2][1]), path.join(state.root, '.co', 'custom-instructions', 'addei.class'));
    const source = URI.file(path.join(state.root, '交互.asm'));
    await fs.writeFile(source.fsPath, '.text\naddei $3,$0,2\nli $v0,5\nsyscall\nmove $a0,$v0\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n');
    let reads = 0;
    const chunks: string[] = [];
    const output = await runCustomMarsConsole(source, true, { console: {
      write: (text) => { chunks.push(text); },
      readLine: async () => ++reads === 1 ? '73\n' : await new Promise<string | undefined>(() => {})
    } });
    expect(output.result.ok, output.result.stderr).toBe(true);
    expect(output.result.stdout).toBe('73');
    expect(chunks.join('')).toBe('73');
  });
  it('reports ordinary step exhaustion as unfinished and resolves file syscalls beside original ASM', async () => {
    await fs.copyFile(path.join(fixtures!, programs[2][1]), path.join(state.root, '.co', 'custom-instructions', 'addei.class'));
    const source = URI.file(path.join(state.root, '文件.asm'));
    await fs.writeFile(source.fsPath, '.text\naddei $3,$0,2\nloop: beq $0,$0,loop\nnop\n');
    const limited = await runCustomMarsConsole(source, true, { maxSteps: 10 });
    expect(limited.result).toMatchObject({ ok: false, stopReason: 'step-limit' });
    await fs.writeFile(path.join(state.root, 'input.txt'), 'Q');
    await fs.writeFile(source.fsPath, '.data\nfile: .asciiz "input.txt"\nbuf: .space 4\n.text\naddei $3,$0,2\nla $a0,file\nli $a1,0\nli $a2,0\nli $v0,13\nsyscall\nmove $a0,$v0\nla $a1,buf\nli $a2,1\nli $v0,14\nsyscall\nlbu $a0,buf\nli $v0,11\nsyscall\nli $v0,10\nsyscall\n');
    const read = await runCustomMarsConsole(source, true, {});
    expect(read.result.ok, read.result.stderr).toBe(true);
    expect(read.result.stdout).toBe('Q');
  });
  it.runIf(Boolean(process.env.CO_P7_CPU_ROOT))('runs a custom-assembled P7 Timer probe against real RTL with unchanged machine bytes', async () => {
    state.profile = 'P7';
    const javaSource = path.join(state.root, 'coori.java');
    await fs.writeFile(javaSource, `import mars.ProgramStatement;
import mars.ProcessingException;
import mars.mips.instructions.InstructionLoad;
import mars.mips.hardware.RegisterFile;
public class coori implements InstructionLoad {
  public void simulate(ProgramStatement s) throws ProcessingException {
    int[] a=s.getOperands(); RegisterFile.updateRegister(a[0],RegisterFile.getValue(a[1]) | (a[2]&65535));
  }
  public String getTemplate(){return "coori $t1,$t2,100";}
  public String getDescription(){return "ORI alias for integration evidence";}
  public String getFormatStr(){return "I";}
  public String getEncoding(){return "001101 sssss fffff tttttttttttttttt";}
}
`);
    const compiled = await runProcessCore('javac', ['--release', '8', '-encoding', 'UTF-8', '-cp', state.jar,
      '-d', path.join(state.root, '.co', 'custom-instructions'), javaSource], { cwd: state.root, timeoutMs: 30000 });
    expect(compiled.ok, compiled.stderr).toBe(true);
    const generated = generateBuiltinAsmTestCase({ profile: 'P7', instructionText: '', instructionCount: 1118,
      seed: 'live-real-cpu-timer-timer-enabled', p7StressMode: 'probe', probeShard: 'timer',
      probeScenarioCount: 12, interrupt: true, timerInterrupt: true });
    const customSource = generated.text.replace(/^(\s*)ori(?=\s)/m, '$1coori');
    expect(customSource).not.toBe(generated.text);
    const source = URI.file(path.join(state.root, 'Timer 自定义.asm'));
    await fs.writeFile(source.fsPath, customSource);
    const asmCase = await createAsmCaseFromAsm(source, { p7: { probe: generated.probe }, resource: source });
    const dump = await prepareAsmCaseMachineCode(createTestServices(), asmCase, { courseTrace: true,
      enginePlan: resolveCourseEnginePlan('auto', 'P7') });
    expect(dump?.ok, dump?.status.stderr).toBe(true);
    expect(dump?.descriptor.id).toBe('custom-mars');
    const baseline = assembleCourseSource({ id: 'timer', text: generated.text }, { profile: 'P7' });
    expect(baseline.ok).toBe(true);
    const actualBytes = await fs.readFile(asmCase.machineCode.fsPath, 'utf8');
    expect(actualBytes).toBe(wordsToHexText(courseInstructionImageWords(baseline.image!)));
    const live = await runLiveP7CpuProbe({ cpuRoot: process.env.CO_P7_CPU_ROOT!, machineCodeText: actualBytes,
      sourceAsm: customSource, probe: generated.probe!, haltPc: dump!.courseHaltPc!,
      customInstructionEncodings: dump!.customInstructionEncodings,
      evidenceDir: path.join(process.cwd(), '.co', 'verification', 'p7-stone-live-probes', 'custom-assembled-timer') });
    expect(live.simulated.ok, live.simulated.stderr).toBe(true);
    expect(live.observedHalt).toBe(true);
    expect(live.checked.failures).toEqual([]);
    expect(live.checked.records).toHaveLength(12);
    expect(live.checked.passed).toBe(true);
  }, 60000);
  it.runIf(Boolean(process.env.CO_CUSTOM_CPU_ROOT)).each([
    ['p5_blztal_1047', 'P5_L3_blztal_2022/files/blztal.class',
      '.text\nori $2,$0,1\nsub $1,$0,$2\nblztal $1,$2,1\nori $3,$0,0x33\nori $4,$0,0xdead\nsw $31,0($0)\nori $1,$0,1\nblztal $1,$2,1\nori $5,$0,0x55\nori $6,$0,0x66\nsw $6,4($0)\nhalt: beq $0,$0,halt\nnop\n'],
    ['p5_bonall_1046', 'P5_L2_bonall_2022/files/bonall.class',
      '.text\nori $1,$0,1\nsub $2,$0,$1\nbonall $1,$2,target\nori $3,$0,0x33\nori $4,$0,0xdead\ntarget: sw $31,0($0)\nbonall $1,$1,fail\nori $5,$0,0xbeef\nori $6,$0,0x66\nbeq $0,$0,done\nnop\nfail: ori $7,$0,0xbad\ndone: sw $6,4($0)\nhalt: beq $0,$0,halt\nnop\n']
  ])('compares loaded Mars instruction against real CPU %s and detects a Verilog mutation', async (cpuName, fixture, sourceText) => {
    const { services, asmCase, dump } = await create('P5', fixture, '', '', sourceText);
    const oracle = await executeWithPreflight(services, { image: dump.image!, executionBinding: dump.executionBinding,
      profile: 'P5', courseTrace: true, haltPc: dump.courseHaltPc, maxSteps: 1000,
      runOutputFile: URI.file(path.join(asmCase.dir.fsPath, 'oracle.out')) }, undefined, dump.enginePlan);
    expect(oracle.result?.ok, oracle.result?.status.stderr).toBe(true);
    const directory = path.join(state.root, 'cpu');
    await fs.mkdir(directory);
    const original = path.join(process.env.CO_CUSTOM_CPU_ROOT!, cpuName);
    const files = (await fs.readdir(original)).filter((file) => /\.v$/i.test(file));
    for (const file of files) await fs.copyFile(path.join(original, file), path.join(directory, file));
    await fs.copyFile(asmCase.machineCode.fsPath, path.join(directory, 'code.txt'));
    const topText = await fs.readFile(path.join(directory, 'mips.v'), 'utf8');
    const top = parseModules(TextDocument.create('file:///mips.v', 'verilog', 1, topText), topText).find((module) => module.name === 'mips')!;
    await fs.writeFile(path.join(directory, 'tb.v'), buildTestbench(top, 'tb', { profile: 'P5', finishDelay: '2000' }));
    const runtime = resolveIverilogRuntime(process.cwd());
    const simulate = async () => {
      const compiled = await runProcessCore(runtime.iverilogPath, [...buildIverilogRuntimeArgs(runtime), '-g2005',
        ...buildIverilogIncludeArgs(directory, files.map((file) => path.join(directory, file))), '-s', 'tb', '-o', 'cpu.out', 'tb.v', ...files],
      { cwd: directory, env: buildIverilogEnvironment(runtime), timeoutMs: 30000 });
      expect(compiled.ok, compiled.stderr).toBe(true);
      const output = await runProcessCore(runtime.vvpPath, ['-N', 'cpu.out'], { cwd: directory,
        env: buildIverilogEnvironment(runtime), timeoutMs: 30000 });
      expect(output.ok, output.stderr).toBe(true);
      return compareTraceIterables(oracle.result!.trace!.events, iterCpuTraceEvents(output.stdout), { compareCycles: false });
    };
    const correct = await simulate();
    expect(correct.matched, JSON.stringify(correct.entries.slice(0, 3))).toBe(true);
    const grf = path.join(directory, 'GRF.v');
    const grfText = await fs.readFile(grf, 'utf8');
    // Change only observable writeback in the isolated CPU copy.
    await fs.writeFile(grf, grfText.replace(/\$display\(([^;]+)\);/, (all, args: string) => {
      const changed = args.replace(/([A-Za-z_]\w*)\s*$/, "($1 ^ 32'h1)");
      expect(changed).not.toBe(args);
      return `$display(${changed});`;
    }));
    expect((await simulate()).matched).toBe(false);
  });
});

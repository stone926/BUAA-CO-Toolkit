// Direct bridge contract checks against maintainer-supplied real MARS jars.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
assert(options['--mars'], 'Usage: node resources/mars/bridge/verify.mjs --mars PATH [--official PATH] [--course-root PATH]');
const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mars-bridge.jar');
const directory = await mkdtemp(path.join(os.tmpdir(), 'CO bridge 空格 '));
let serial = 0;
async function run(source, args = [], { jar = options['--mars'], profile = 'P5', delayed = 'true', classFile, stdin } = {}) {
  const base = path.join(directory, String(serial++));
  await writeFile(`${base}.asm`, source);
  const cp = [bridge, jar, ...(classFile ? [path.dirname(classFile)] : [])].join(path.delimiter);
  const execution = spawnSync(process.env.JAVA ?? 'java', [
    '-Dfile.encoding=UTF-8', '-Djava.awt.headless=true', '-cp', cp, 'co.mars.bridge.Main',
    '--source', `${base}.asm`, '--result', `${base}.json`, '--layout', profile === 'ordinary' ? 'Default' : 'CompactLargeText',
    '--profile', profile, '--delayed', delayed, '--max-steps', '50', ...(classFile ? ['--class', classFile] : []), ...args,
  ], { encoding: 'utf8', input: stdin, windowsHide: true, timeout: 20_000 });
  assert.equal(execution.status, 0, execution.error?.message ?? execution.stderr);
  const result = JSON.parse(await readFile(`${base}.json`, 'utf8'));
  assert.equal(result.protocolVersion, 1);
  return { result, stdout: execution.stdout, stderr: execution.stderr };
}
const halt = 'halt: beq $0,$0,halt\nnop\n';
try {
  for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7']) {
    const { result, stdout } = await run(`.text\nori $1,$0,1\nsw $1,0($0)\n${halt}`, ['--mode', 'execute', '--halt-pc', '12296'], {
      profile, delayed: ['P3', 'P4'].includes(profile) ? 'false' : 'true',
    });
    assert.equal(result.ok, true, result.diagnostic);
    assert.equal(result.stopReason, 'halt-loop');
    assert.equal(result.instructions, ['P3', 'P4'].includes(profile) ? 3 : 4);
    assert.match(stdout, /@00003000: \$1 <= 00000001/);
    assert.match(stdout, /@00003004: \*00000000 <= 00000001/);
  }
  const sparse = await run('.macro reserve (%n)\n.space %n\n.end_macro\n.data 0x100\nreserve(8)\n.data 0x80\n.space 4\n.text\nnop\n.ktext 0x4180\nnop\n.text 0x3040\nnop\n');
  assert.equal(sparse.result.ok, true, sparse.result.diagnostic);
  assert.deepEqual(sparse.result.segments, [
    { name: 'text', baseAddress: 0x3000, words: [0] }, { name: 'text@00003040', baseAddress: 0x3040, words: [0] },
    { name: 'ktext', baseAddress: 0x4180, words: [0] },
    { name: 'data', baseAddress: 0x80, words: Array(34).fill(0) },
  ]);
  const macroSection = await run('.macro kernel\n.ktext 0x4180\nli $2,0x12345678\n.end_macro\n.text\nori $1,$0,1\nkernel()\n.text 0x3040\nnop\n');
  assert.equal(macroSection.result.ok, true, macroSection.result.diagnostic);
  assert.equal(macroSection.result.segments.find(segment => segment.name === 'ktext').words.length, 2);
  const includePath = path.join(directory, 'included.asm');
  await writeFile(includePath, '.ktext 0x4180\nli $2,0x12345678\n');
  const included = await run('.text\nnop\n.include "included.asm"\n');
  assert.equal(included.result.ok, true, included.result.diagnostic);
  assert(included.result.sourceMap.some(entry => path.resolve(entry.path) === path.resolve(includePath) && entry.line === 2));
  const initialized = await run(`.data\n.word 1\n.text\n${halt}`, ['--mode', 'execute', '--halt-pc', '12288']);
  assert.equal(initialized.result.ok, false);
  assert.match(initialized.result.diagnostic, /zero-initialized data/);
  assert.equal(initialized.stdout, '');
  const denseExecution = await run(`.text\nnop\n.text 0x3040\n${halt}`, ['--mode', 'execute', '--halt-pc', '12352']);
  assert.equal(denseExecution.result.ok, true, denseExecution.result.diagnostic);
  assert.equal(denseExecution.result.instructions, 18);
  const falloff = await run(`.text\nbeq $0,$0,end\nnop\n${halt}end: nop\n`, ['--mode', 'execute', '--halt-pc', '12296']);
  assert.equal(falloff.result.ok, false);
  assert.match(falloff.result.diagnostic, /fell off text/);
  const bounded = await run(`.text\nloop: beq $0,$0,loop\nnop\n.text 0x3040\n${halt}`, ['--mode', 'execute', '--halt-pc', '12352']);
  assert.equal(bounded.result.stopReason, 'step-limit');
  const invalidHalt = await run('.text\nbne $0,$0,-1\nnop\n', ['--mode', 'execute', '--halt-pc', '12288']);
  assert.equal(invalidHalt.result.ok, false);
  const expectedPath = path.join(directory, 'expected.json');
  await writeFile(expectedPath, JSON.stringify({ segments: [{ name: 'text', baseAddress: 0x3000, words: [1] }] }));
  const mismatch = await run(`.text\nori $1,$0,1\n${halt}`, ['--mode', 'execute', '--halt-pc', '12292', '--expected-image', expectedPath]);
  assert.equal(mismatch.result.ok, false);
  assert.match(mismatch.result.diagnostic, /authoritative expected image/);
  assert.equal(mismatch.stdout, '');
  const p7 = await run(`.text\nmfc0 $5,$12\nori $2,$0,10\nsyscall\nori $3,$0,3\n${halt}.ktext 0x4180\nmfc0 $4,$13\nmfc0 $26,$14\naddiu $26,$26,4\nmtc0 $26,$14\neret\nnop\n`, ['--mode', 'execute', '--halt-pc', '12304'], { profile: 'P7' });
  assert.equal(p7.result.ok, true, p7.result.diagnostic);
  assert.match(p7.stdout, /@00003000: \$5 <= 00000000/);
  assert.match(p7.stdout, /@00004180: \$4 <= 00000020/);
  assert.match(p7.stdout, /@0000300c: \$3 <= 00000003/);
  const disabledTimer = await run(`.text\nori $1,$0,123\nsw $1,0x7f04($0)\nlw $2,0x7f04($0)\nlw $3,0x7f00($0)\nlw $4,0x7f08($0)\n${halt}`, ['--mode', 'execute', '--halt-pc', '12308'], { profile: 'P7' });
  assert.equal(disabledTimer.result.ok, true, disabledTimer.result.diagnostic);
  assert.match(disabledTimer.stdout, /@00003008: \$2 <= 0000007b/);
  assert.match(disabledTimer.stdout, /@00003010: \$4 <= 00000000/);
  const activeTimer = await run(`.text\nori $1,$0,1\nsw $1,0x7f00($0)\nlw $2,0x7f08($0)\n${halt}`, ['--mode', 'execute', '--halt-pc', '12300'], { profile: 'P7' });
  assert.equal(activeTimer.result.ok, true, activeTimer.result.diagnostic);
  assert.equal(activeTimer.result.timerUsed, true);
  assert.equal(activeTimer.result.timerActivated, true);
  assert.equal(activeTimer.result.timerTimingObserved, true);
  const undefinedLo = await run(`.text\nmflo $4\n${halt}`, ['--mode', 'execute', '--halt-pc', '12292'], { profile: 'P6' });
  assert.equal(undefinedLo.result.ok, false);
  assert.match(undefinedLo.result.diagnostic, /LO was read before/);
  const definedLo = await run(`.text\nmult $0,$0\nmflo $4\n${halt}`, ['--mode', 'execute', '--halt-pc', '12296'], { profile: 'P6' });
  assert.equal(definedLo.result.ok, true, definedLo.result.diagnostic);
  const divideZero = await run(`.text\ndiv $1,$0\n${halt}`, ['--mode', 'execute', '--halt-pc', '12292'], { profile: 'P6' });
  assert.equal(divideZero.result.ok, false);
  assert.match(divideZero.result.diagnostic, /division by zero/);
  const divideOverflow = await run(`.text\nlui $1,0x8000\naddiu $2,$0,-1\ndiv $1,$2\n${halt}`, ['--mode', 'execute', '--halt-pc', '12300'], { profile: 'P6' });
  assert.equal(divideOverflow.result.ok, false);
  assert.match(divideOverflow.result.diagnostic, /signed division overflow/);
  const delayedControl = await run(`.text\nbeq $0,$0,halt\nj halt\n${halt}`, ['--mode', 'execute', '--halt-pc', '12296']);
  assert.equal(delayedControl.result.ok, false);
  assert.match(delayedControl.result.diagnostic, /control transfer.*branch delay slot/);
  for (const profile of ['P5', 'P6']) {
    const overflow = await run(`.text\nlui $1,0x7fff\nori $1,$1,0xffff\nori $2,$0,1\nadd $3,$1,$2\n${halt}`, ['--mode', 'execute', '--halt-pc', '12304'], { profile });
    assert.equal(overflow.result.ok, true, overflow.result.diagnostic);
    assert.match(overflow.stdout, /@0000300c: \$3 <= 80000000/);
  }
  const p7Overflow = await run(`.text\nlui $1,0x7fff\nori $1,$1,0xffff\nori $2,$0,1\nadd $3,$1,$2\n${halt}.ktext 0x4180\nmfc0 $4,$13\nmfc0 $26,$14\naddiu $26,$26,4\nmtc0 $26,$14\neret\nnop\n`, ['--mode', 'execute', '--halt-pc', '12304'], { profile: 'P7' });
  assert.equal(p7Overflow.result.ok, true, p7Overflow.result.diagnostic);
  assert.match(p7Overflow.stdout, /@00004180: \$4 <= 00000030/);
  assert.doesNotMatch(p7Overflow.stdout, /@0000300c: \$3 <=/);
  const p7Irq = await run(`.text\nori $1,$0,0x1001\nmtc0 $1,$12\nori $2,$0,2\nori $3,$0,3\n${halt}.ktext 0x4180\nmfc0 $4,$13\nmfc0 $5,$14\nsw $0,0x7f20($0)\neret\nnop\n`, ['--mode', 'execute', '--halt-pc', '12304', '--interrupt', '12296'], { profile: 'P7' });
  assert.equal(p7Irq.result.ok, true, p7Irq.result.diagnostic);
  assert.match(p7Irq.stdout, /@00004180: \$4 <= 00001000/);
  assert.match(p7Irq.stdout, /@00004184: \$5 <= 0000300c/);
  assert.doesNotMatch(p7Irq.stdout, /\*00007f20/);
  if (options['--official']) {
    const ordinary = await run('.text\nli $v0,5\nsyscall\nmove $a0,$v0\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n', ['--mode', 'console'], {
      jar: options['--official'], profile: 'ordinary', delayed: 'false', stdin: '42\n',
    });
    assert.equal(ordinary.result.ok, true, ordinary.result.diagnostic);
    assert.equal(ordinary.stdout, '42');
    assert.equal(ordinary.result.classSupport, 'unavailable');
    const unsupported = await run(`.text\n${halt}`, ['--mode', 'execute', '--halt-pc', '12288'], { jar: options['--official'], profile: 'P7' });
    assert.equal(unsupported.result.ok, false);
    assert.match(unsupported.result.diagnostic, /EXCEPTION_FOR_COURSE/);
  }
  if (options['--course-root']) {
    const fixtures = [
      ['P3_L10_addm_2023', 'addm', 'addm $3,$1,$2', 'P3', '00000003'],
      ['P4_L10_pcadd_2023', 'pcadd', 'pcadd $3,$1', 'P4', '00003009'],
      ['P5_L4_addei_2022', 'addei', 'addei $3,$1,2', 'P5', 'ffff0003'],
      ['P5_L5_lhogez_2022', 'lhogez', 'lhogez $3,0($0)', 'P5', '0000300c', '31'],
    ];
    for (const [folder, mnemonic, instruction, profile, value, register = '3'] of fixtures) {
      const classFile = path.join(options['--course-root'], folder, 'files', `${mnemonic}.class`);
      const custom = await run(`.text\nori $1,$0,1\nori $2,$0,2\n${instruction}\n${halt}`, ['--mode', 'execute', '--halt-pc', '12300'], {
        classFile, profile, delayed: ['P3', 'P4'].includes(profile) ? 'false' : 'true',
      });
      assert.equal(custom.result.ok, true, custom.result.diagnostic);
      assert.equal(custom.result.customInstructions[0].mnemonic, mnemonic);
      assert(custom.result.customInstructions[0].mask > 0);
      assert.equal(custom.result.customInstructions[0].controlTransfer, false);
      assert.match(custom.stdout, new RegExp(`@00003008: \\$${register} <= ${value}`));
    }
    const blztalClass = path.join(options['--course-root'], 'P5_L3_blztal_2022', 'files', 'blztal.class');
    for (const first of ['ori $1,$0,1', 'addiu $1,$0,-1']) {
      const delayedException = await run(`.text\n${first}\nblztal $1,$0,1\nsyscall\nnop\n${halt}.ktext 0x4180\nmfc0 $2,$13\nmfc0 $3,$14\nbeq $0,$0,halt\nnop\n`, ['--mode', 'execute', '--halt-pc', '12304'], { classFile: blztalClass, profile: 'P7' });
      assert.equal(delayedException.result.ok, true, delayedException.result.diagnostic);
      assert.equal(delayedException.result.customInstructions[0].controlTransfer, true);
      assert.match(delayedException.stdout, /@00004180: \$2 <= 80000020/);
      assert.match(delayedException.stdout, /@00004184: \$3 <= 00003004/);
    }
    const bonallClass = path.join(options['--course-root'], 'P5_L2_bonall_2022', 'files', 'bonall.class');
    const annul = await run(`.text\nori $1,$0,1\nbonall $1,$1,halt\nnop\nsyscall\n${halt}.ktext 0x4180\nmfc0 $2,$13\nmfc0 $3,$14\nbeq $0,$0,halt\nnop\n`, ['--mode', 'execute', '--halt-pc', '12304'], { classFile: bonallClass, profile: 'P7' });
    assert.equal(annul.result.ok, true, annul.result.diagnostic);
    assert.match(annul.stdout, /@00004180: \$2 <= 00000020/);
    assert.match(annul.stdout, /@00004184: \$3 <= 0000300c/);
  }
  // Maintainer-only fixtures; the bridge itself never invokes a Java compiler.
  async function compileOverride(name, mnemonic) {
    const sourcePath = path.join(directory, `${name}.java`);
    await writeFile(sourcePath, `import mars.ProgramStatement; import mars.ProcessingException; import mars.mips.instructions.InstructionLoad; import mars.mips.hardware.RegisterFile;
public class ${name} implements InstructionLoad {
 public String getTemplate(){return "${mnemonic} $t1,$t2,-100";}
 public String getDescription(){return "Contract fixture writes 42";}
 public String getFormatStr(){return "I";}
 public String getEncoding(){return "001101 sssss fffff tttttttttttttttt";}
 public void simulate(ProgramStatement s) throws ProcessingException {RegisterFile.updateRegister(s.getOperands()[0],42);}
}`);
    const compile = spawnSync(process.env.JAVAC ?? 'javac', ['--release', '8', '-classpath', options['--mars'], '-d', directory, sourcePath], { encoding: 'utf8', windowsHide: true });
    assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
    return path.join(directory, `${name}.class`);
  }
  const overrideClass = await compileOverride('bridge_override', 'ori');
  const nativeOverride = await run(`.text\nori $1,$0,1\n${halt}`, ['--mode', 'execute', '--halt-pc', '12292'], { classFile: overrideClass });
  assert.equal(nativeOverride.result.ok, true, nativeOverride.result.diagnostic);
  assert.match(nativeOverride.stdout, /@00003000: \$1 <= 0000002a/);
  const aliasClass = await compileOverride('bridge_alias', 'bridgeori');
  const alias = await run(`.text\nori $1,$0,1\nbridgeori $1,$0,1\n${halt}`, ['--mode', 'execute', '--halt-pc', '12296'], { classFile: aliasClass });
  assert.equal(alias.result.ok, true, alias.result.diagnostic);
  assert.equal(alias.result.segments[0].words[0], alias.result.segments[0].words[1]);
  assert.match(alias.stdout, /@00003000: \$1 <= 0000002a/);
  assert.match(alias.stdout, /@00003004: \$1 <= 0000002a/);
  const conflict = await run(`.text\nori $1,$0,1\n${halt}`, ['--mode', 'execute', '--halt-pc', '12292', '--class', aliasClass], { classFile: overrideClass });
  assert.equal(conflict.result.ok, false);
  assert.match(conflict.result.diagnostic, /Ambiguous overlapping custom instruction encodings/);
  async function compileGraphFixture(name, helperMode) {
    const sourcePath = path.join(directory, `${name}.java`);
    const inherited = helperMode === 'inherited';
    const body = helperMode === 'unused' ? 'RegisterFile.updateRegister(s.getOperands()[0],42);' : 'if(RegisterFile.getValue(s.getOperands()[0])!=0) bridge_graph_helper.jump(s.getOperands()[1]);';
    const methods = `public String getTemplate(){return "graph $t1,-100";} public String getDescription(){return "Reachable graph fixture";} public String getFormatStr(){return "I";} public String getEncoding(){return "111100 fffff 00000 ssssssssssssssss";}
 public void simulate(ProgramStatement s) throws ProcessingException {${body}}
 private void unusedBranch(){DelayedBranch.register(0x3000);}`;
    await writeFile(sourcePath, `import mars.ProgramStatement; import mars.ProcessingException; import mars.mips.instructions.InstructionLoad; import mars.mips.hardware.RegisterFile; import mars.simulator.DelayedBranch;
 ${inherited ? `class bridge_graph_base implements InstructionLoad {${methods}} public class ${name} extends bridge_graph_base {}` : `public class ${name} implements InstructionLoad {${methods}}`}
 class bridge_graph_helper {static void jump(int offset){DelayedBranch.register(RegisterFile.getProgramCounter()+(offset<<2));}}`);
    const compile = spawnSync(process.env.JAVAC ?? 'javac', ['--release', '8', '-classpath', options['--mars'], '-d', directory, sourcePath], { encoding: 'utf8', windowsHide: true });
    assert.equal(compile.status, 0, compile.stderr);
    return path.join(directory, `${name}.class`);
  }
  for (const mode of ['companion', 'inherited', 'unused']) {
    const classFile = await compileGraphFixture(`bridge_graph_${mode}`, mode);
    const graph = await run(`.text\ngraph $0,1\nsyscall\n${halt}.ktext 0x4180\nmfc0 $2,$13\nmfc0 $3,$14\nbeq $0,$0,halt\nnop\n`, ['--mode', 'execute', '--halt-pc', '12296'], { classFile, profile: 'P7' });
    assert.equal(graph.result.ok, true, graph.result.diagnostic);
    assert.equal(graph.result.customInstructions[0].controlTransfer, mode !== 'unused');
    assert.match(graph.stdout, mode === 'unused' ? /@00004180: \$2 <= 00000020/ : /@00004180: \$2 <= 80000020/);
  }
  console.log('MARS bridge contract checks passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}

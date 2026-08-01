// @index toolchain — Java/Python/MARS/ISE/Logisim/Hazard检测
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureConcreteProfile, getHazardCalculator, getIsePath, getJava, getLogisimJar, getMarsJar, getProfile, resolvePython } from './config';
import { cleanupCoTmp, coTmpDir, isFile } from './fsUtil';
import { getProfileRequiredTools } from './courseConfig';
import { courseInstructionAddressCapability, p7CourseContractCapability } from './courseTestToolchain';
import { runTool } from './process';
import { ToolDetection } from './types';
import { iterCpuTraceEvents, iterMarsDetailedTraceEvents } from './language/mips/traceParser';
import { COURSE_HALT_FLAG, COURSE_STRICT_DATA_FLAG, COURSE_ZERO_GPR_FLAG } from './language/mips/marsArgs';
export { buildIseEnvironment, findFuse, findIsimGui, isimExecutableName } from './iseCommon';
import { findFuse, findIsimGui } from './iseCommon';

export async function checkToolchain(
  output: vscode.OutputChannel,
  resource?: vscode.Uri,
  options: { promptForProfile?: boolean; tools?: string[] } = {}
): Promise<ToolDetection[]> {
  const checks: ToolDetection[] = [];
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  let profile = getProfile(resource);
  if (profile === 'auto' && options.promptForProfile) {
    profile = await ensureConcreteProfile(resource, '检查工具链需要先确定项目 Profile') ?? 'auto';
  }
  if (profile === 'auto') {
    return [{
      name: 'Profile',
      ok: false,
      detail: '无法自动推断',
      suggestion: '请运行 CO: 选择项目 Profile'
    }];
  }
  const requiredTools = new Set([
    ...getProfileRequiredTools(profile).map(normalizeToolName),
    ...(options.tools ?? []).map(normalizeToolName)
  ]);
  const checkAll = requiredTools.size === 0;

  if (checkAll || requiredTools.has('java')) {
    const java = getJava(resource);
    const javaResult = await runTool(java, ['-version'], {
      cwd,
      output,
      resource,
      timeoutMs: 10000
    });
    checks.push({
      name: 'Java',
      ok: javaResult.ok,
      detail: firstLine(javaResult.stderr || javaResult.stdout) || java,
      suggestion: javaResult.ok ? undefined : '请安装 JRE/JDK 或设置 co.toolchain.java'
    });
  }

  if (checkAll) {
    const python = await resolvePython(resource);
    const pythonResult = await runTool(python, ['--version'], {
      cwd,
      output,
      resource,
      timeoutMs: 10000
    });
    checks.push({
      name: 'Python',
      ok: pythonResult.ok,
      detail: firstLine(pythonResult.stdout || pythonResult.stderr) || python,
      suggestion: pythonResult.ok ? undefined : '请安装 Python3 或设置 co.toolchain.python（macOS/Linux 通常为 python3）'
    });
  }

  if (checkAll || requiredTools.has('mars') || requiredTools.has('marsp7')) {
    const mars = getMarsJar(resource);
    const marsFile = await fileCheck('MARS', mars, profile === 'P7' ? '请设置 co.toolchain.marsP7 为可用于 P7 CompactLargeText dump 的 Mars jar' : '请设置 co.toolchain.mars 为支持 coL1 和 large text 的修改版 Mars jar');
    checks.push(marsFile);
    if (marsFile.ok) {
      checks.push(...await marsCapabilityChecks(output, resource, cwd, mars, profile));
    }
  }

  if (checkAll || requiredTools.has('logisim')) {
    const logisim = getLogisimJar(resource);
    checks.push(await fileCheck('Logisim', logisim, '请设置 co.toolchain.logisim'));
  }

  if (checkAll || requiredTools.has('ise')) {
    const ise = getIsePath(resource);
    const fuse = ise ? findFuse(ise) : '';
    const isimGui = ise ? findIsimGui(ise) : '';
    const fuseOk = Boolean(fuse && await isFile(fuse));
    const isimGuiOk = Boolean(isimGui && await isFile(isimGui));
    checks.push({
      name: 'ISE fuse',
      ok: fuseOk,
      detail: fuse || '未配置',
      suggestion: fuseOk ? undefined : '请设置 co.toolchain.isePath 为 ISE 目录'
    });
    checks.push({
      name: 'ISim GUI',
      ok: isimGuiOk,
      detail: isimGui || '未配置',
      suggestion: isimGuiOk ? undefined : '请设置 co.toolchain.isePath 为包含 ISim 的 ISE 目录'
    });
  }

  const hazardDir = getHazardCalculator(resource);
  if (hazardDir || profile === 'P5' || profile === 'P6' || profile === 'P7') {
    checks.push(await hazardDirCheck(hazardDir));
  }

  return checks;
}

async function marsCapabilityChecks(
  output: vscode.OutputChannel,
  resource: vscode.Uri | undefined,
  cwd: string,
  mars: string,
  profile: string
): Promise<ToolDetection[]> {
  const tempDir = coTmpDir(resource, 'co-mars-check-');
  try {
    const asm = path.join(tempDir, 'capability.asm');
    const sourceLines = [
      '.text',
      'ori $2, $gp, 0',
      'ori $3, $sp, 0',
      'lui $1, 0x1122',
      'ori $1, $1, 0x3344',
      'sw $1, 0($0)',
      'swl $1, 1($0)',
      'swr $1, 2($0)'
    ];
    if (profile === 'P7') {
      sourceLines.push(
        // The P7 tutorial exposes only DM/Timer/IG through the load-store bridge. Both accesses
        // must raise an exception even though CompactLargeText itself maps 0x5000 as kernel data.
        'lw $4, 0x5000($0)',
        'sw $4, 0x5000($0)',
        'ori $6, $0, 1'
      );
    }
    const haltPc = profile === 'P7' ? 0x3028 : 0x301c;
    sourceLines.push(
      '_co_capability_halt:',
      'beq $0, $0, _co_capability_halt',
      'nop'
    );
    if (profile === 'P7') {
      sourceLines.push(
        '.ktext 0x4180',
        'mfc0 $26, $14',
        'addiu $26, $26, 4',
        'mtc0 $26, $14',
        'addiu $5, $5, 1',
        'eret',
        'nop'
      );
    }
    sourceLines.push('');
    await fs.promises.writeFile(asm, sourceLines.join('\n'), 'utf8');
    const java = getJava(resource);
    const traceMemory = profile === 'P7' ? 'CompactLargeText' : 'CompactDataAtZero';
    const traceBaseArgs = [
      '-jar', mars, 'nc', 'mc', traceMemory, 'ae1', 'se1',
      COURSE_ZERO_GPR_FLAG, COURSE_STRICT_DATA_FLAG, `${COURSE_HALT_FLAG}=0x${haltPc.toString(16)}`
    ];
    if (profile === 'P5' || profile === 'P6' || profile === 'P7') {
      traceBaseArgs.push('db');
    }
    if (profile === 'P7') {
      traceBaseArgs.push('efc');
    }
    traceBaseArgs.push('0x80');
    const traceL1 = await runTool(java, [...traceBaseArgs, 'coL1', asm], {
      cwd,
      output,
      resource,
      timeoutMs: 10000
    });
    const traceL2 = await runTool(java, [...traceBaseArgs, 'coL2', asm], {
      cwd,
      output,
      resource,
      timeoutMs: 10000
    });
    const checks: ToolDetection[] = [
      traceCapabilityCheck(traceL1, 1, profile === 'P7'),
      traceCapabilityCheck(traceL2, 2, profile === 'P7'),
      await strictDataCapabilityCheck(output, resource, cwd, java, mars, tempDir)
    ];
    checks.push(await courseInstructionAddressCapabilityCheck(output, resource, cwd, java, mars, tempDir, profile));
    if (profile === 'P7') {
      checks.push(await p7CourseContractCapabilityCheck(output, resource, cwd, java, mars, tempDir));
    }
    if (profile !== 'P7') {
      checks.push(await memoryConfigurationCapabilityCheck(output, resource, cwd, java, mars, asm, tempDir, 'FixedCompactLargeText'));
    }
    checks.push(await memoryConfigurationCapabilityCheck(output, resource, cwd, java, mars, asm, tempDir, 'CompactLargeText'));
    return checks;
  } finally {
    await cleanupCoTmp(tempDir);
  }
}

async function courseInstructionAddressCapabilityCheck(
  output: vscode.OutputChannel,
  resource: vscode.Uri | undefined,
  cwd: string,
  java: string,
  mars: string,
  tempDir: string,
  profile: string
): Promise<ToolDetection> {
  const asm = path.join(tempDir, 'course-im-range.asm');
  const p7PaddingAsm = path.join(tempDir, 'course-im-p7-padding.asm');
  const haltPc = 0x3010;
  const isP7 = profile === 'P7';
  const escapeAddress = isP7 ? 0x5000 : 0x4000;
  await fs.promises.writeFile(asm, [
    '.text',
    `ori $2, $0, 0x${escapeAddress.toString(16)}`,
    `ori $3, $0, 0x${haltPc.toString(16)}`,
    'jr $2',
    'nop',
    '_co_course_im_halt:',
    'beq $0, $0, _co_course_im_halt',
    'nop',
    `.ktext 0x${escapeAddress.toString(16)}`,
    'jr $3',
    'nop',
    ''
  ].join('\n'), 'utf8');
  if (isP7) {
    await fs.promises.writeFile(p7PaddingAsm, [
      '.text',
      'ori $2, $0, 0x417c',
      `ori $3, $0, 0x${haltPc.toString(16)}`,
      'jr $2',
      'nop',
      '_co_course_padding_halt:',
      'beq $0, $0, _co_course_padding_halt',
      'nop',
      // This statement is present in MARS memory but omitted from code.txt: the plugin fills the
      // entire user/kernel gap with NOPs. A capable oracle must therefore ignore this write.
      '.ktext 0x417c',
      'ori $4, $0, 1',
      '.ktext 0x4180',
      'beq $4, $0, _co_padding_good',
      'nop',
      'ori $5, $0, 0x0bad',
      'jr $3',
      'nop',
      '_co_padding_good:',
      'sb $0, 0x7f20($0)',
      'ori $5, $0, 0x600d',
      'jr $3',
      'nop',
      ''
    ].join('\n'), 'utf8');
  }
  const args = [
    '-jar', mars, 'nc', 'mc', isP7 ? 'CompactLargeText' : 'CompactDataAtZero', 'ae1', 'se1',
    COURSE_ZERO_GPR_FLAG, COURSE_STRICT_DATA_FLAG, `${COURSE_HALT_FLAG}=0x${haltPc.toString(16)}`
  ];
  if (profile === 'P5' || profile === 'P6' || isP7) {
    args.push('db');
  }
  if (isP7) {
    args.push('efc');
  }
  args.push('coL1', '0x40');
  const runOptions = { cwd, output, resource, timeoutMs: 20000 };
  const [result, p7PaddingResult] = await Promise.all([
    runTool(java, [...args, asm], runOptions),
    isP7 ? runTool(java, [...args, p7PaddingAsm], runOptions) : Promise.resolve(undefined)
  ]);
  return courseInstructionAddressCapability(result, p7PaddingResult);
}

async function p7CourseContractCapabilityCheck(
  output: vscode.OutputChannel,
  resource: vscode.Uri | undefined,
  cwd: string,
  java: string,
  mars: string,
  tempDir: string
): Promise<ToolDetection> {
  const userIgAsm = path.join(tempDir, 'course-p7-user-ig.asm');
  const invalidHandlerIgAsm = path.join(tempDir, 'course-p7-invalid-handler-ig.asm');
  const handlerExceptionAsm = path.join(tempDir, 'course-p7-handler-exception.asm');
  const handlerInterruptAsm = path.join(tempDir, 'course-p7-handler-interrupt.asm');
  const validPendingInterruptAsm = path.join(tempDir, 'course-p7-valid-pending-interrupt.asm');
  await Promise.all([
    fs.promises.writeFile(userIgAsm, [
      '.text',
      'sb $0, 0x7f20($0)',
      '_co_p7_contract_halt:',
      'beq $0, $0, _co_p7_contract_halt',
      'nop',
      ''
    ].join('\n'), 'utf8'),
    fs.promises.writeFile(invalidHandlerIgAsm, [
      '.text',
      'ori $1, $0, 0x4180',
      'ori $3, $0, 0x3010',
      'jr $1',
      'nop',
      '_co_p7_handler_ig_contract_halt:',
      'beq $0, $0, _co_p7_handler_ig_contract_halt',
      'nop',
      '.ktext 0x4180',
      'sw $0, 0x7f20($0)',
      'jr $3',
      'nop',
      ''
    ].join('\n'), 'utf8'),
    fs.promises.writeFile(handlerExceptionAsm, [
      '.text',
      'lw $1, 0x5000($0)',
      '_co_p7_handler_contract_halt:',
      'beq $0, $0, _co_p7_handler_contract_halt',
      'nop',
      '.ktext 0x4180',
      'lw $2, 0x5000($0)',
      'eret',
      'nop',
      ''
    ].join('\n'), 'utf8'),
    fs.promises.writeFile(handlerInterruptAsm, [
      '.text',
      'syscall',
      '_co_p7_interrupt_contract_halt:',
      'beq $0, $0, _co_p7_interrupt_contract_halt',
      'nop',
      '.ktext 0x4180',
      'mfc0 $2, $14',
      'addiu $2, $2, 4',
      'mtc0 $2, $14',
      'eret',
      ''
    ].join('\n'), 'utf8'),
    fs.promises.writeFile(validPendingInterruptAsm, [
      '.text',
      'ori $26, $0, 0x1001',
      'mtc0 $26, $12',
      'nop',
      'ori $6, $0, 1',
      '_co_p7_pending_contract_halt:',
      'beq $0, $0, _co_p7_pending_contract_halt',
      'nop',
      '.ktext 0x4180',
      'mfc0 $8, $13',
      'ori $7, $0, 0x600d',
      'sb $0, 0x7f20($0)',
      'eret',
      'nop',
      ''
    ].join('\n'), 'utf8')
  ]);
  const commonArgs = [
    '-jar', mars, 'nc', 'mc', 'CompactLargeText', 'ae1', 'se1',
    COURSE_ZERO_GPR_FLAG, COURSE_STRICT_DATA_FLAG, 'db', 'efc', 'coL1', '0x40'
  ];
  const runOptions = { cwd, output, resource, timeoutMs: 20000 };
  const [
    userIgResult,
    invalidHandlerIgResult,
    handlerExceptionResult,
    handlerInterruptResult,
    validPendingInterruptResult
  ] = await Promise.all([
    runTool(java, [...commonArgs, `${COURSE_HALT_FLAG}=0x3004`, userIgAsm], runOptions),
    runTool(java, [...commonArgs, `${COURSE_HALT_FLAG}=0x3010`, invalidHandlerIgAsm], runOptions),
    runTool(java, [...commonArgs, `${COURSE_HALT_FLAG}=0x3004`, handlerExceptionAsm], runOptions),
    runTool(java, [...commonArgs, 'p7irq=0x4180', `${COURSE_HALT_FLAG}=0x3004`, handlerInterruptAsm], runOptions),
    runTool(java, [...commonArgs, 'p7irq=0x3008', `${COURSE_HALT_FLAG}=0x3010`, validPendingInterruptAsm], runOptions)
  ]);
  return p7CourseContractCapability(
    userIgResult,
    invalidHandlerIgResult,
    handlerExceptionResult,
    handlerInterruptResult,
    validPendingInterruptResult
  );
}

function traceCapabilityCheck(
  result: Awaited<ReturnType<typeof runTool>>,
  level: 1 | 2,
  requireP7AddressGuard: boolean
): ToolDetection {
  const output = `${result.stdout}\n${result.stderr}`;
  const flag = `coL${level}`;
  const unsupported = new RegExp(
    `Invalid Command Argument:\\s*(?:${flag}|${COURSE_ZERO_GPR_FLAG}|${COURSE_STRICT_DATA_FLAG}|${COURSE_HALT_FLAG}=)`,
    'i'
  ).test(output);
  const hasBasicTrace = level === 1
    ? /@(?:0x)?[0-9a-f]{4,8}:\s*(?:\$|\*)/i.test(output)
    : /@PC(?:0x)?[0-9a-f]{4,8}\s*->/i.test(output) && /(?:\$|\*)[0-9a-f ]+\s*<=/i.test(output);
  const events = Array.from(level === 1 ? iterCpuTraceEvents(output) : iterMarsDetailedTraceEvents(output));
  const hasCourseZeroGprs = [2, 3].every((register) => events.some((event) =>
    event.kind === 'grf' && event.target === String(register) && event.value === '00000000'));
  const hasP7AddressGuard = !requireP7AddressGuard || (
    events.some((event) => event.kind === 'grf' && event.target === '5' && event.value === '00000002')
    && events.some((event) => event.kind === 'grf' && event.target === '6' && event.value === '00000001')
    && !events.some((event) => event.kind === 'dm' && event.target === '00005000')
  );
  const reachedCourseHalt = /Program reached course halt loop at\s+(?:0x)?[0-9a-f]{1,8}\b/i.test(output);
  const hasTrace = hasBasicTrace
    && hasCourseZeroGprs
    && hasP7AddressGuard
    && reachedCourseHalt
    && (level === 1 || hasUsablePartialWordDetailedTrace(output));
  return {
    name: `MARS ${flag}`,
    ok: result.ok && !unsupported && hasTrace,
    detail: firstLine(output) || '无 trace 输出',
    suggestion: result.ok && !unsupported && hasTrace
      ? undefined
      : `请使用支持 ${flag} / ${COURSE_ZERO_GPR_FLAG} / ${COURSE_STRICT_DATA_FLAG} / ${COURSE_HALT_FLAG}${requireP7AddressGuard ? ' / P7 课程地址桥' : ''} 的 Mars-with-BUAA-CO-extension 修改版 MARS`
  };
}

async function strictDataCapabilityCheck(
  output: vscode.OutputChannel,
  resource: vscode.Uri | undefined,
  cwd: string,
  java: string,
  mars: string,
  tempDir: string
): Promise<ToolDetection> {
  const rangeAsm = path.join(tempDir, 'strict-data-range.asm');
  const overflowAsm = path.join(tempDir, 'strict-data-overflow.asm');
  await Promise.all([
    fs.promises.writeFile(rangeAsm, [
      '.data',
      '.byte 0xa5',
      '.space 12286',
      '.byte 0x5a',
      '.text',
      'lbu $4, 0x2fff($0)',
      'addiu $9, $0, -1',
      'lbu $10, 1($9)',
      // CompactDataAtZero maps 0x5000 as data, so vanilla MARS succeeds here; only the course
      // bridge may reject it. 0x3000 would be text and could fail for unrelated SMC policy.
      'lbu $5, 0x5000($0)',
      ''
    ].join('\n'), 'utf8'),
    fs.promises.writeFile(overflowAsm, [
      '.text',
      'lui $7, 0x7fff',
      'ori $7, $7, 0xffff',
      'lbu $8, 1($7)',
      ''
    ].join('\n'), 'utf8')
  ]);
  const args = [
    '-jar', mars, 'nc', 'mc', 'CompactDataAtZero', 'ae1', 'se1',
    COURSE_ZERO_GPR_FLAG, COURSE_STRICT_DATA_FLAG, 'coL1', '0x40'
  ];
  const [rangeResult, overflowResult] = await Promise.all([
    runTool(java, [...args, rangeAsm], { cwd, output, resource, timeoutMs: 10000 }),
    runTool(java, [...args, overflowAsm], { cwd, output, resource, timeoutMs: 10000 })
  ]);
  const rangeOutput = `${rangeResult.stdout}\n${rangeResult.stderr}`;
  const overflowOutput = `${overflowResult.stdout}\n${overflowResult.stderr}`;
  const combined = `${rangeOutput}\n${overflowOutput}`;
  const unsupported = new RegExp(`Invalid Command Argument:\\s*${COURSE_STRICT_DATA_FLAG}`, 'i').test(combined);
  const boundaryEvent = Array.from(iterCpuTraceEvents(rangeOutput)).some((event) =>
    event.kind === 'grf' && event.target === '4' && event.value === '0000005A');
  const signedAddressRecoveryEvent = Array.from(iterCpuTraceEvents(rangeOutput)).some((event) =>
    event.kind === 'grf' && event.target === '10' && event.value === '000000A5');
  const rangeRejected = !rangeResult.ok && /address|range|exception/i.test(rangeOutput);
  const overflowRejected = !overflowResult.ok && /address|range|overflow|exception/i.test(overflowOutput);
  const ok = !unsupported && boundaryEvent && signedAddressRecoveryEvent && rangeRejected && overflowRejected;
  return {
    name: `MARS ${COURSE_STRICT_DATA_FLAG}`,
    ok,
    detail: [firstLine(rangeOutput), firstLine(overflowOutput)].filter(Boolean).join('；') || '无地址校验输出',
    suggestion: ok
      ? undefined
      : `请使用支持 ${COURSE_STRICT_DATA_FLAG} 课程 DM 边界与有效地址溢出检查的 Mars-with-BUAA-CO-extension 修改版 MARS`
  };
}

function hasUsablePartialWordDetailedTrace(output: string): boolean {
  const partialStorePcs = Array.from(output.matchAll(/^@PC(?:0x)?([0-9a-f]{1,8})\s*->\s*sw[lr]\b/gim))
    .map((match) => match[1].padStart(8, '0').toUpperCase());
  if (partialStorePcs.length < 2) {
    return false;
  }
  const events = Array.from(iterMarsDetailedTraceEvents(output));
  return partialStorePcs.every((pc) =>
    events.filter((event) => event.pc === pc && event.kind === 'dm').length === 1);
}

async function memoryConfigurationCapabilityCheck(
  output: vscode.OutputChannel,
  resource: vscode.Uri | undefined,
  cwd: string,
  java: string,
  mars: string,
  asm: string,
  tempDir: string,
  memoryConfiguration: 'CompactDataAtZero' | 'FixedCompactLargeText' | 'CompactLargeText'
): Promise<ToolDetection> {
  const outFile = path.join(tempDir, `${memoryConfiguration}.txt`);
  const result = await runTool(java, ['-jar', mars, 'nc', 'mc', memoryConfiguration, 'db', 'a', 'dump', '.text', 'HexText', outFile, asm], {
    cwd,
    output,
    resource,
    timeoutMs: 10000
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const unsupported = /Invalid memory configuration/i.test(combined);
  const dumped = await fileHasText(outFile);
  return {
    name: `MARS ${memoryConfiguration}`,
    ok: result.ok && !unsupported && dumped,
    detail: firstLine(combined) || (dumped ? 'dump ok' : '未生成 HexText'),
    suggestion: result.ok && !unsupported && dumped ? undefined : `请使用支持 mc ${memoryConfiguration} 的修改版 Mars`
  };
}

async function fileCheck(name: string, file: string, suggestion: string): Promise<ToolDetection> {
  if (!file) {
    return {
      name,
      ok: false,
      detail: '未配置',
      suggestion
    };
  }
  const exists = await isFile(file);
  return {
    name,
    ok: exists,
    detail: file,
    suggestion: exists ? undefined : suggestion
  };
}

async function fileHasText(file: string): Promise<boolean> {
  try {
    return (await fs.promises.readFile(file, 'utf8')).trim().length > 0;
  } catch {
    return false;
  }
}

async function hazardDirCheck(dir: string): Promise<ToolDetection> {
  if (!dir) {
    return {
      name: '冲突分析',
      ok: false,
      detail: '未配置',
      suggestion: '请设置 co.toolchain.hazardCalculator 为 hazard_analysis 目录'
    };
  }
  const jarExists = await isFile(path.join(dir, 'Hazard-Calculator.jar'));
  const analyzerExists = await isFile(path.join(dir, 'analyzer.py'));
  const ok = jarExists && analyzerExists;
  const missing = [
    !jarExists && 'Hazard-Calculator.jar',
    !analyzerExists && 'analyzer.py'
  ].filter(Boolean).join(', ');
  return {
    name: '冲突分析',
    ok,
    detail: dir,
    suggestion: ok ? undefined : `${dir} 中缺少 ${missing}`
  };
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import type { AppServices } from '../../src/types';
import {
  startContinuousP7Pipeline
} from './pipeline';
import type { ContinuousPipelineOptions } from './pipeline';
import {
  configureHeadlessWorkspace
} from './vscodeShim';

const PROFILE = 'P7';
const SUPPORTED_EXCEPTION_TYPES = ['AdEL', 'AdES', 'Syscall', 'RI', 'Ov'];
const SUPPORTED_STRESS_MODES = ['anchor', 'probe', 'hybrid', 'off'] as const;

interface CliOptions {
  projectRoot: string;
  instructions: string;
  instructionCount: number;
  intervalMs: number;
  maxIterations: number;
  stopOnFailure: boolean;
  retainedPassingCases: number;
  reportRetainedIterations: number;
  stressMode: (typeof SUPPORTED_STRESS_MODES)[number];
  interrupt: boolean;
  timerInterrupt: boolean;
  externalInterruptIntensity: number;
  timerIntensity: number;
  probeScenarioCount: number;
  exceptionRate: number;
  exceptionTypes: string[];
  seed?: string;
  java: string;
  mars: string;
  marsP7: string;
  isePath: string;
  topModule: string;
  testbench: string;
  machineCode: string;
  simTime: string;
  memoryConfiguration: string;
  timeoutMs: number;
  reportFile: string;
  checkToolchain: boolean;
  quiet: boolean;
  json: boolean;
}

class CliOutputChannel {
  constructor(private readonly quiet: boolean) {}

  append(value: string): void {
    if (!this.quiet) {
      process.stdout.write(value);
    }
  }

  appendLine(value: string): void {
    this.append(`${value}\n`);
  }

  show(_preserveFocus?: boolean): void {
    // Headless output is always written to stdout.
  }

  hide(): void {}

  clear(): void {}

  replace(_value: string): void {}

  dispose(): void {}
}

function createServices(quiet: boolean): AppServices {
  const output = new CliOutputChannel(quiet);
  const statusBar = {
    text: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined
  };
  return {
    output: output as unknown as AppServices['output'],
    statusBar: statusBar as unknown as AppServices['statusBar']
  };
}

function loadDefaults(): Record<string, unknown> {
  const defaultsPath = path.join(__dirname, '..', '..', 'resources', 'co', 'configDefaults.json');
  return JSON.parse(fs.readFileSync(defaultsPath, 'utf8')) as Record<string, unknown>;
}

function defaultString(defaults: Record<string, unknown>, key: string, fallback: string): string {
  const value = defaults[key];
  return typeof value === 'string' ? value : fallback;
}

function defaultNumber(defaults: Record<string, unknown>, key: string, fallback: number): number {
  const value = defaults[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function defaultBoolean(defaults: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = defaults[key];
  return typeof value === 'boolean' ? value : fallback;
}

function defaultStringArray(defaults: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = defaults[key];
  return Array.isArray(value) ? value.map(String) : fallback;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const defaults = loadDefaults();
  const options: CliOptions = {
    projectRoot: process.cwd(),
    instructions: defaultString(defaults, 'test.builtinGenerator.instructions', ''),
    instructionCount: defaultNumber(defaults, 'test.builtinGenerator.p7InstructionCount', 1118),
    intervalMs: defaultNumber(defaults, 'test.continuousIntervalMs', 1000),
    maxIterations: defaultNumber(defaults, 'test.continuousMaxIterations', 0),
    stopOnFailure: defaultBoolean(defaults, 'test.continuousStopOnFailure', true),
    retainedPassingCases: defaultNumber(defaults, 'test.continuousRetainedPassingCases', 20),
    reportRetainedIterations: defaultNumber(defaults, 'test.continuousReportRetainedIterations', 200),
    stressMode: defaultString(defaults, 'test.p7.stressMode', 'hybrid') as CliOptions['stressMode'],
    interrupt: defaultBoolean(defaults, 'test.p7.interrupt', true),
    timerInterrupt: defaultBoolean(defaults, 'test.p7.timerInterrupt', true),
    externalInterruptIntensity: defaultNumber(defaults, 'test.p7.externalInterruptIntensity', 0.25),
    timerIntensity: defaultNumber(defaults, 'test.p7.timerIntensity', 0.2),
    probeScenarioCount: defaultNumber(defaults, 'test.p7.probeScenarioCount', 64),
    exceptionRate: defaultNumber(defaults, 'test.p7.exceptionRate', 0.08),
    exceptionTypes: defaultStringArray(defaults, 'test.p7.exceptionTypes', SUPPORTED_EXCEPTION_TYPES),
    java: defaultString(defaults, 'toolchain.java', 'java'),
    mars: defaultString(defaults, 'toolchain.mars', ''),
    marsP7: defaultString(defaults, 'toolchain.marsP7', ''),
    isePath: defaultString(defaults, 'toolchain.isePath', ''),
    topModule: defaultString(defaults, 'project.topModule', 'mips'),
    testbench: defaultString(defaults, 'project.testbench', 'mips_tb'),
    machineCode: defaultString(defaults, 'project.machineCode', 'code.txt'),
    simTime: defaultString(defaults, 'project.simTime', '200us'),
    memoryConfiguration: 'CompactLargeText',
    timeoutMs: defaultNumber(defaults, 'run.timeoutMs', 120000),
    reportFile: '',
    checkToolchain: true,
    quiet: false,
    json: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
    if (arg === '-v' || arg === '--version') {
      process.stdout.write('buaa-co-test-cli 0.1.0 (P7 headless continuous trace pipeline)\n');
      process.exit(0);
    }
    if (arg === '-q' || arg === '--quiet') {
      options.quiet = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--skip-toolchain-check') {
      options.checkToolchain = false;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`未知命令行参数: ${arg}`);
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
    if (name === 'no-stop-on-failure') {
      options.stopOnFailure = false;
      continue;
    }
    if (name === 'no-interrupt') {
      options.interrupt = false;
      continue;
    }
    if (name === 'no-timer-interrupt') {
      options.timerInterrupt = false;
      continue;
    }
    const readValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      i++;
      if (i >= argv.length) {
        throw new Error(`参数 ${name} 缺少值`);
      }
      return argv[i];
    };
    const readNumber = (): number => {
      const value = Number(readValue());
      if (!Number.isFinite(value)) {
        throw new Error(`参数 ${name} 需要数字，实际为 ${readValue()}`);
      }
      return value;
    };
    const readBoolean = (defaultWhenPresent: boolean): boolean => {
      if (inlineValue !== undefined) {
        const normalized = inlineValue.toLowerCase();
        if (normalized === 'true' || normalized === '1') {
          return true;
        }
        if (normalized === 'false' || normalized === '0') {
          return false;
        }
        throw new Error(`参数 ${name} 需要 true/false`);
      }
      return defaultWhenPresent;
    };

    switch (name) {
      case 'project':
      case 'project-dir':
      case 'project-root':
        options.projectRoot = path.resolve(readValue());
        break;
      case 'instructions':
      case 'instruction-set':
      case 'instruction':
        options.instructions = readValue();
        break;
      case 'count':
      case 'instruction-count':
        options.instructionCount = readNumber();
        break;
      case 'interval':
      case 'interval-ms':
        options.intervalMs = readNumber();
        break;
      case 'iterations':
      case 'max-iterations':
        options.maxIterations = readNumber();
        break;
      case 'stop-on-failure':
        options.stopOnFailure = readBoolean(true);
        break;
      case 'retained-cases':
      case 'retained-passing-cases':
        options.retainedPassingCases = readNumber();
        break;
      case 'retained-iterations':
      case 'report-retained-iterations':
        options.reportRetainedIterations = readNumber();
        break;
      case 'stress':
      case 'mode':
      case 'stress-mode':
        options.stressMode = readValue() as CliOptions['stressMode'];
        break;
      case 'interrupt':
        options.interrupt = readBoolean(true);
        break;
      case 'timer-interrupt':
        options.timerInterrupt = readBoolean(true);
        break;
      case 'external-intensity':
      case 'external-interrupt-intensity':
        options.externalInterruptIntensity = readNumber();
        break;
      case 'timer-intensity':
        options.timerIntensity = readNumber();
        break;
      case 'probe-scenarios':
      case 'probe-scenario-count':
        options.probeScenarioCount = readNumber();
        break;
      case 'exception-rate':
        options.exceptionRate = readNumber();
        break;
      case 'exception-types':
        options.exceptionTypes = readValue().split(/[,\s]+/).map((value) => value.trim()).filter(Boolean);
        break;
      case 'seed':
        options.seed = readValue();
        break;
      case 'java':
        options.java = readValue();
        break;
      case 'mars':
      case 'mars-jar':
        options.mars = readValue();
        break;
      case 'mars-p7':
      case 'mars-p7-jar':
        options.marsP7 = readValue();
        break;
      case 'ise':
      case 'ise-path':
        options.isePath = readValue();
        break;
      case 'top-module':
        options.topModule = readValue();
        break;
      case 'testbench':
        options.testbench = readValue();
        break;
      case 'machine-code':
        options.machineCode = readValue();
        break;
      case 'sim-time':
        options.simTime = readValue();
        break;
      case 'memory-config':
      case 'memory-configuration':
        options.memoryConfiguration = readValue();
        break;
      case 'timeout':
      case 'timeout-ms':
        options.timeoutMs = readNumber();
        break;
      case 'report':
      case 'report-file':
        options.reportFile = readValue();
        break;
      default:
        throw new Error(`未知命令行参数: --${name}`);
    }
  }

  if (options.json) {
    options.quiet = true;
  }
  if (!options.reportFile) {
    options.reportFile = path.join(options.projectRoot, '.co', 'out', 'continuous-trace-report.json');
  } else {
    options.reportFile = path.resolve(options.projectRoot, options.reportFile);
  }

  validateCliOptions(options);
  return options;
}

function validateCliOptions(options: CliOptions): void {
  const projectStat = fs.statSync(options.projectRoot);
  if (!projectStat.isDirectory()) {
    throw new Error(`项目目录不存在或不是目录: ${options.projectRoot}`);
  }
  if (!Number.isInteger(options.instructionCount) || options.instructionCount <= 0) {
    throw new Error('--count 必须是正整数');
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 0) {
    throw new Error('--interval 必须是非负整数（毫秒）');
  }
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 0) {
    throw new Error('--iterations 必须是非负整数（0 表示无限）');
  }
  if (!Number.isInteger(options.retainedPassingCases) || options.retainedPassingCases < 0) {
    throw new Error('--retained-cases 必须是非负整数');
  }
  if (!Number.isInteger(options.reportRetainedIterations) || options.reportRetainedIterations < 0) {
    throw new Error('--retained-iterations 必须是非负整数');
  }
  if (!SUPPORTED_STRESS_MODES.includes(options.stressMode)) {
    throw new Error(`--stress-mode 必须是 ${SUPPORTED_STRESS_MODES.join('|')}`);
  }
  if (!Number.isFinite(options.externalInterruptIntensity) || options.externalInterruptIntensity < 0 || options.externalInterruptIntensity > 1) {
    throw new Error('--external-intensity 必须在 0..1 范围内');
  }
  if (!Number.isFinite(options.timerIntensity) || options.timerIntensity < 0 || options.timerIntensity > 1) {
    throw new Error('--timer-intensity 必须在 0..1 范围内');
  }
  if (!Number.isInteger(options.probeScenarioCount) || options.probeScenarioCount < 1 || options.probeScenarioCount > 64) {
    throw new Error('--probe-scenarios 必须在 1..64 范围内');
  }
  if (!Number.isFinite(options.exceptionRate) || options.exceptionRate < 0 || options.exceptionRate > 1) {
    throw new Error('--exception-rate 必须在 0..1 范围内');
  }
  const invalidExceptions = options.exceptionTypes.filter((value) => !SUPPORTED_EXCEPTION_TYPES.includes(value));
  if (invalidExceptions.length) {
    throw new Error(`--exception-types 包含不支持的类型: ${invalidExceptions.join(', ')}（支持 ${SUPPORTED_EXCEPTION_TYPES.join(', ')}）`);
  }
  if (options.timeoutMs <= 0) {
    throw new Error('--timeout-ms 必须为正整数');
  }
  if (options.memoryConfiguration !== 'CompactLargeText') {
    throw new Error(`test-cli 仅支持 P7，内存配置必须为 CompactLargeText，当前为 ${options.memoryConfiguration}`);
  }
}

function printHelp(): void {
  process.stdout.write(`BUAA CO Toolkit | test-cli (P7 headless continuous trace pipeline)

用法:
  co-test continuous [options]
  co-test [options]                  # 默认运行 continuous

P7 管线: 内置 ASM 测试点生成 -> MARS dump 机器码 -> MARS 黄金 Trace ->
ISim 仿真 Trace -> Trace 对拍/Probe 检查，循环执行并写 JSON 报告。

选项:
  --project <dir>                 项目/工作区根目录（默认当前目录）
  --instructions <list>           自定义 P7 指令集，逗号或空白分隔；留空使用 Profile 默认
  --count <n>                     有效载荷指令数（默认 1118，最大 1118）
  --interval <ms>                 轮次间隔毫秒（默认 1000）
  --iterations <n>                最大轮数，0 表示无限（默认 0）
  --stop-on-failure / --no-stop-on-failure
                                  测试点失败/异常时停止（默认 true）
  --retained-cases <n>            保留最近通过的 case 数量（默认 20）
  --retained-iterations <n>       JSON 报告保留的最近轮数（默认 200）
  --stress <mode>                 anchor|probe|hybrid|off（默认 hybrid）
  --interrupt / --no-interrupt    anchor 模式注入外部中断（默认 true）
  --timer-interrupt / --no-timer-interrupt
                                  probe 模式生成 Timer 中断（默认 true）
  --external-intensity <0..1>     外部中断强度（默认 0.25）
  --timer-intensity <0..1>        Timer 强度（默认 0.2）
  --probe-scenarios <1..64>       probe 场景数（默认 64）
  --exception-rate <0..1>         内部异常比例（默认 0.08）
  --exception-types <list>        AdEL,AdES,Syscall,RI,Ov 子集
  --seed <string>                 生成器种子
  --java <command>                Java 命令（默认 java）
  --mars <jar>                    MARS jar（P7 未单独配置时回退使用）
  --mars-p7 <jar>                 P7 专用 MARS jar
  --ise <path>                    Xilinx ISE 安装目录
  --top-module <name>             Verilog 顶层模块（默认 mips）
  --testbench <name>              testbench 模块（默认 mips_tb）
  --machine-code <name>           机器码文件名（默认 code.txt）
  --sim-time <value>              ISim TCL run 时长（默认 200us）
  --timeout-ms <n>                外部工具超时毫秒（默认 120000）
  --report <path>                 JSON 报告路径（默认 .co/out/continuous-trace-report.json）
  --skip-toolchain-check          跳过启动工具链检查
  --json                          结束后向 stdout 输出最终 JSON 报告
  -q, --quiet                     只输出最终摘要
  -h, --help                      显示帮助
  -v, --version                   显示版本
`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }

  configureHeadlessWorkspace({
    workspaceRoot: options.projectRoot,
    config: {
      'project.profile': PROFILE,
      'toolchain.java': options.java,
      'toolchain.mars': options.mars,
      'toolchain.marsP7': options.marsP7,
      'toolchain.isePath': options.isePath,
      'project.topModule': options.topModule,
      'project.testbench': options.testbench,
      'project.machineCode': options.machineCode,
      'project.simTime': options.simTime,
      'mips.memoryConfiguration': options.memoryConfiguration,
      'mips.delayedBranching': 'profile',
      'run.timeoutMs': options.timeoutMs,
      'run.showCommandBeforeRun': false,
      'run.revealOutput': false,
      'test.builtinGenerator.instructions': options.instructions,
      'test.builtinGenerator.p7InstructionCount': options.instructionCount,
      'test.continuousIntervalMs': options.intervalMs,
      'test.continuousMaxIterations': options.maxIterations,
      'test.continuousStopOnFailure': options.stopOnFailure,
      'test.continuousRetainedPassingCases': options.retainedPassingCases,
      'test.continuousReportRetainedIterations': options.reportRetainedIterations,
      'test.p7.stressMode': options.stressMode,
      'test.p7.interrupt': options.interrupt,
      'test.p7.timerInterrupt': options.timerInterrupt,
      'test.p7.externalInterruptIntensity': options.externalInterruptIntensity,
      'test.p7.timerIntensity': options.timerIntensity,
      'test.p7.probeScenarioCount': options.probeScenarioCount,
      'test.p7.exceptionRate': options.exceptionRate,
      'test.p7.exceptionTypes': options.exceptionTypes
    }
  });

  const services = createServices(options.quiet);
  const pipelineOptions: ContinuousPipelineOptions = {
    projectRoot: options.projectRoot,
    instructions: options.instructions,
    instructionCount: options.instructionCount,
    intervalMs: options.intervalMs,
    maxIterations: options.maxIterations,
    stopOnFailure: options.stopOnFailure,
    retainedPassingCases: options.retainedPassingCases,
    reportRetainedIterations: options.reportRetainedIterations,
    stressMode: options.stressMode,
    interrupt: options.interrupt,
    timerInterrupt: options.timerInterrupt,
    externalInterruptIntensity: options.externalInterruptIntensity,
    timerIntensity: options.timerIntensity,
    probeScenarioCount: options.probeScenarioCount,
    exceptionRate: options.exceptionRate,
    exceptionTypes: options.exceptionTypes,
    seed: options.seed,
    memoryConfiguration: options.memoryConfiguration,
    checkToolchain: options.checkToolchain,
    reportFile: options.reportFile
  };

  const controller = startContinuousP7Pipeline(services, pipelineOptions);
  let sigintCount = 0;
  const onSigint = (): void => {
    sigintCount++;
    controller.requestStop();
    if (sigintCount > 1) {
      process.exit(130);
    }
  };
  process.on('SIGINT', onSigint);

  try {
    const result = await controller.result;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      const summary = result.summary;
      process.stdout.write(`\nP7 持续测试完成: ${summary.passed} 通过, ${summary.failed} 失败, ${summary.errors} 错误\n`);
      process.stdout.write(`报告: ${options.reportFile}\n`);
    }
    process.exitCode = sigintCount > 0 ? 130 : (result.status === 'passed' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`P7 持续测试启动失败: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

if (require.main === module) {
  void main();
}

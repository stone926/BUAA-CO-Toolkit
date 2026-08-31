#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { automaticTestEngineMode } from '../../src/courseTesting/automaticTestPolicy';
import type { AppServices } from '../../src/types';
import { startContinuousP7Pipeline } from './pipeline';
import type { ContinuousPipelineOptions } from './pipeline';
import { configureHeadlessWorkspace } from './vscodeShim';

const PROFILE = 'P7';

/** Former public knobs that are now owned exclusively by the strongest automatic policy. */
const INTERNAL_POLICY_OPTIONS = new Set([
  'count',
  'instruction-count',
  'interval',
  'interval-ms',
  'iterations',
  'max-iterations',
  'stop-on-failure',
  'no-stop-on-failure',
  'retained-cases',
  'retained-passing-cases',
  'retained-iterations',
  'report-retained-iterations',
  'stress',
  'mode',
  'stress-mode',
  'interrupt',
  'no-interrupt',
  'timer-interrupt',
  'no-timer-interrupt',
  'external-intensity',
  'external-interrupt-intensity',
  'timer-intensity',
  'probe-scenarios',
  'probe-scenario-count',
  'exception-rate',
  'exception-types',
  'seed',
  'sim-time',
  'memory-config',
  'memory-configuration',
  'skip-toolchain-check',
  'timeout',
  'timeout-ms',
  'testbench',
  'machine-code'
]);

interface CliOptions {
  projectRoot: string;
  instructions: string;
  isePath: string;
  topModule: string;
  reportFile: string;
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
    statusBar: statusBar as unknown as AppServices['statusBar'],
    // dist/test-cli/src -> dist -> test-cli -> repository/extension root.
    // The headless pipeline shares the production bundled-Icarus resolver, so it
    // must expose the same installation root that VS Code supplies at runtime.
    extensionRoot: path.resolve(__dirname, '..', '..', '..', '..')
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

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const defaults = loadDefaults();
  const options: CliOptions = {
    projectRoot: process.cwd(),
    instructions: defaultString(defaults, 'test.instructions', ''),
    isePath: defaultString(defaults, 'toolchain.isePath', ''),
    topModule: defaultString(defaults, 'project.topModule', 'mips'),
    reportFile: '',
    quiet: false,
    json: false
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
    if (arg === '-v' || arg === '--version') {
      process.stdout.write('buaa-co-test-cli 0.1.0 (P7 strongest continuous test)\n');
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
    if (!arg.startsWith('--')) {
      throw new Error(`未知命令行参数: ${arg}`);
    }

    const raw = arg.slice(2);
    const equalsIndex = raw.indexOf('=');
    const name = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
    const inlineValue = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : undefined;
    if (INTERNAL_POLICY_OPTIONS.has(name)) {
      throw new Error(`参数 --${name} 已由最强持续测试策略接管，不再支持`);
    }
    const readValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      index++;
      if (index >= argv.length) {
        throw new Error(`参数 --${name} 缺少值`);
      }
      return argv[index];
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
      case 'ise':
      case 'ise-path':
        options.isePath = readValue();
        break;
      case 'top-module':
        options.topModule = readValue();
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
  let projectStat: fs.Stats;
  try {
    projectStat = fs.statSync(options.projectRoot);
  } catch {
    throw new Error('项目目录不存在或无法访问');
  }
  if (!projectStat.isDirectory()) {
    throw new Error('项目路径不是目录');
  }
}

function printHelp(): void {
  process.stdout.write(`BUAA CO Toolkit | 启动持续测试 (P7)

用法:
  co-test [options]

每轮自动执行 P7 允许范围内的最强测试组合。
覆盖强度、循环调度、失败停止、产物留存、随机化和仿真预算由工具统一管理，
不接受命令行覆盖；用户只需按需自定义 payload 指令集。

选项:
  --project <dir>                 项目/工作区根目录（默认当前目录）
  --instructions <list>           自定义 P7 指令集，逗号或空白分隔；留空使用 Profile 默认
  --ise <path>                    Xilinx ISE 安装目录
  --top-module <name>             Verilog 顶层模块（默认 mips）
  --report <path>                 JSON 报告输出位置
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
      'toolchain.isePath': options.isePath,
      'project.topModule': options.topModule,
      'mips.engine': automaticTestEngineMode,
      'mips.memoryConfiguration': 'auto',
      'mips.delayedBranching': 'profile',
      'run.showCommandBeforeRun': false,
      'run.revealOutput': false,
      'test.instructions': options.instructions
    }
  });

  const services = createServices(options.quiet);
  const pipelineOptions: ContinuousPipelineOptions = {
    projectRoot: options.projectRoot,
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
      process.stdout.write(`\n持续测试完成: ${summary.passed} 通过, ${summary.failed} 失败, ${summary.errors} 错误\n`);
    }
    process.exitCode = sigintCount > 0 ? 130 : (result.status === 'passed' ? 0 : 1);
  } catch {
    process.stderr.write('持续测试启动失败；请检查项目、工具链与输出位置配置\n');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

if (require.main === module) {
  void main();
}

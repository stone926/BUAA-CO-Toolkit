// @index verilog-user-cpu-testbench — 用户 CPU TB 的课程模板与稳定识别标记
import type { VerilogModule } from '../language/verilog/service';
import { buildStimulusTestbench, buildTestbench } from '../language/verilog/service';
import type { ConcreteProjectProfile } from '../projectProfile';

export type UserCpuTestbenchProfile = 'P4' | 'P5' | 'P6' | 'P7';

export interface UserTestbenchContext {
  profile: ConcreteProjectProfile;
  configuredTop: boolean;
  simTime: string;
}

function isCpuProfile(profile: ConcreteProjectProfile): profile is UserCpuTestbenchProfile {
  return profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7';
}

/** Only generated CPU top templates opt into the optional ASM picker. */
export function userCpuTestbenchProfile(text: string): UserCpuTestbenchProfile | undefined {
  return /^\uFEFF?\/\/ CO_USER_CPU_TESTBENCH (P[4-7])(?:\r?\n|$)/.exec(text)?.[1] as UserCpuTestbenchProfile | undefined;
}

export function buildUserTestbenchText(module: VerilogModule, tbName: string, context: UserTestbenchContext): string {
  if (!context.configuredTop || !isCpuProfile(context.profile)) {
    return buildStimulusTestbench(module, tbName);
  }

  // The runner's watchdog controls duration. The user can add stimulus without
  // editing the course clock, reset, memory hookups, or machine-code loading.
  const shell = buildTestbench(module, tbName, { profile: context.profile, finishDelay: false });
  const extraStimulus = [
    `// CO_USER_CPU_TESTBENCH ${context.profile}`,
    '// 运行仿真时可选择 ASM；插件会汇编并准备 code.txt，也可跳过选择。',
    '// P4/P5 CPU 的内部 IM 按课程约定读取 code.txt；P6/P7 的外部 IM 由本 TB 读取。',
    shell.replace(/endmodule\s*$/, [
      '    // ===== 在此编写额外激励（如中断），按需添加 initial/always 块 =====',
      'endmodule'
    ].join('\n')).trimEnd()
  ];
  return `${extraStimulus.join('\n')}\n`;
}

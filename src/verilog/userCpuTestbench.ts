// @index verilog-user-cpu-testbench — 用户 CPU TB 的课程模板与稳定识别标记
import type { VerilogModule } from '../language/verilog/service';
import { buildStimulusTestbench, buildTestbench } from '../language/verilog/service';
import { isVerilogCpuProfile, type ConcreteProjectProfile, type VerilogCpuProfile } from '../projectProfile';

export type UserCpuTestbenchProfile = VerilogCpuProfile;

export interface UserTestbenchContext {
  profile: ConcreteProjectProfile;
  configuredTop: boolean;
  simTime: string;
}

function isCpuProfile(profile: ConcreteProjectProfile): profile is UserCpuTestbenchProfile {
  return isVerilogCpuProfile(profile);
}

/** Only generated CPU top templates opt into the ASM picker. */
export function userCpuTestbenchProfile(text: string): UserCpuTestbenchProfile | undefined {
  const profile = /^\uFEFF?\/\/ CO_USER_CPU_TESTBENCH (P\d+)(?:\r?\n|$)/.exec(text)?.[1];
  return isVerilogCpuProfile(profile) ? profile : undefined;
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
    '// 运行仿真时选择 ASM，插件会自动汇编并准备 code.txt。',
    '// P4/P5 CPU 的内部 IM 按课程约定读取 code.txt；P6/P7 的外部 IM 由本 TB 读取。',
    shell.replace(/endmodule\s*$/, [
      '    // ===== 在此编写额外激励（如中断），按需添加 initial/always 块 =====',
      'endmodule'
    ].join('\n')).trimEnd()
  ];
  return `${extraStimulus.join('\n')}\n`;
}

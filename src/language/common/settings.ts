import { ProjectProfile } from '../../projectProfile';

export const defaultDisabledVerilogLintRules = ['vc-001', 'vc-003', 'vc-004', 'vc-008', 'vc-021'] as const;

export interface CoSettings {
  project: {
    profile: ProjectProfile;
    topModule: string;
    testbench: string;
    machineCode: string;
    simTime: string;
  };
  mips: {
    warnPseudoInstruction: boolean;
    instructionColorMode: 'realVsPseudo' | 'same' | 'byType';
    warnMissingExitSyscall: boolean;
  };
  verilog: {
    implicitNet: {
      diagnostic: 'off' | 'hint' | 'warning' | 'error';
      ignorePatterns: string[];
    };
    lint: {
      courseRules: boolean;
      synthesizableHints: boolean;
      disabledRules: string[];
    };
    format: {
      style: 'course' | 'compact' | 'custom';
      continuationIndent: number;
      spaceInRange: boolean;
      spaceBeforeInstancePorts: boolean;
      separateElse: boolean;
      maxBlankLines: number;
    };
  };
}

export const defaultCoSettings: CoSettings = {
  project: {
    profile: 'auto',
    topModule: 'mips',
    testbench: 'mips_tb',
    machineCode: 'code.txt',
    simTime: '200us'
  },
  mips: {
    warnPseudoInstruction: true,
    instructionColorMode: 'realVsPseudo',
    warnMissingExitSyscall: true
  },
  verilog: {
    implicitNet: {
      diagnostic: 'warning',
      ignorePatterns: ['^uut\\.', '^tb\\.']
    },
    lint: {
      courseRules: true,
      synthesizableHints: true,
      disabledRules: [...defaultDisabledVerilogLintRules]
    },
    format: {
      style: 'course',
      continuationIndent: 2,
      spaceInRange: true,
      spaceBeforeInstancePorts: true,
      separateElse: true,
      maxBlankLines: 1
    }
  }
};

export function mergeCoSettings(value: unknown): CoSettings {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<CoSettings> : {};
  return {
    project: {
      ...defaultCoSettings.project,
      ...(candidate.project ?? {})
    },
    mips: {
      ...defaultCoSettings.mips,
      ...(candidate.mips ?? {})
    },
    verilog: {
      implicitNet: {
        ...defaultCoSettings.verilog.implicitNet,
        ...(candidate.verilog?.implicitNet ?? {})
      },
      lint: {
        ...defaultCoSettings.verilog.lint,
        ...(candidate.verilog?.lint ?? {}),
        disabledRules: normalizeDisabledRules(candidate.verilog?.lint?.disabledRules)
      },
      format: normalizeVerilogFormat(candidate.verilog?.format)
    }
  };
}

export function isVerilogLintRuleEnabled(settings: CoSettings, rule: string): boolean {
  const normalized = rule.toLowerCase();
  return !settings.verilog.lint.disabledRules.some((item) => item.toLowerCase() === normalized);
}

function normalizeDisabledRules(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...defaultCoSettings.verilog.lint.disabledRules];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^vc-\d{3}$/.test(item)))];
}

function normalizeVerilogFormat(value: unknown): CoSettings['verilog']['format'] {
  const candidate = typeof value === 'object' && value !== null
    ? value as Partial<CoSettings['verilog']['format']>
    : {};
  const style: CoSettings['verilog']['format']['style'] =
    candidate.style === 'compact' || candidate.style === 'custom' ? candidate.style : 'course';
  const preset: CoSettings['verilog']['format'] = style === 'compact'
    ? {
      ...defaultCoSettings.verilog.format,
      style,
      continuationIndent: 1,
      spaceInRange: false,
      spaceBeforeInstancePorts: true,
      separateElse: false,
      maxBlankLines: 1
    }
    : {
      ...defaultCoSettings.verilog.format,
      style
    };
  return {
    ...preset,
    continuationIndent: normalizeInteger(candidate.continuationIndent, preset.continuationIndent, 1, 4),
    spaceInRange: typeof candidate.spaceInRange === 'boolean' ? candidate.spaceInRange : preset.spaceInRange,
    spaceBeforeInstancePorts: typeof candidate.spaceBeforeInstancePorts === 'boolean' ? candidate.spaceBeforeInstancePorts : preset.spaceBeforeInstancePorts,
    separateElse: typeof candidate.separateElse === 'boolean' ? candidate.separateElse : preset.separateElse,
    maxBlankLines: normalizeInteger(candidate.maxBlankLines, preset.maxBlankLines, 0, 3)
  };
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

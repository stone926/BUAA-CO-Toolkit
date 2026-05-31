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
      }
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

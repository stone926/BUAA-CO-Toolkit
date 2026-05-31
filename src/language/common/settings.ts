import { ProjectProfile } from '../../projectProfile';

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
      synthesizableHints: true
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
        ...(candidate.verilog?.lint ?? {})
      }
    }
  };
}

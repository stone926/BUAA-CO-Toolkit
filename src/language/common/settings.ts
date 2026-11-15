// @index settings — CoSettings接口/默认值/合并验证
import { isConcreteProjectProfile, ProjectProfile } from '../../projectProfile';
import { getProfileDefaults } from '../../courseConfig';
import { configDefault } from '../../configDefaults';
import { normalizeVerilogProjects, VerilogProjects } from '../verilog/projectContext';
import { normalizeProjectOverrides, ProjectOverrides } from '../../projectSettings';

export interface CoSettings {
  project: {
    overrides: ProjectOverrides;
    profileSource?: 'project';
    profile: ProjectProfile;
    topModule: string;
    testbench: string;
    machineCode: string;
    simTime: string;
  };
  mips: {
    warnPseudoInstruction: boolean;
    instructionTokenMode: 'realVsPseudo' | 'same' | 'byType';
    warnMissingExitSyscall: boolean;
  };
  verilog: {
    projects: VerilogProjects;
    syntax: {
      external: {
        mode: 'off' | 'onSave' | 'commandOnly';
      };
    };
    implicitNet: {
      diagnostic: 'off' | 'hint' | 'warning' | 'error';
    };
    lint: {
      courseRules: boolean;
    };
  };
}

export const defaultCoSettings: CoSettings = {
  project: {
    overrides: {},
    profile: configDefault<ProjectProfile>('project.profile'),
    topModule: configDefault<string>('project.topModule'),
    testbench: configDefault<string>('project.testbench'),
    machineCode: configDefault<string>('project.machineCode'),
    simTime: configDefault<string>('project.simTime')
  },
  mips: {
    warnPseudoInstruction: configDefault<boolean>('mips.warnPseudoInstruction'),
    instructionTokenMode: configDefault<'realVsPseudo' | 'same' | 'byType'>('mips.instructionTokenMode'),
    warnMissingExitSyscall: configDefault<boolean>('mips.warnMissingExitSyscall')
  },
  verilog: {
    projects: normalizeVerilogProjects(configDefault('verilog.projects')),
    syntax: {
      external: {
        mode: configDefault<'off' | 'onSave' | 'commandOnly'>('verilog.syntax.external.mode')
      }
    },
    implicitNet: {
      diagnostic: configDefault<'off' | 'hint' | 'warning' | 'error'>('verilog.implicitNet.diagnostic')
    },
    lint: {
      courseRules: configDefault<boolean>('verilog.lint.courseRules')
    }
  }
};

export function mergeCoSettings(value: unknown): CoSettings {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<CoSettings> : {};
  return {
    project: normalizeProject(candidate.project),
    mips: {
      ...defaultCoSettings.mips,
      ...(candidate.mips ?? {})
    },
    verilog: {
      projects: normalizeVerilogProjects(candidate.verilog?.projects),
      syntax: normalizeVerilogSyntax(candidate.verilog?.syntax),
      implicitNet: {
        ...defaultCoSettings.verilog.implicitNet,
        diagnostic: candidate.verilog?.implicitNet?.diagnostic ?? defaultCoSettings.verilog.implicitNet.diagnostic
      },
      lint: {
        courseRules: typeof candidate.verilog?.lint?.courseRules === 'boolean'
          ? candidate.verilog.lint.courseRules
          : defaultCoSettings.verilog.lint.courseRules
      }
    }
  };
}

function normalizeProject(value: Partial<CoSettings['project']> | undefined): CoSettings['project'] {
  const candidate = value ?? {};
  const profile = candidate.profile === 'auto' || isConcreteProjectProfile(candidate.profile)
    ? candidate.profile
    : defaultCoSettings.project.profile;
  const profileDefaults = isConcreteProjectProfile(profile) ? getProfileDefaults(profile) : {};
  return {
    overrides: normalizeProjectOverrides(candidate.overrides),
    ...(candidate.profileSource === 'project' ? { profileSource: 'project' as const } : {}),
    profile,
    // The manifest intentionally publishes blank top/testbench defaults. Keep that
    // sentinel while Profile is auto so the inference layer can distinguish an
    // inherited value from a user override and apply the resolved Profile defaults.
    topModule: projectEntrypoint(
      candidate.topModule,
      profileDefaults.topModule ?? defaultCoSettings.project.topModule,
      profile === 'auto'
    ),
    testbench: projectEntrypoint(
      candidate.testbench,
      profileDefaults.testbench ?? defaultCoSettings.project.testbench,
      profile === 'auto'
    ),
    machineCode: nonEmptyString(candidate.machineCode, profileDefaults.machineCode ?? defaultCoSettings.project.machineCode),
    simTime: nonEmptyString(candidate.simTime, profileDefaults.simTime ?? defaultCoSettings.project.simTime)
  };
}

function projectEntrypoint(value: unknown, fallback: string, deferBlank: boolean): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || (deferBlank ? '' : fallback);
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeVerilogSyntax(value: unknown): CoSettings['verilog']['syntax'] {
  const candidate = typeof value === 'object' && value !== null
    ? value as Partial<CoSettings['verilog']['syntax']>
    : {};
  const externalCandidate = typeof candidate.external === 'object' && candidate.external !== null
    ? candidate.external as Partial<CoSettings['verilog']['syntax']['external']>
    : {};
  const mode = externalCandidate.mode === 'off' || externalCandidate.mode === 'commandOnly' || externalCandidate.mode === 'onSave'
    ? externalCandidate.mode
    : defaultCoSettings.verilog.syntax.external.mode;
  return {
    external: {
      mode
    }
  };
}

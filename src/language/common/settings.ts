// @index settings — CoSettings接口/默认值/合并验证/诊断禁用键
import { isConcreteProjectProfile, ProjectProfile } from '../../projectProfile';
import { getProfileDefaults } from '../../courseConfig';
import { configDefault, configDefaultArray } from '../../configDefaults';
export const disableDiagnosticCodeCommand = 'co.diagnostics.disableCode';

export interface CoSettings {
  diagnostics: {
    disabledCodes: string[];
    disabledFileCodes: string[];
  };
  project: {
    profile: ProjectProfile;
    topModule: string;
    testbench: string;
    machineCode: string;
    simTime: string;
  };
  run: {
    timeoutMs: number;
  };
  mips: {
    warnPseudoInstruction: boolean;
    instructionTokenMode: 'realVsPseudo' | 'same' | 'byType';
    warnMissingExitSyscall: boolean;
  };
  verilog: {
    syntax: {
      external: {
        mode: 'off' | 'onSave' | 'commandOnly';
        timeoutMs: number;
      };
    };
    implicitNet: {
      diagnostic: 'off' | 'hint' | 'warning' | 'error';
      ignorePatterns: string[];
    };
    lint: {
      courseRules: boolean;
    };
  };
}

export const defaultCoSettings: CoSettings = {
  diagnostics: {
    disabledCodes: configDefaultArray('diagnostics.disabledCodes'),
    disabledFileCodes: configDefaultArray('diagnostics.disabledFileCodes')
  },
  project: {
    profile: configDefault<ProjectProfile>('project.profile'),
    topModule: configDefault<string>('project.topModule'),
    testbench: configDefault<string>('project.testbench'),
    machineCode: configDefault<string>('project.machineCode'),
    simTime: configDefault<string>('project.simTime')
  },
  run: {
    timeoutMs: configDefault<number>('run.timeoutMs')
  },
  mips: {
    warnPseudoInstruction: configDefault<boolean>('mips.warnPseudoInstruction'),
    instructionTokenMode: configDefault<'realVsPseudo' | 'same' | 'byType'>('mips.instructionTokenMode'),
    warnMissingExitSyscall: configDefault<boolean>('mips.warnMissingExitSyscall')
  },
  verilog: {
    syntax: {
      external: {
        mode: configDefault<'off' | 'onSave' | 'commandOnly'>('verilog.syntax.external.mode'),
        timeoutMs: configDefault<number>('verilog.syntax.external.timeoutMs')
      }
    },
    implicitNet: {
      diagnostic: configDefault<'off' | 'hint' | 'warning' | 'error'>('verilog.implicitNet.diagnostic'),
      ignorePatterns: configDefaultArray('verilog.implicitNet.ignorePatterns')
    },
    lint: {
      courseRules: configDefault<boolean>('verilog.lint.courseRules')
    }
  }
};

export function mergeCoSettings(value: unknown): CoSettings {
  const candidate = typeof value === 'object' && value !== null ? value as Partial<CoSettings> : {};
  return {
    diagnostics: {
      ...defaultCoSettings.diagnostics,
      ...(candidate.diagnostics ?? {}),
      disabledCodes: normalizeDisabledDiagnosticCodes(candidate.diagnostics?.disabledCodes),
      disabledFileCodes: normalizeDisabledDiagnosticFileCodes(candidate.diagnostics?.disabledFileCodes)
    },
    project: normalizeProject(candidate.project),
    run: {
      ...defaultCoSettings.run,
      ...(candidate.run ?? {}),
      timeoutMs: normalizeInteger(candidate.run?.timeoutMs, defaultCoSettings.run.timeoutMs, 1000, 600000)
    },
    mips: {
      ...defaultCoSettings.mips,
      ...(candidate.mips ?? {})
    },
    verilog: {
      syntax: normalizeVerilogSyntax(candidate.verilog?.syntax),
      implicitNet: {
        ...defaultCoSettings.verilog.implicitNet,
        ...(candidate.verilog?.implicitNet ?? {})
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
      mode,
      timeoutMs: normalizeInteger(
        externalCandidate.timeoutMs,
        defaultCoSettings.verilog.syntax.external.timeoutMs,
        0,
        600000
      )
    }
  };
}

export function diagnosticCodeKey(languageId: string, code: string): string {
  return `${languageId.trim().toLowerCase()}:${code.trim().toLowerCase()}`;
}

export function diagnosticFileCodeKey(languageId: string, code: string, documentUri: string): string {
  return `${diagnosticCodeKey(languageId, code)}@${documentUri.trim()}`;
}

export function diagnosticCodeToString(code: unknown): string | undefined {
  if (typeof code !== 'string' && typeof code !== 'number') {
    return undefined;
  }
  const normalized = String(code).trim().toLowerCase();
  return normalized && /^\S+$/.test(normalized) ? normalized : undefined;
}

export function isDiagnosticCodeDisabled(settings: CoSettings, languageId: string, code: unknown): boolean {
  const normalized = diagnosticCodeToString(code);
  if (!normalized) {
    return false;
  }
  const languageKey = diagnosticCodeKey(languageId, normalized);
  return settings.diagnostics.disabledCodes.some((item) => item === languageKey || item === normalized);
}

export function isDiagnosticCodeDisabledForFile(
  settings: CoSettings,
  languageId: string,
  code: unknown,
  documentUri: string | undefined
): boolean {
  const normalized = diagnosticCodeToString(code);
  if (!normalized) {
    return false;
  }
  if (isDiagnosticCodeDisabled(settings, languageId, normalized)) {
    return true;
  }
  if (!documentUri?.trim()) {
    return false;
  }
  const fileKey = diagnosticFileCodeKey(languageId, normalized, documentUri);
  const codeOnlyFileKey = `${normalized}@${documentUri.trim()}`;
  return settings.diagnostics.disabledFileCodes.some((item) => item === fileKey || item === codeOnlyFileKey);
}

function normalizeDisabledDiagnosticCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...defaultCoSettings.diagnostics.disabledCodes];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => Boolean(item) && /^\S+$/.test(item)))].sort();
}

function normalizeDisabledDiagnosticFileCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...defaultCoSettings.diagnostics.disabledFileCodes];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeDiagnosticFileCode(item))
    .filter((item): item is string => Boolean(item)))].sort();
}

function normalizeDiagnosticFileCode(value: string): string | undefined {
  const trimmed = value.trim();
  const separator = trimmed.indexOf('@');
  if (separator <= 0 || separator === trimmed.length - 1) {
    return undefined;
  }
  const codePart = trimmed.slice(0, separator).trim();
  const uriPart = trimmed.slice(separator + 1).trim();
  if (!uriPart || /\s/.test(uriPart)) {
    return undefined;
  }
  const normalizedCodePart = normalizeDisabledDiagnosticCodes([codePart])[0];
  return normalizedCodePart ? `${normalizedCodePart}@${uriPart}` : undefined;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

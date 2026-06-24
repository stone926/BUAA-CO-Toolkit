import { ProjectProfile } from '../../projectProfile';

export const defaultDisabledVerilogLintRules = ['vc-001', 'vc-003', 'vc-004', 'vc-008', 'vc-017', 'vc-021'] as const;
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
  toolchain: {
    isePath: string;
  };
  run: {
    timeoutMs: number;
  };
  mips: {
    warnPseudoInstruction: boolean;
    instructionColorMode: 'realVsPseudo' | 'same' | 'byType';
    warnMissingExitSyscall: boolean;
  };
  verilog: {
    syntax: {
      ise: {
        enabled: boolean;
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
      synthesizableHints: boolean;
      disabledRules: string[];
    };
    format: {
      style: 'course' | 'compact' | 'custom';
      continuationIndent: number;
      spaceInRange: boolean;
      declarationRangeSpacing: 'space' | 'compact' | 'preserve';
      spaceBeforeInstancePorts: boolean;
      separateElse: boolean;
      maxBlankLines: number;
    };
  };
}

export const defaultCoSettings: CoSettings = {
  diagnostics: {
    disabledCodes: [],
    disabledFileCodes: []
  },
  project: {
    profile: 'auto',
    topModule: 'mips',
    testbench: 'mips_tb',
    machineCode: 'code.txt',
    simTime: '200us'
  },
  toolchain: {
    isePath: ''
  },
  run: {
    timeoutMs: 120000
  },
  mips: {
    warnPseudoInstruction: true,
    instructionColorMode: 'realVsPseudo',
    warnMissingExitSyscall: true
  },
  verilog: {
    syntax: {
      ise: {
        enabled: true,
        mode: 'onSave',
        timeoutMs: 0
      }
    },
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
      declarationRangeSpacing: 'space',
      spaceBeforeInstancePorts: true,
      separateElse: true,
      maxBlankLines: 1
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
    project: {
      ...defaultCoSettings.project,
      ...(candidate.project ?? {})
    },
    toolchain: {
      ...defaultCoSettings.toolchain,
      ...(candidate.toolchain ?? {}),
      isePath: typeof candidate.toolchain?.isePath === 'string' ? candidate.toolchain.isePath.trim() : defaultCoSettings.toolchain.isePath
    },
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
        ...defaultCoSettings.verilog.lint,
        ...(candidate.verilog?.lint ?? {}),
        disabledRules: normalizeDisabledRules(candidate.verilog?.lint?.disabledRules)
      },
      format: normalizeVerilogFormat(candidate.verilog?.format)
    }
  };
}

function normalizeVerilogSyntax(value: unknown): CoSettings['verilog']['syntax'] {
  const candidate = typeof value === 'object' && value !== null
    ? value as Partial<CoSettings['verilog']['syntax']>
    : {};
  const iseCandidate = typeof candidate.ise === 'object' && candidate.ise !== null
    ? candidate.ise as Partial<CoSettings['verilog']['syntax']['ise']>
    : {};
  const mode = iseCandidate.mode === 'off' || iseCandidate.mode === 'commandOnly' || iseCandidate.mode === 'onSave'
    ? iseCandidate.mode
    : defaultCoSettings.verilog.syntax.ise.mode;
  return {
    ise: {
      enabled: typeof iseCandidate.enabled === 'boolean' ? iseCandidate.enabled : defaultCoSettings.verilog.syntax.ise.enabled,
      mode,
      timeoutMs: normalizeInteger(iseCandidate.timeoutMs, defaultCoSettings.verilog.syntax.ise.timeoutMs, 0, 600000)
    }
  };
}

export function isVerilogLintRuleEnabled(settings: CoSettings, rule: string): boolean {
  const normalized = rule.toLowerCase();
  return !settings.verilog.lint.disabledRules.some((item) => item.toLowerCase() === normalized);
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
    declarationRangeSpacing: normalizeDeclarationRangeSpacing(candidate.declarationRangeSpacing, preset.declarationRangeSpacing),
    spaceBeforeInstancePorts: typeof candidate.spaceBeforeInstancePorts === 'boolean' ? candidate.spaceBeforeInstancePorts : preset.spaceBeforeInstancePorts,
    separateElse: typeof candidate.separateElse === 'boolean' ? candidate.separateElse : preset.separateElse,
    maxBlankLines: normalizeInteger(candidate.maxBlankLines, preset.maxBlankLines, 0, 3)
  };
}

function normalizeDeclarationRangeSpacing(
  value: unknown,
  fallback: CoSettings['verilog']['format']['declarationRangeSpacing']
): CoSettings['verilog']['format']['declarationRangeSpacing'] {
  return value === 'space' || value === 'compact' || value === 'preserve' ? value : fallback;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

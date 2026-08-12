import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

const inputPaths = {
  mipsInstructions: path.join(projectRoot, 'resources', 'mips', 'instructions.json'),
  mipsDirectives: path.join(projectRoot, 'resources', 'mips', 'directives.json'),
  mipsRegisters: path.join(projectRoot, 'resources', 'mips', 'registers.json'),
  verilogKeywords: path.join(projectRoot, 'resources', 'verilog', 'keywords.json'),
  systemVerilogKeywords: path.join(projectRoot, 'resources', 'verilog', 'systemverilog.json'),
};

const outputPaths = {
  mips: path.join(projectRoot, 'syntaxes', 'mips.tmLanguage.json'),
  verilog: path.join(projectRoot, 'syntaxes', 'verilog.tmLanguage.json'),
  systemVerilog: path.join(projectRoot, 'syntaxes', 'systemverilog.tmLanguage.json'),
};

const MIPS_IDENTIFIER = '[A-Za-z_.$][A-Za-z0-9_.$]*';
const MIPS_CALLABLE_IDENTIFIER = '[A-Za-z_.][A-Za-z0-9_.$]*';
const MIPS_IDENTIFIER_END = '(?![A-Za-z0-9_.$])';
const VERILOG_IDENTIFIER = '[A-Za-z_][A-Za-z0-9_$]*';
const VERILOG_IDENTIFIER_START = '(?<![A-Za-z0-9_$])';
const VERILOG_IDENTIFIER_END = '(?![A-Za-z0-9_$])';
const INTERNAL_UNKNOWN_MIPS_INSTRUCTION = '_co_internal_unknown_instruction';

const VERILOG_KEYWORD_SCOPES = {
  control: 'keyword.control.verilog',
  declaration: 'keyword.declaration.verilog',
  storage: 'storage.type.verilog',
  modifier: 'storage.modifier.verilog',
  primitive: 'support.function.primitive.verilog',
  strength: 'constant.language.strength.verilog',
  configuration: 'keyword.other.configuration.verilog',
  unsupported: 'keyword.other.unsupported.verilog',
};

const SYSTEMVERILOG_KEYWORD_SCOPES = {
  control: 'keyword.control.systemverilog',
  declaration: 'keyword.declaration.systemverilog',
  storage: 'storage.type.systemverilog',
  modifier: 'storage.modifier.systemverilog',
  other: 'keyword.other.systemverilog',
};

const VERILOG_FORMAT_SYSTEM_TASK_NAMES = new Set([
  'display',
  'fdisplay',
  'fwrite',
  'monitor',
  'write',
]);

function parseArguments(argv) {
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
  }
  return { check: argv.includes('--check') };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} contains duplicate entry ${JSON.stringify(value)}`);
    }
    seen.add(value);
  }
  return [...seen];
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function regexAlternation(values) {
  return [...values]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(escapeRegex)
    .join('|');
}

function generatedGrammar(name, scopeName, fileTypes, patterns, repository, sources) {
  return {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name,
    scopeName,
    fileTypes,
    'x-generated-from': sources,
    patterns,
    repository,
  };
}

function mipsStringRule() {
  return {
    name: 'string.quoted.double.mips',
    begin: '"',
    beginCaptures: {
      0: { name: 'punctuation.definition.string.begin.mips' },
    },
    // The zero-width alternative deliberately closes an unterminated string at
    // the physical line boundary so one typo cannot recolour the rest of a file.
    end: '"|(?=$)',
    endCaptures: {
      0: { name: 'punctuation.definition.string.end.mips' },
    },
    patterns: [
      {
        name: 'constant.character.escape.mips',
        match: '\\\\(?:x[0-9A-Fa-f]{1,8}|u[0-9A-Fa-f]{4}|[^\\r\\n])',
      },
    ],
  };
}

function mipsOperandPatterns(options = {}) {
  const { dollarMacroParameters = false } = options;
  return [
    { include: '#comments' },
    { include: '#strings' },
    { include: '#macroParameters' },
    // Known GPR/FPR names win over the permissive $name macro-parameter form.
    { include: '#registers' },
    ...(dollarMacroParameters ? [{ include: '#dollarMacroParameters' }] : []),
    { include: '#characters' },
    { include: '#numbers' },
    { include: '#operators' },
    { include: '#punctuation' },
  ];
}

function mipsStatement(begin, captures, name, patterns = mipsOperandPatterns()) {
  return {
    name,
    begin,
    beginCaptures: captures,
    end: '(?=$)',
    patterns,
  };
}

function qualifyMipsRule(prefix, name) {
  return prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name;
}

function mipsStatementStartPatterns(includeLabels, prefix = '') {
  const include = (name) => ({ include: `#${qualifyMipsRule(prefix, name)}` });
  return [
    ...(includeLabels ? [include('labels')] : []),
    ...(prefix ? [] : [include('macroDefinitionStatement')]),
    include('eqvDefinitionStatement'),
    include('instructionStatement'),
    include('knownDirectiveStatement'),
    include('unknownDirectiveStatement'),
    include('bareMacroStatement'),
  ];
}

function buildMipsStatementRules(options) {
  const {
    prefix = '',
    instructions,
    knownDirectives,
    excludedInternalInstruction,
    operandPatterns = mipsOperandPatterns(),
  } = options;
  const rule = (name) => qualifyMipsRule(prefix, name);

  return {
    [rule('eqvDefinitionStatement')]: mipsStatement(
      `\\G[\\t ]*((?i:${escapeRegex('.eqv')}))[\\t ]+(${MIPS_IDENTIFIER})${MIPS_IDENTIFIER_END}`,
      {
        1: { name: 'keyword.directive.eqv.mips' },
        2: { name: 'variable.other.constant.eqv.mips' },
      },
      'meta.eqv.definition.mips',
      operandPatterns,
    ),
    [rule('instructionStatement')]: mipsStatement(
      `\\G[\\t ]*((?i:${instructions}))${MIPS_IDENTIFIER_END}`,
      {
        1: { name: 'keyword.control.instruction.mips' },
      },
      'meta.instruction.mips',
      operandPatterns,
    ),
    [rule('knownDirectiveStatement')]: mipsStatement(
      `\\G[\\t ]*((?i:${knownDirectives}))${MIPS_IDENTIFIER_END}`,
      {
        1: { name: 'keyword.directive.mips' },
      },
      'meta.directive.mips',
      operandPatterns,
    ),
    [rule('unknownDirectiveStatement')]: mipsStatement(
      `\\G[\\t ]*(\\.[A-Za-z_][A-Za-z0-9_.$]*)${MIPS_IDENTIFIER_END}`,
      {
        1: { name: 'keyword.directive.unknown.mips' },
      },
      'meta.directive.unknown.mips',
      operandPatterns,
    ),
    [rule('bareMacroStatement')]: mipsStatement(
      `\\G[\\t ]*${excludedInternalInstruction}(${MIPS_CALLABLE_IDENTIFIER})${MIPS_IDENTIFIER_END}`,
      {
        1: { name: 'entity.name.function.macro-call.mips' },
      },
      'meta.macro.invocation.mips',
      operandPatterns,
    ),
  };
}

function mipsLabelRule(prefix = '', operandPatterns = mipsOperandPatterns()) {
  return {
    name: 'meta.label.mips',
    begin: `\\G[\\t ]*(${MIPS_IDENTIFIER})(?:[\\t ]*)(:)`,
    beginCaptures: {
      1: { name: 'entity.name.label.mips' },
      2: { name: 'punctuation.separator.label.mips' },
    },
    end: '(?=$)',
    patterns: [
      { include: '#comments' },
      { include: '#strings' },
      // Recursing through a begin rule refreshes TextMate's \G anchor after
      // each label, so any number of leading labels remains tokenizable.
      ...mipsStatementStartPatterns(true, prefix),
      ...operandPatterns,
    ],
  };
}

function buildMipsGrammar(instructionEntries, directiveEntries, registerEntries) {
  if (!Array.isArray(instructionEntries)) {
    throw new Error('resources/mips/instructions.json must be an array');
  }
  if (!Array.isArray(registerEntries)) {
    throw new Error('resources/mips/registers.json must be an array');
  }

  const instructionNames = unique(
    instructionEntries.map((entry, index) => {
      if (typeof entry?.mnemonic !== 'string') {
        throw new Error(`MIPS instruction at index ${index} has no mnemonic`);
      }
      return entry.mnemonic;
    }),
    'MIPS instructions',
  ).filter((mnemonic) => mnemonic !== INTERNAL_UNKNOWN_MIPS_INSTRUCTION);

  const directives = unique(
    assertStringArray(directiveEntries, 'resources/mips/directives.json'),
    'MIPS directives',
  );
  const registerNames = unique(
    registerEntries.flatMap((entry, index) => {
      if (!entry || !Array.isArray(entry.names)) {
        throw new Error(`MIPS register at index ${index} has no names array`);
      }
      return assertStringArray(entry.names, `MIPS register names at index ${index}`);
    }),
    'MIPS register names',
  );

  const instructions = regexAlternation(instructionNames);
  const knownDirectives = regexAlternation(directives);
  const generalRegisters = regexAlternation([
    ...registerNames,
    ...Array.from({ length: 32 }, (_, index) => `$${index}`),
  ]);
  const excludedInternalInstruction =
    `(?!(?i:${escapeRegex(INTERNAL_UNKNOWN_MIPS_INSTRUCTION)})${MIPS_IDENTIFIER_END})`;
  const normalOperandPatterns = mipsOperandPatterns();
  const macroOperandPatterns = mipsOperandPatterns({ dollarMacroParameters: true });

  const repository = {
    line: {
      begin: '^(?=.)',
      end: '$',
      patterns: [
        { include: '#comments' },
        { include: '#strings' },
        ...mipsStatementStartPatterns(true),
        ...normalOperandPatterns,
      ],
    },
    comments: {
      patterns: [
        {
          name: 'comment.line.number-sign.mips',
          match: '#.*$',
        },
      ],
    },
    strings: {
      patterns: [mipsStringRule()],
    },
    labels: mipsLabelRule('', normalOperandPatterns),
    macroLabels: mipsLabelRule('macro', macroOperandPatterns),
    macroDefinitionStatement: {
      name: 'meta.macro.definition.mips',
      begin: `\\G[\\t ]*((?i:${escapeRegex('.macro')}))[\\t ]+(${MIPS_CALLABLE_IDENTIFIER})${MIPS_IDENTIFIER_END}`,
      beginCaptures: {
        1: { name: 'keyword.directive.macro.mips' },
        2: { name: 'entity.name.function.macro.mips' },
      },
      end: `^[\\t ]*((?i:${escapeRegex('.end_macro')}))${MIPS_IDENTIFIER_END}`,
      endCaptures: {
        1: { name: 'keyword.directive.macro.mips' },
      },
      patterns: [
        { include: '#comments' },
        { include: '#strings' },
        ...mipsStatementStartPatterns(true, 'macro'),
        ...macroOperandPatterns,
      ],
    },
    ...buildMipsStatementRules({
      instructions,
      knownDirectives,
      excludedInternalInstruction,
      operandPatterns: normalOperandPatterns,
    }),
    ...buildMipsStatementRules({
      prefix: 'macro',
      instructions,
      knownDirectives,
      excludedInternalInstruction,
      operandPatterns: macroOperandPatterns,
    }),
    macroParameters: {
      patterns: [
        {
          name: 'variable.parameter.macro.mips',
          match: `%${MIPS_IDENTIFIER}`,
        },
      ],
    },
    dollarMacroParameters: {
      patterns: [
        {
          name: 'variable.parameter.macro.mips',
          match: '\\$[A-Za-z_][A-Za-z0-9_.$]*',
        },
      ],
    },
    registers: {
      patterns: [
        {
          name: 'variable.language.register.floating-point.mips',
          match: '(?i:\\$f(?:[0-9]|[12][0-9]|3[01]))(?![A-Za-z0-9_])',
        },
        {
          name: 'variable.language.register.mips',
          match: `(?i:${generalRegisters})(?![A-Za-z0-9_])`,
        },
      ],
    },
    characters: {
      patterns: [
        {
          name: 'constant.character.mips',
          match: "'(?:\\\\(?:x[0-9A-Fa-f]{1,8}|u[0-9A-Fa-f]{4}|[^\\r\\n])|[^\\\\'\\r\\n])'",
        },
      ],
    },
    numbers: {
      patterns: [
        {
          name: 'constant.numeric.float.mips',
          match: '(?<![A-Za-z0-9_.$])[-+]?(?:(?:[0-9][0-9_]*\\.[0-9_]*|\\.[0-9][0-9_]*)(?:[eE][-+]?[0-9][0-9_]*)?|[0-9][0-9_]*[eE][-+]?[0-9][0-9_]*)(?![A-Za-z0-9_.$])',
        },
        {
          name: 'constant.numeric.hex.mips',
          match: '(?<![A-Za-z0-9_.$])[-+]?0[xX][0-9A-Fa-f][0-9A-Fa-f_]*(?![A-Za-z0-9_.$])',
        },
        {
          name: 'constant.numeric.binary.mips',
          match: '(?<![A-Za-z0-9_.$])[-+]?0[bB][01][01_]*(?![A-Za-z0-9_.$])',
        },
        {
          name: 'constant.numeric.octal.mips',
          match: '(?<![A-Za-z0-9_.$])[-+]?0[0-7][0-7_]*(?![A-Za-z0-9_.$])',
        },
        {
          name: 'constant.numeric.mips',
          match: '(?<![A-Za-z0-9_.$])[-+]?[0-9][0-9_]*(?![A-Za-z0-9_.$])',
        },
      ],
    },
    operators: {
      patterns: [
        {
          name: 'keyword.operator.mips',
          match: '<<|>>|[-+*/%&|^~]',
        },
      ],
    },
    punctuation: {
      patterns: [
        {
          name: 'punctuation.separator.comma.mips',
          match: ',',
        },
        {
          name: 'punctuation.section.parens.mips',
          match: '[()]',
        },
        {
          name: 'punctuation.section.brackets.mips',
          match: '[\\[\\]]',
        },
        {
          name: 'punctuation.separator.colon.mips',
          match: ':',
        },
      ],
    },
  };

  return generatedGrammar(
    'MIPS ASM',
    'source.mips',
    ['asm', 's', 'mips'],
    [{ include: '#line' }],
    repository,
    [
      'resources/mips/instructions.json',
      'resources/mips/directives.json',
      'resources/mips/registers.json',
    ],
  );
}

function verilogStringRule(formatPlaceholders = false) {
  return {
    name: 'string.quoted.double.verilog',
    begin: '"',
    beginCaptures: {
      0: { name: 'punctuation.definition.string.begin.verilog' },
    },
    // An odd run of trailing backslashes escapes the physical newline and
    // keeps the string state; an even run does not. The closing quote remains
    // available only when it is not itself escaped.
    end: '(?<!\\\\)(?:\\\\\\\\)*\\K"|(?<!\\\\)(?=(?:\\\\\\\\)*\\n)',
    endCaptures: {
      0: { name: 'punctuation.definition.string.end.verilog' },
    },
    patterns: [
      {
        name: 'constant.character.escape.verilog',
        match: '\\\\(?:x[0-9A-Fa-f]+|[0-7]{1,3}|[^\\r\\n])',
      },
      ...(formatPlaceholders ? [{
        // TextMate cannot reliably infer which system task owns a string. A
        // format-call meta scope supplies the missing lexical call context.
        name: 'constant.other.placeholder.verilog',
        match: '%[-+0# ]*[0-9]*(?:\\.[0-9]+)?[bBcCdDeEfFgGhHoOsStTmMuUvVzZxX%]',
      }] : []),
    ],
  };
}

function buildVerilogGrammar(keywordResource) {
  if (!keywordResource || typeof keywordResource !== 'object') {
    throw new Error('resources/verilog/keywords.json must be an object');
  }
  if (!keywordResource.keywordGroups || typeof keywordResource.keywordGroups !== 'object') {
    throw new Error('resources/verilog/keywords.json must define keywordGroups');
  }

  const keywordGroups = Object.entries(keywordResource.keywordGroups).map(([group, values]) => {
    if (!Object.hasOwn(VERILOG_KEYWORD_SCOPES, group)) {
      throw new Error(`No TextMate scope is defined for Verilog keyword group ${JSON.stringify(group)}`);
    }
    return [group, unique(assertStringArray(values, `Verilog keyword group ${group}`), `Verilog keyword group ${group}`)];
  });
  const compilerDirectives = unique(
    assertStringArray(keywordResource.compilerDirectives, 'Verilog compilerDirectives'),
    'Verilog compilerDirectives',
  );
  const systemTasks = unique(
    assertStringArray(keywordResource.systemTasks, 'Verilog systemTasks'),
    'Verilog systemTasks',
  );
  if (!keywordResource.operators || typeof keywordResource.operators !== 'object') {
    throw new Error('resources/verilog/keywords.json must define operators');
  }
  const operatorGroups = Object.entries(keywordResource.operators).flatMap(([group, values]) =>
    assertStringArray(values, `Verilog operator group ${group}`),
  );
  // Some tokens intentionally occur in more than one semantic operator group
  // (for example <= is both relational and nonblocking assignment syntax).
  const operators = [...new Set(operatorGroups)];

  const directiveAlternation = regexAlternation(compilerDirectives);
  const systemTaskAlternation = regexAlternation(systemTasks);
  const formatSystemTasks = systemTasks.filter((task) =>
    VERILOG_FORMAT_SYSTEM_TASK_NAMES.has(task),
  );
  if (formatSystemTasks.length !== VERILOG_FORMAT_SYSTEM_TASK_NAMES.size) {
    throw new Error('Verilog systemTasks must contain every TextMate format-call task');
  }
  const formatSystemTaskAlternation = regexAlternation(formatSystemTasks);
  const operatorAlternation = regexAlternation(
    [...new Set([...operators, '->', '=>', '*>', '+:', '-:'])],
  );

  const keywordPatterns = keywordGroups.map(([group, values]) => ({
    name: VERILOG_KEYWORD_SCOPES[group],
    match: `${VERILOG_IDENTIFIER_START}(?:${regexAlternation(values)})${VERILOG_IDENTIFIER_END}`,
  }));

  const repository = {
    comments: {
      patterns: [
        {
          name: 'comment.line.double-slash.verilog',
          begin: '//',
          beginCaptures: {
            0: { name: 'punctuation.definition.comment.verilog' },
          },
          end: '$',
        },
        {
          name: 'comment.block.verilog',
          begin: '/\\*',
          beginCaptures: {
            0: { name: 'punctuation.definition.comment.begin.verilog' },
          },
          end: '\\*/',
          endCaptures: {
            0: { name: 'punctuation.definition.comment.end.verilog' },
          },
        },
      ],
    },
    strings: {
      patterns: [verilogStringRule()],
    },
    formatStrings: {
      patterns: [verilogStringRule(true)],
    },
    formatCalls: {
      patterns: [
        {
          name: 'meta.function-call.format.verilog',
          begin: `(\\$(?:${formatSystemTaskAlternation})${VERILOG_IDENTIFIER_END})([\\t ]*)(\\()`,
          beginCaptures: {
            1: { name: 'support.function.system-task.verilog' },
            3: { name: 'punctuation.section.group.begin.verilog' },
          },
          end: '\\)',
          endCaptures: {
            0: { name: 'punctuation.section.group.end.verilog' },
          },
          patterns: [
            { include: '#comments' },
            { include: '#formatStrings' },
            { include: '#formatCallParentheses' },
            { include: '#strings' },
            { include: '#numbers' },
            { include: '#knownSystemTasks' },
            { include: '#genericSystemTasks' },
            { include: '#escapedIdentifiers' },
            { include: '#keywords' },
            { include: '#operators' },
            { include: '#punctuation' },
          ],
        },
      ],
    },
    formatCallParentheses: {
      name: 'meta.group.verilog',
      begin: '\\(',
      beginCaptures: {
        0: { name: 'punctuation.section.group.begin.verilog' },
      },
      end: '\\)',
      endCaptures: {
        0: { name: 'punctuation.section.group.end.verilog' },
      },
      patterns: [
        { include: '#comments' },
        { include: '#formatStrings' },
        { include: '#formatCallParentheses' },
        { include: '#strings' },
        { include: '#numbers' },
        { include: '#knownSystemTasks' },
        { include: '#genericSystemTasks' },
        { include: '#escapedIdentifiers' },
        { include: '#keywords' },
        { include: '#operators' },
        { include: '#punctuation' },
      ],
    },
    directiveDefinitions: {
      patterns: [
        {
          name: 'meta.preprocessor.define.verilog',
          match: `^([\\t ]*)(\`)(define)[\\t ]+(${VERILOG_IDENTIFIER})${VERILOG_IDENTIFIER_END}`,
          captures: {
            2: { name: 'punctuation.definition.directive.verilog' },
            3: { name: 'keyword.control.directive.verilog' },
            4: { name: 'entity.name.function.preprocessor.verilog' },
          },
        },
      ],
    },
    directiveConditions: {
      patterns: [
        {
          name: 'meta.preprocessor.condition.verilog',
          match: `^([\\t ]*)(\`)(ifdef|ifndef|elsif)[\\t ]+(${VERILOG_IDENTIFIER})${VERILOG_IDENTIFIER_END}`,
          captures: {
            2: { name: 'punctuation.definition.directive.verilog' },
            3: { name: 'keyword.control.directive.verilog' },
            4: { name: 'variable.other.preprocessor.verilog' },
          },
        },
      ],
    },
    directiveMacroReferences: {
      patterns: [
        {
          name: 'meta.preprocessor.macro-reference.verilog',
          match: `^([\\t ]*)(\`)(undef)[\\t ]+(${VERILOG_IDENTIFIER})${VERILOG_IDENTIFIER_END}`,
          captures: {
            2: { name: 'punctuation.definition.directive.verilog' },
            3: { name: 'keyword.control.directive.verilog' },
            4: { name: 'entity.name.function.preprocessor.verilog' },
          },
        },
      ],
    },
    compilerDirectives: {
      patterns: [
        {
          match: `(\`)(${directiveAlternation})${VERILOG_IDENTIFIER_END}`,
          captures: {
            1: { name: 'punctuation.definition.directive.verilog' },
            2: { name: 'keyword.control.directive.verilog' },
          },
        },
      ],
    },
    userMacros: {
      patterns: [
        {
          match: `(\`)(${VERILOG_IDENTIFIER})${VERILOG_IDENTIFIER_END}`,
          captures: {
            1: { name: 'punctuation.definition.directive.verilog' },
            2: { name: 'entity.name.function.preprocessor.verilog' },
          },
        },
      ],
    },
    numbers: {
      patterns: [
        {
          name: 'constant.numeric.verilog',
          match: "(?<![A-Za-z0-9_$])(?:[0-9][0-9_]*)?'[sS]?[bB][01xXzZ?_]+(?![A-Za-z0-9_$])",
        },
        {
          name: 'constant.numeric.verilog',
          match: "(?<![A-Za-z0-9_$])(?:[0-9][0-9_]*)?'[sS]?[oO][0-7xXzZ?_]+(?![A-Za-z0-9_$])",
        },
        {
          name: 'constant.numeric.verilog',
          match: "(?<![A-Za-z0-9_$])(?:[0-9][0-9_]*)?'[sS]?[dD][0-9xXzZ?_]+(?![A-Za-z0-9_$])",
        },
        {
          name: 'constant.numeric.verilog',
          match: "(?<![A-Za-z0-9_$])(?:[0-9][0-9_]*)?'[sS]?[hH][0-9a-fA-FxXzZ?_]+(?![A-Za-z0-9_$])",
        },
        {
          name: 'constant.numeric.verilog',
          match: "(?<![A-Za-z0-9_$])'[01xXzZ](?![A-Za-z0-9_$])",
        },
        {
          name: 'constant.numeric.verilog',
          match: '(?<![A-Za-z0-9_$])(?:(?:[0-9][0-9_]*\\.[0-9_]*|\\.[0-9][0-9_]*)(?:[eE][-+]?[0-9][0-9_]*)?|[0-9][0-9_]*[eE][-+]?[0-9][0-9_]*)(?![A-Za-z0-9_$])',
        },
        {
          name: 'constant.numeric.verilog',
          match: '(?<![A-Za-z0-9_$])[0-9][0-9_]*(?![A-Za-z0-9_$])',
        },
      ],
    },
    knownSystemTasks: {
      patterns: [
        {
          name: 'support.function.system-task.verilog',
          match: `\\$(?:${systemTaskAlternation})${VERILOG_IDENTIFIER_END}`,
        },
      ],
    },
    genericSystemTasks: {
      patterns: [
        {
          name: 'support.function.system-task.verilog',
          match: `\\$${VERILOG_IDENTIFIER}${VERILOG_IDENTIFIER_END}`,
        },
      ],
    },
    escapedIdentifiers: {
      patterns: [
        {
          name: 'variable.other.identifier.escaped.verilog',
          match: '\\\\[^\\s]+',
        },
      ],
    },
    namedBlocks: {
      patterns: [
        {
          name: 'meta.block.named.verilog',
          match: `${VERILOG_IDENTIFIER_START}(begin|fork)${VERILOG_IDENTIFIER_END}([\\t ]*)(:)([\\t ]*)(${VERILOG_IDENTIFIER}|\\\\[^\\s]+)`,
          captures: {
            1: { name: 'keyword.control.verilog' },
            3: { name: 'punctuation.separator.label.verilog' },
            5: { name: 'entity.name.label.verilog' },
          },
        },
      ],
    },
    keywords: {
      patterns: keywordPatterns,
    },
    operators: {
      patterns: [
        {
          name: 'keyword.operator.verilog',
          match: operatorAlternation,
        },
        {
          name: 'keyword.operator.event.verilog',
          match: '[@#]',
        },
      ],
    },
    punctuation: {
      patterns: [
        {
          name: 'punctuation.section.group.verilog',
          match: '[(){}\\[\\]]',
        },
        {
          name: 'punctuation.separator.verilog',
          match: '[,;.]',
        },
        {
          name: 'punctuation.definition.verilog',
          match: "['`]",
        },
      ],
    },
  };

  return generatedGrammar(
    'Verilog',
    'source.verilog',
    ['v', 'vh'],
    [
      { include: '#comments' },
      { include: '#formatCalls' },
      { include: '#strings' },
      { include: '#directiveDefinitions' },
      { include: '#directiveConditions' },
      { include: '#directiveMacroReferences' },
      { include: '#compilerDirectives' },
      { include: '#userMacros' },
      { include: '#numbers' },
      { include: '#knownSystemTasks' },
      { include: '#genericSystemTasks' },
      { include: '#escapedIdentifiers' },
      { include: '#namedBlocks' },
      { include: '#keywords' },
      { include: '#operators' },
      { include: '#punctuation' },
    ],
    repository,
    ['resources/verilog/keywords.json'],
  );
}

function buildSystemVerilogGrammar(keywordResource, systemVerilogResource) {
  // Validate the shared source here as well. The base grammar is included by
  // scope, so SystemVerilog inherits every resource-backed Verilog keyword.
  Object.values(keywordResource.keywordGroups).forEach((values) =>
    assertStringArray(values, 'Verilog keyword group'),
  );
  if (!systemVerilogResource?.keywordGroups || typeof systemVerilogResource.keywordGroups !== 'object') {
    throw new Error('resources/verilog/systemverilog.json must define keywordGroups');
  }
  const keywordGroups = Object.entries(systemVerilogResource.keywordGroups);
  for (const [group, words] of keywordGroups) {
    if (!Object.hasOwn(SYSTEMVERILOG_KEYWORD_SCOPES, group)) {
      throw new Error(`No TextMate scope is defined for SystemVerilog keyword group ${JSON.stringify(group)}`);
    }
    assertStringArray(words, `SystemVerilog keyword group ${group}`);
  }
  const systemVerilogOperators = unique(
    assertStringArray(systemVerilogResource.operators, 'SystemVerilog operators'),
    'SystemVerilog operators',
  );
  const repository = {
    systemVerilogKeywords: {
      patterns: keywordGroups.map(([group, words]) => {
        const selectedWords = unique(words, `SystemVerilog ${group} keywords`);
        return {
          name: SYSTEMVERILOG_KEYWORD_SCOPES[group],
          match: `${VERILOG_IDENTIFIER_START}(?:${regexAlternation(selectedWords)})${VERILOG_IDENTIFIER_END}`,
        };
      }),
    },
    systemVerilogOperators: {
      patterns: [
        {
          name: 'keyword.operator.systemverilog',
          match: regexAlternation(systemVerilogOperators),
        },
      ],
    },
  };

  return generatedGrammar(
    'SystemVerilog',
    'source.systemverilog.co',
    ['sv', 'svh'],
    [
      // Ordering is intentional: identical matches are resolved in favour of
      // these SystemVerilog scopes before falling back to source.verilog.
      { include: '#systemVerilogKeywords' },
      { include: '#systemVerilogOperators' },
      { include: 'source.verilog' },
    ],
    repository,
    [
      'resources/verilog/keywords.json',
      'resources/verilog/systemverilog.json',
      'syntaxes/verilog.tmLanguage.json',
    ],
  );
}

async function buildOutputs() {
  const [
    mipsInstructions,
    mipsDirectives,
    mipsRegisters,
    verilogKeywords,
    systemVerilogKeywords,
  ] = await Promise.all([
    readJson(inputPaths.mipsInstructions),
    readJson(inputPaths.mipsDirectives),
    readJson(inputPaths.mipsRegisters),
    readJson(inputPaths.verilogKeywords),
    readJson(inputPaths.systemVerilogKeywords),
  ]);

  return new Map([
    [outputPaths.mips, buildMipsGrammar(mipsInstructions, mipsDirectives, mipsRegisters)],
    [outputPaths.verilog, buildVerilogGrammar(verilogKeywords)],
    [
      outputPaths.systemVerilog,
      buildSystemVerilogGrammar(verilogKeywords, systemVerilogKeywords),
    ],
  ]);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputs = await buildOutputs();
  const staleFiles = [];

  for (const [filePath, grammar] of outputs) {
    const content = `${JSON.stringify(grammar, null, 2)}\n`;
    if (options.check) {
      let existing = '';
      try {
        existing = await readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
      if (existing !== content) {
        staleFiles.push(path.relative(projectRoot, filePath));
      }
      continue;
    }
    await writeFile(filePath, content, 'utf8');
    console.log(`generated ${path.relative(projectRoot, filePath)}`);
  }

  if (staleFiles.length > 0) {
    throw new Error(
      `Generated syntax grammar is stale: ${staleFiles.join(', ')}. Run node scripts/generate-syntaxes.mjs.`,
    );
  }
}

await main();

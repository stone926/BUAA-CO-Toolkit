import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const packagePath = path.join(root, 'package.json');
const configManifestPath = path.join(root, 'resources', 'co', 'configManifest.json');
const configDefaultsPath = path.join(root, 'resources', 'co', 'configDefaults.json');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const initManifest = args.has('--init');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Generated files are written with LF; a CRLF checkout must still compare equal. */
function normalizeToLf(text) {
  return text.replace(/\r\n/g, '\n');
}

function writeJsonIfChanged(filePath, value) {
  const next = stableJson(value);
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (normalizeToLf(previous) === normalizeToLf(next)) {
    return false;
  }
  if (checkOnly) {
    throw new Error(`${path.relative(root, filePath)} is not generated from current resources.`);
  }
  fs.writeFileSync(filePath, next);
  return true;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).padStart(width, '0')}`;
}

function shortHex(value) {
  return `0x${(value >>> 0).toString(16)}`;
}

function stripPackageDefaults(configurationGroups) {
  const groups = clone(configurationGroups);
  for (const group of groups) {
    for (const property of Object.values(group.properties ?? {})) {
      delete property.default;
    }
  }
  return groups;
}

function propertyMap(groups) {
  const properties = {};
  for (const group of groups) {
    for (const [key, property] of Object.entries(group.properties ?? {})) {
      properties[key] = property;
    }
  }
  return properties;
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function deriveP7Values(p7Hardware) {
  const memory = p7Hardware.memoryLayout;
  const userSlots = (memory.exceptionHandlerAddress - memory.userTextBaseAddress) / 4;
  const instructionCountMaximum = userSlots - memory.mainTerminatorInstructionCount;
  const kernelDumpEndAddress = memory.userTextBaseAddress + memory.instructionMemoryWords * 4 - 4;
  return {
    exceptionHandlerAddress: memory.exceptionHandlerAddress,
    instructionCountMaximum,
    kernelDumpEndAddress,
    kernelDumpRange: `${hex(memory.exceptionHandlerAddress)}-${hex(kernelDumpEndAddress)}`
  };
}

function generatorInstructionDescription() {
  return '自动测试重点覆盖的真实指令。用逗号或空白分隔；留空时覆盖当前 Profile 的完整课程指令集。测试规模、中断、异常、外设和持续测试策略由插件自动使用最强安全配置。';
}

function generatorInstructionMarkdownDescription(generatorProfiles) {
  const profiles = generatorProfiles.profiles;
  const defaultProfiles = Object.keys(profiles)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((profile) => `- **${profile}**: \`${profiles[profile].join(', ')}\``)
    .join('\n');
  return [
    '自动测试重点覆盖的真实指令。测试脚手架所需指令由插件内部管理，不需要手工加入。',
    '',
    '- 用逗号或任意数量空白分隔。',
    '- 只接受真实指令，不接受伪指令。',
    '- 留空时使用当前 Profile 的默认指令集。',
    '',
    '各 Profile 默认指令集：',
    defaultProfiles
  ].join('\n');
}

function deriveConfigDefaults(baseDefaults, resources) {
  const defaults = clone(baseDefaults);
  const { lintRules } = resources;
  defaults['project.profile'] = defaults['project.profile'] ?? 'auto';
  defaults['verilog.lint.disabledRules'] = lintRules
    .filter((rule) => rule.configurable && !rule.enabledByDefault)
    .map((rule) => rule.id);
  return sortedObject(defaults);
}

function applyGeneratedSchema(groups, defaults, resources) {
  const generated = clone(groups);
  const properties = propertyMap(generated);
  const defaultsByPackageKey = Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [`co.${key}`, value])
  );

  for (const [key, value] of Object.entries(defaultsByPackageKey)) {
    if (!properties[key]) {
      throw new Error(`configDefaults.json contains co.${key.replace(/^co\./, '')}, but configManifest.json has no ${key}.`);
    }
    properties[key].default = value;
  }
  for (const key of Object.keys(properties)) {
    if (!(key in defaultsByPackageKey)) {
      throw new Error(`configManifest.json contains ${key}, but configDefaults.json has no ${key.replace(/^co\./, '')}.`);
    }
  }

  const { courseConfig, generatorProfiles, lintRules, p7Values } = resources;
  const profileIds = Object.keys(courseConfig.profiles);
  properties['co.project.profile'].enum = ['auto', ...profileIds];
  properties['co.project.profile'].enumDescriptions = [
    '根据当前工作区内容自动推断 Profile',
    ...profileIds.map((profile) => courseConfig.profiles[profile]?.name ?? profile)
  ];

  properties['co.toolchain.marsP7'].description =
    `P7 专用 Mars jar 路径，仅在显式选择 mars 或 verify-both 引擎时使用。mars 作为用户配置的 legacy 回滚；verify-both/固定验证要求受信任的 v0.6.3-course1 版本。内存配置使用 CompactLargeText（课程异常入口 ${shortHex(p7Values.exceptionHandlerAddress)}）；未配置时回退到 co.toolchain.mars`;
  properties['co.mips.memoryConfiguration'].description =
    `MARS 内存模式。auto 在 P3-P6 使用 FixedCompactLargeText 以支持更长机器码，在 P7 使用 CompactLargeText（课程异常入口 ${shortHex(p7Values.exceptionHandlerAddress)}）`;
  properties['co.test.instructions'].description = generatorInstructionDescription();
  properties['co.test.instructions'].markdownDescription =
    generatorInstructionMarkdownDescription(generatorProfiles);

  const configurableLintIds = lintRules
    .filter((rule) => rule.configurable)
    .map((rule) => rule.id);
  properties['co.verilog.lint.disabledRules'].items.enum = configurableLintIds;
  properties['co.verilog.lint.disabledRules'].description =
    '需要禁用的 Verilog Lint。格式化会处理间距和缩进';

  return generated;
}

function main() {
  const pkg = readJson(packagePath);
  if (initManifest) {
    if (!pkg.contributes?.configuration) {
      throw new Error('package.json has no contributes.configuration to bootstrap.');
    }
    writeJsonIfChanged(configManifestPath, stripPackageDefaults(pkg.contributes.configuration));
  }
  if (!fs.existsSync(configManifestPath)) {
    throw new Error('Missing resources/co/configManifest.json. Run with --init once to bootstrap it from package.json.');
  }

  const baseDefaults = readJson(configDefaultsPath);
  const p7Hardware = readJson(path.join(root, 'resources', 'co', 'p7Hardware.json'));
  const courseConfig = readJson(path.join(root, 'resources', 'co', 'courseConfig.json'));
  const generatorProfiles = readJson(path.join(root, 'resources', 'mips', 'generatorProfiles.json'));
  const lintRules = readJson(path.join(root, 'resources', 'verilog', 'lintRules.json'));
  const p7Values = deriveP7Values(p7Hardware);
  const resources = { courseConfig, generatorProfiles, lintRules, p7Hardware, p7Values };

  const nextDefaults = deriveConfigDefaults(baseDefaults, resources);
  writeJsonIfChanged(configDefaultsPath, nextDefaults);

  const configManifest = readJson(configManifestPath);
  pkg.contributes.configuration = applyGeneratedSchema(configManifest, nextDefaults, resources);
  writeJsonIfChanged(packagePath, pkg);

  if (!checkOnly) {
    console.log('Generated package.json contributes.configuration and resources/co/configDefaults.json.');
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

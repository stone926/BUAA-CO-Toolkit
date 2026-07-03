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

function writeJsonIfChanged(filePath, value) {
  const next = stableJson(value);
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (previous === next) {
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
  const kernelDumpEndAddress = memory.instructionMemoryWords * 4 - 4;
  return {
    exceptionHandlerAddress: memory.exceptionHandlerAddress,
    instructionCountMaximum,
    kernelDumpEndAddress,
    kernelDumpRange: `${hex(memory.exceptionHandlerAddress)}-${hex(kernelDumpEndAddress)}`
  };
}

function exceptionTypeLabels(exceptionCodes) {
  const labels = {
    adel: 'AdEL',
    ades: 'AdES',
    syscall: 'Syscall',
    ri: 'RI',
    ov: 'Ov'
  };
  return Object.keys(exceptionCodes)
    .map((key) => labels[key] ?? key)
    .filter(Boolean);
}

function generatorInstructionDescription() {
  return '自定义内置 ASM 生成器使用的指令集。用逗号或空白分隔；留空时按当前 Profile 使用默认指令集。';
}

function generatorInstructionMarkdownDescription(generatorProfiles) {
  const profiles = generatorProfiles.profiles;
  const defaultProfiles = Object.keys(profiles)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((profile) => `- **${profile}**: \`${profiles[profile].join(', ')}\``)
    .join('\n');
  return [
    '自定义内置 ASM 生成器使用的指令集。',
    '',
    '- 用逗号或任意数量空白分隔。',
    '- 只接受真实指令，不接受伪指令。',
    '- 留空时使用当前 Profile 的默认指令集。',
    '',
    '默认指令集（由 `resources/mips/generatorProfiles.json` 生成）：',
    defaultProfiles
  ].join('\n');
}

function deriveConfigDefaults(baseDefaults, resources) {
  const defaults = clone(baseDefaults);
  const { courseConfig, lintRules, p7Hardware, p7Values } = resources;
  defaults['project.profile'] = defaults['project.profile'] ?? 'auto';
  defaults['test.builtinGenerator.p7InstructionCount'] = p7Values.instructionCountMaximum;
  defaults['test.p7.probeScenarioCount'] = p7Hardware.probe.defaultScenarioCount;
  defaults['test.p7.exceptionTypes'] = exceptionTypeLabels(p7Hardware.cp0.exceptionCodes);
  defaults['test.logisim.mainCircuit'] =
    courseConfig.logisimTrace?.P3?.defaultCircuit ?? defaults['test.logisim.mainCircuit'];
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

  const { courseConfig, generatorProfiles, lintRules, p7Hardware, p7Values } = resources;
  const profileIds = Object.keys(courseConfig.profiles);
  properties['co.project.profile'].enum = ['auto', ...profileIds];
  properties['co.project.profile'].enumDescriptions = [
    '根据当前工作区内容自动推断 Profile',
    ...profileIds.map((profile) => courseConfig.profiles[profile]?.name ?? profile)
  ];

  const p7InstructionCount = properties['co.test.builtinGenerator.p7InstructionCount'];
  p7InstructionCount.minimum = 1;
  p7InstructionCount.maximum = p7Values.instructionCountMaximum;
  p7InstructionCount.description =
    `P7 内置 ASM 生成器为每个 ASM 文件生成的主程序指令数。课程异常入口由 resources/co/p7Hardware.json 派生为 ${shortHex(p7Values.exceptionHandlerAddress)}，因此最大为 ${p7Values.instructionCountMaximum} 条，以保留停机自环并避免覆盖处理程序`;

  properties['co.toolchain.marsP7'].description =
    `P7 专用 Mars jar 路径。P7 自动对拍需要支持 efc / p7irq / coL1 的修改版 Mars（如 Toby-Shi-cloud/Mars-with-BUAA-CO-extension），内存配置使用 CompactLargeText（课程异常入口由 resources/co/p7Hardware.json 派生为 ${shortHex(p7Values.exceptionHandlerAddress)}）。未配置时回退到 co.toolchain.mars`;
  properties['co.mips.memoryConfiguration'].description =
    `MARS 内存模式。auto 在 P3-P6 使用 FixedCompactLargeText 以支持更长机器码，在 P7 使用 CompactLargeText（课程异常入口由 resources/co/p7Hardware.json 派生为 ${shortHex(p7Values.exceptionHandlerAddress)}）`;
  properties['co.test.builtinGenerator.instructions'].description = generatorInstructionDescription();
  properties['co.test.builtinGenerator.instructions'].markdownDescription =
    generatorInstructionMarkdownDescription(generatorProfiles);

  const probeScenario = properties['co.test.p7.probeScenarioCount'];
  probeScenario.minimum = 1;
  probeScenario.maximum = p7Hardware.probe.maxScenarioCount;
  probeScenario.description =
    `P7 probe 模式每个 ASM 生成的场景数量，最多 ${p7Hardware.probe.maxScenarioCount} 条以保持 probe log 在 DM 范围内`;

  properties['co.test.p7.exceptionTypes'].items.enum = defaults['test.p7.exceptionTypes'];

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

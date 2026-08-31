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

  for (const [key, property] of Object.entries(properties)) {
    // Deprecated compatibility settings intentionally have no contributed
    // default. VS Code then keeps them out of the normal Settings UI while
    // still recognizing values already present in older workspaces.
    if (property.deprecationMessage) {
      delete property.default;
      continue;
    }
    const defaultKey = key.replace(/^co\./, '');
    if (!Object.prototype.hasOwnProperty.call(defaults, defaultKey)) {
      throw new Error(`Public setting ${key} has no internal default in configDefaults.json.`);
    }
    // A schema may intentionally provide a UI sentinel (for example an empty
    // project override whose effective value comes from the selected Profile).
    if (!Object.prototype.hasOwnProperty.call(property, 'default')) {
      property.default = clone(defaults[defaultKey]);
    }
  }

  const { courseConfig, generatorProfiles } = resources;
  const profileIds = Object.keys(courseConfig.profiles);
  properties['co.project.profile'].enum = ['auto', ...profileIds];
  properties['co.project.profile'].enumDescriptions = [
    '根据当前工作区内容自动推断 Profile',
    ...profileIds.map((profile) => courseConfig.profiles[profile]?.name ?? profile)
  ];

  properties['co.test.instructions'].description = generatorInstructionDescription();
  properties['co.test.instructions'].markdownDescription =
    generatorInstructionMarkdownDescription(generatorProfiles);

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
  const courseConfig = readJson(path.join(root, 'resources', 'co', 'courseConfig.json'));
  const generatorProfiles = readJson(path.join(root, 'resources', 'mips', 'generatorProfiles.json'));
  const lintRules = readJson(path.join(root, 'resources', 'verilog', 'lintRules.json'));
  const resources = { courseConfig, generatorProfiles, lintRules };

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

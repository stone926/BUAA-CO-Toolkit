import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const check = process.argv.includes('--check');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'resources/co/languages.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ids = new Set();
const keys = new Set();
const extensions = new Set();
for (const language of catalog) {
  if (!/^[a-z][\w-]*$/.test(language.id) || !/^[a-z]\w*$/.test(language.key)
    || ids.has(language.id) || keys.has(language.key)) {
    throw new Error(`Invalid or duplicate language: ${language.id}`);
  }
  ids.add(language.id);
  keys.add(language.key);
  if (!language.extensions?.length) throw new Error(`Missing extensions: ${language.id}`);
  for (const extension of language.extensions) {
    if (!/^\.[a-z]+$/.test(extension) || extensions.has(extension)) {
      throw new Error(`Invalid or duplicate extension: ${extension}`);
    }
    extensions.add(extension);
  }
  if (language.lsp && !['language', 'extension'].includes(language.lsp.selector)) {
    throw new Error(`Invalid LSP selector: ${language.id}`);
  }
  for (const asset of [language.configuration, language.grammar?.path, language.snippets].filter(Boolean)) {
    if (!fs.existsSync(path.join(root, asset))) throw new Error(`Missing language asset: ${asset}`);
  }
}

const languageIds = Object.fromEntries(catalog.map(({ key, id }) => [key, id]));
const services = catalog.filter((language) => language.lsp);
const previousLanguageIds = (pkg.contributes.languages ?? []).map(({ id }) => id);
pkg.contributes.languages = catalog.filter((language) => language.aliases).map(({ id, aliases, extensions, configuration }) => ({
  id, aliases, extensions, configuration
}));
pkg.contributes.grammars = catalog.filter((language) => language.grammar).map(({ id, grammar }) => ({ language: id, ...grammar }));
pkg.contributes.snippets = catalog.filter((language) => language.snippets).map(({ id, snippets }) => ({ language: id, path: snippets }));
// Own extension-based activation only; retain command/view and other workspace triggers.
pkg.activationEvents = [
  ...(pkg.activationEvents ?? []).filter((event) => !/^workspaceContains:\*\*\/\*\.[a-z]+$/.test(event)),
  ...services.filter(({ lsp }) => lsp.selector === 'extension')
    .flatMap(({ extensions }) => extensions.map((extension) => `workspaceContains:**/*${extension}`))
];
const defaults = pkg.contributes.configurationDefaults ?? {};
for (const id of new Set([...previousLanguageIds, ...ids])) {
  const scoped = defaults[`[${id}]`];
  if (!scoped) continue;
  delete scoped['editor.semanticHighlighting.enabled'];
  if (!Object.keys(scoped).length) delete defaults[`[${id}]`];
}
for (const { id } of services.filter(({ lsp }) => lsp.semanticHighlighting)) {
  defaults[`[${id}]`] = { ...defaults[`[${id}]`], 'editor.semanticHighlighting.enabled': true };
}
pkg.contributes.configurationDefaults = defaults;

write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
write('src/language/generated/languages.ts', [
  '// @index language-catalog — Generated from resources/co/languages.json; do not edit.',
  `export const languageIds = ${JSON.stringify(languageIds, null, 2)} as const;`,
  `export const languageCatalog = ${JSON.stringify(catalog, null, 2)} as const;`,
  `export const languageServiceIds = ${JSON.stringify(services.map(({ id }) => id))} as const;`,
  'export type LanguageServiceId = typeof languageServiceIds[number];',
  ''
].join('\n'));

function write(relative, content) {
  const file = path.join(root, relative);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  if (previous === content) return;
  if (check) throw new Error(`${relative} is not generated from resources/co/languages.json.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

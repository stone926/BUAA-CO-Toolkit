import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { languageDocumentSelector, languageFileGlob, languageIds, languageServiceForDocument, isLanguageFileName } from '../language/languageRegistry';

const root = process.cwd();
const read = (name: string, cwd = root): any => JSON.parse(fs.readFileSync(path.join(cwd, name), 'utf8'));

describe('language registration source', () => {
  it('keeps package and runtime registration generated from the language catalog', () => {
    execFileSync(process.execPath, ['scripts/generate-languages.mjs', '--check'], { cwd: root, stdio: 'pipe' });
    const pkg = read('package.json');
    const selectors = languageDocumentSelector();
    for (const language of pkg.contributes.languages) {
      expect(selectors.some((selector) => selector.language === language.id)).toBe(language.id !== 'systemverilog');
    }
    expect(languageDocumentSelector(true).map((selector) => selector.language)).toEqual(['mipsasm', 'verilog']);
    expect(selectors).toContainEqual({ scheme: 'file', pattern: '**/*.circ' });
  });

  it('preserves extension-based circuit routing and excludes syntax-only SystemVerilog', () => {
    expect(languageServiceForDocument({ languageId: 'xml', uri: 'file:///C:/课程%20设计/CPU.CIRC?revision=1' })).toBe(languageIds.logisim);
    expect(languageServiceForDocument({ languageId: 'systemverilog', uri: 'file:///cpu.sv' })).toBeUndefined();
    expect(languageServiceForDocument({ languageId: 'xml', uri: 'file:///cpu.circ.xml' })).toBeUndefined();
    expect(isLanguageFileName('C:\\课程\\CPU.VH', languageIds.verilog)).toBe(true);
    expect(isLanguageFileName('CPU.svh', languageIds.verilog)).toBe(false);
    expect(languageFileGlob([languageIds.mips, languageIds.logisim])).toBe('**/*.{asm,s,mips,circ}');
  });
});

describe('configuration source', () => {
  function withFixture(action: (cwd: string) => void): void {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'co-config-source-'));
    try {
      for (const file of ['package.json', 'resources/co/configManifest.json', 'resources/co/configDefaults.json',
        'resources/co/courseConfig.json', 'resources/mips/generatorProfiles.json']) {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        fs.copyFileSync(path.join(root, file), path.join(cwd, file));
      }
      action(cwd);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
  function generate(cwd: string, check = false): void {
    execFileSync(process.execPath, [path.join(root, 'scripts/generate-manifest-config.mjs'), ...(check ? ['--check'] : [])], { cwd, stdio: 'pipe' });
  }

  it('rebuilds runtime defaults from schema and detects drift before generation', () => {
    withFixture((cwd) => {
      const manifest = read('resources/co/configManifest.json', cwd);
      manifest.find((group: any) => group.properties['co.run.revealOutput']).properties['co.run.revealOutput'].runtimeDefault = true;
      fs.writeFileSync(path.join(cwd, 'resources/co/configManifest.json'), JSON.stringify(manifest));
      expect(() => generate(cwd, true)).toThrow();
      generate(cwd);
      expect(read('resources/co/configDefaults.json', cwd)['run.revealOutput']).toBe(true);
      const groups = read('package.json', cwd).contributes.configuration;
      const properties: any = Object.assign({}, ...groups.map((group: any) => group.properties));
      expect(properties['co.run.revealOutput'].default).toBe(true);
      expect(properties['co.mips.engine']).not.toHaveProperty('default');
      expect(properties['co.project.topModule'].default).toBe('');
      expect(read('resources/co/configDefaults.json', cwd)['project.topModule']).toBe('mips');
      for (const property of Object.values(properties)) {
        expect(property).not.toHaveProperty('runtimeDefault');
        expect(property).not.toHaveProperty('defaultFrom');
      }
      generate(cwd, true);
    });
  });

  it('rejects duplicate settings and ambiguous default owners', () => {
    withFixture((cwd) => {
      const file = path.join(cwd, 'resources/co/configManifest.json');
      const manifest = read('resources/co/configManifest.json', cwd);
      manifest.push(manifest[0]);
      fs.writeFileSync(file, JSON.stringify(manifest));
      expect(() => generate(cwd)).toThrow(/duplicate setting/);
      manifest.pop();
      manifest[0].properties['co.project.profile'].defaultFrom = 'unknownSource';
      fs.writeFileSync(file, JSON.stringify(manifest));
      expect(() => generate(cwd)).toThrow(/exactly one/);
    });
  });
});

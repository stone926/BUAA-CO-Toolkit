import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string }>;
    grammars?: Array<{ language: string; scopeName?: string; path?: string }>;
    languages?: Array<{ id: string; extensions?: string[]; configuration?: string }>;
    views?: Record<string, Array<{ id: string }>>;
  };
}

function readPackage(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
}

describe('package manifest', () => {
  it('activates every contributed command from a cold start', () => {
    const pkg = readPackage();
    const activationEvents = new Set(pkg.activationEvents ?? []);
    for (const command of pkg.contributes?.commands ?? []) {
      expect(activationEvents.has(`onCommand:${command.command}`), command.command).toBe(true);
    }
  });

  it('activates when the BUAA CO sidebar is opened', () => {
    const pkg = readPackage();
    const activationEvents = new Set(pkg.activationEvents ?? []);
    const viewIds = Object.values(pkg.contributes?.views ?? {}).flat().map((view) => view.id);
    expect(viewIds).toContain('coSidebar');
    expect(activationEvents.has('onView:coSidebar')).toBe(true);
  });

  it('does not provide XML editor support for Logisim .circ files', () => {
    const pkg = readPackage();
    const logisimLanguage = (pkg.contributes?.languages ?? []).find((language) =>
      language.id === 'logisim-circ' || language.extensions?.includes('.circ')
    );
    const logisimGrammar = (pkg.contributes?.grammars ?? []).find((grammar) =>
      grammar.language === 'logisim-circ' || grammar.scopeName === 'text.xml.logisim'
    );

    expect(logisimLanguage).toBeUndefined();
    expect(logisimGrammar).toBeUndefined();
  });
});

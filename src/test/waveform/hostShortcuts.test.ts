import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Commands, WAVEFORM_VIEW_TYPE } from '../../constants';
import { isWaveformShortcut, WaveformShortcut, waveformShortcuts } from '../../waveform/model/protocol';
import { hostShortcutForChord, KeyChord } from '../../waveform/view/hostShortcuts';

interface Keybinding {
  readonly command: string;
  readonly key: string;
  readonly mac?: string;
  readonly when?: string;
}

/** A keydown for a VS Code key string such as `ctrl+g` or `f1`. */
function chord(binding: string): KeyChord {
  const parts = binding.split('+');
  const key = parts[parts.length - 1];
  return {
    key: key.length === 1 ? key : key.toUpperCase(),
    ctrlKey: parts.includes('ctrl'),
    metaKey: parts.includes('cmd'),
    shiftKey: parts.includes('shift'),
    altKey: parts.includes('alt')
  };
}

function waveformKeybindings(): Keybinding[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    contributes?: { keybindings?: Keybinding[] };
  };
  return (pkg.contributes?.keybindings ?? []).filter((binding) => binding.command.startsWith('co.waveform.'));
}

const commandForShortcut: Record<WaveformShortcut, string> = {
  goToTime: Commands.Waveform.GoToTime,
  showHelp: Commands.Waveform.ShowHelp,
  selectAllRows: Commands.Waveform.SelectAllRows
};

describe('waveform shortcuts VS Code binds itself', () => {
  it('recognises the chords the page must leave to the workbench', () => {
    expect(hostShortcutForChord(chord('ctrl+g'), false)).toBe('goToTime');
    expect(hostShortcutForChord(chord('cmd+g'), true)).toBe('goToTime');
    expect(hostShortcutForChord({ ...chord('ctrl+a'), key: 'A' }, false)).toBe('selectAllRows');
    expect(hostShortcutForChord(chord('f1'), false)).toBe('showHelp');
    expect(hostShortcutForChord(chord('f1'), true)).toBe('showHelp');

    // Page-local shortcuts stay in the webview.
    for (const local of ['g', 'a', 'ctrl+f', 'ctrl+shift+g', 'alt+ctrl+a', 'ctrl+f1', '?', 'f', 'm']) {
      expect(hostShortcutForChord(chord(local), false), local).toBeUndefined();
    }
    // Only the platform's primary modifier counts: VS Code binds Cmd on macOS, Ctrl elsewhere.
    expect(hostShortcutForChord(chord('ctrl+g'), true)).toBeUndefined();
    expect(hostShortcutForChord(chord('cmd+g'), false)).toBeUndefined();
  });

  it('validates shortcut messages', () => {
    expect(waveformShortcuts.every(isWaveformShortcut)).toBe(true);
    expect(isWaveformShortcut('removeSelected')).toBe(false);
    expect(isWaveformShortcut(undefined)).toBe(false);
  });

  it('contributes a waveform-scoped keybinding for exactly the chords the page defers', () => {
    const bindings = waveformKeybindings();
    expect(bindings.map((binding) => binding.command).sort())
      .toEqual(waveformShortcuts.map((shortcut) => commandForShortcut[shortcut]).sort());
    for (const binding of bindings) {
      // Scoped to the viewer, and not while a workbench input (Quick Open, find, …) has focus.
      expect(binding.when, binding.command).toContain(`activeCustomEditorId == '${WAVEFORM_VIEW_TYPE}'`);
      expect(binding.when, binding.command).toContain('!inputFocus');
      const platformKeys: Array<[string, boolean]> = [[binding.key, false], [binding.mac ?? binding.key, true]];
      for (const [key, mac] of platformKeys) {
        const shortcut = hostShortcutForChord(chord(key), mac);
        expect(shortcut && commandForShortcut[shortcut], key).toBe(binding.command);
      }
    }
  });
});

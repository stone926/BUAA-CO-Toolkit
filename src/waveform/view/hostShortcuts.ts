// @index waveform-host-shortcuts — VS Code 自身占用的组合键（Ctrl+G/F1/Ctrl+A）与波形快捷键命令的对应关系

import type { WaveformShortcut } from '../model/protocol';

/** The modifier/key facets of a keydown that shortcut matching needs. */
export interface KeyChord {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * The waveform shortcut whose chord VS Code binds itself (go to line, Command Palette,
 * select all), or undefined. The webview host forwards every keydown to the workbench
 * whatever the page does with it, so these chords are package.json keybindings scoped to
 * the waveform editor, and the page must not run them from its own keydown handler.
 * Keep this in sync with contributes.keybindings: the primary modifier is Cmd on macOS
 * (`mac` bindings) and Ctrl elsewhere, so e.g. Ctrl+G on a Mac stays with the workbench.
 */
export function hostShortcutForChord(chord: KeyChord, mac: boolean): WaveformShortcut | undefined {
  if (chord.altKey || chord.shiftKey) {
    return undefined;
  }
  const control = mac ? chord.metaKey : chord.ctrlKey;
  if (mac ? chord.ctrlKey : chord.metaKey) {
    return undefined;
  }
  if (chord.key === 'F1') {
    return control ? undefined : 'showHelp';
  }
  if (!control) {
    return undefined;
  }
  switch (chord.key.toLowerCase()) {
    case 'g':
      return 'goToTime';
    case 'a':
      return 'selectAllRows';
    default:
      return undefined;
  }
}

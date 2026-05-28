import {
  InlayHint,
  InlayHintKind,
  Position,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  cp0ByOperand,
  cp0Markdown,
  instructionWritesV0,
  markdownTooltip,
  syscallByOperand,
  syscallMarkdown
} from './display';
import { MipsSyscallInfo } from './resources';
import { MipsServerState } from './state';
import { stripLineComment } from './text';

export function getMipsInlayHints(document: TextDocument, range: Range, settings: CoSettings, state: MipsServerState): InlayHint[] {
  const hints: InlayHint[] = [];
  const startLine = Math.max(0, range.start.line);
  const endLine = Math.min(document.lineCount - 1, range.end.line);
  const serviceStack: Array<MipsSyscallInfo | undefined> = [];
  let currentSyscall: MipsSyscallInfo | undefined;

  for (let lineNumber = 0; lineNumber <= endLine; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    const code = stripLineComment(text);
    const trimmed = code.trim();
    const inRequestedRange = lineNumber >= startLine;

    if (/^\.macro\b/.test(trimmed)) {
      serviceStack.push(currentSyscall);
      currentSyscall = undefined;
      continue;
    }

    if (/^\.end_macro\b/.test(trimmed)) {
      currentSyscall = serviceStack.pop();
      continue;
    }

    const syscallLoad = code.match(/\bli\s+\$v0\s*,\s*(\S+)/);
    if (syscallLoad) {
      const syscall = syscallByOperand(syscallLoad[1]);
      if (syscall) {
        const start = code.indexOf(syscallLoad[1]);
        if (inRequestedRange) {
          hints.push({
            position: Position.create(lineNumber, start + syscallLoad[1].length),
            label: ` ${syscall.name}`,
            kind: InlayHintKind.Parameter,
            tooltip: markdownTooltip(syscallMarkdown(syscall)),
            paddingLeft: true
          });
        }
        currentSyscall = syscall;
      }
    } else if (instructionWritesV0(code)) {
      currentSyscall = undefined;
    }

    const syscallInstruction = code.match(/^\s*syscall\b/);
    if (syscallInstruction) {
      if (currentSyscall && inRequestedRange) {
        hints.push({
          position: Position.create(lineNumber, syscallInstruction[0].length),
          label: ` ${currentSyscall.name}`,
          kind: InlayHintKind.Parameter,
          tooltip: markdownTooltip(syscallMarkdown(currentSyscall)),
          paddingLeft: true
        });
      }
      currentSyscall = undefined;
    }

    const cp0Access = code.match(/\b(?:mfc0|mtc0)\s+\$[A-Za-z0-9_]+\s*,\s*(\$?\d+)\b/);
    if (cp0Access && inRequestedRange) {
      const register = cp0ByOperand(cp0Access[1]);
      if (register) {
        const start = code.indexOf(cp0Access[1]);
        hints.push({
          position: Position.create(lineNumber, start + cp0Access[1].length),
          label: ` ${register.name}${register.alias ? `/${register.alias}` : ''}`,
          kind: InlayHintKind.Type,
          tooltip: markdownTooltip(cp0Markdown(register)),
          paddingLeft: true
        });
      }
    }
  }
  return hints;
}

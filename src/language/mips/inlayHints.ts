import {
  InlayHint,
  InlayHintKind,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import {
  cp0ByOperand,
  cp0Markdown,
  markdownTooltip,
  syscallByOperand,
  syscallMarkdown
} from './display';
import { instructionWritesRegister } from './instructionValidation';
import { getCachedMipsParse } from './parseCache';
import { MipsSyscallInfo } from './resources';
import { MipsServerState } from './state';

export function getMipsInlayHints(document: TextDocument, range: Range, settings: CoSettings, state: MipsServerState): InlayHint[] {
  const parsed = getCachedMipsParse(document, settings, state);
  const hints: InlayHint[] = [];
  const startLine = Math.max(0, range.start.line);
  const endLine = Math.min(document.lineCount - 1, range.end.line);
  const serviceStack: Array<MipsSyscallInfo | undefined> = [];
  let currentSyscall: MipsSyscallInfo | undefined;

  for (const statement of parsed.ast.statements) {
    if (statement.line > endLine) {
      break;
    }
    const executable = statement.executable;
    if (!executable) {
      continue;
    }
    const lineNumber = statement.line;
    const inRequestedRange = lineNumber >= startLine;

    if (executable.lowerMnemonic === '.macro') {
      serviceStack.push(currentSyscall);
      currentSyscall = undefined;
      continue;
    }

    if (executable.lowerMnemonic === '.end_macro') {
      currentSyscall = serviceStack.pop();
      continue;
    }

    if (executable.lowerMnemonic === 'li' && executable.operands[0]?.text === '$v0' && executable.operands[1]) {
      const operand = executable.operands[1];
      const syscall = syscallByOperand(operand.text);
      if (syscall) {
        if (inRequestedRange) {
          hints.push({
            position: operand.range.end,
            label: ` ${syscall.name}`,
            kind: InlayHintKind.Parameter,
            tooltip: markdownTooltip(syscallMarkdown(syscall)),
            paddingLeft: true
          });
        }
        currentSyscall = syscall;
      }
    } else if (instructionWritesRegister(executable.lowerMnemonic, executable.operands, '$v0')) {
      currentSyscall = undefined;
    }

    if (executable.lowerMnemonic === 'syscall') {
      if (currentSyscall && inRequestedRange) {
        hints.push({
          position: executable.range.end,
          label: ` ${currentSyscall.name}`,
          kind: InlayHintKind.Parameter,
          tooltip: markdownTooltip(syscallMarkdown(currentSyscall)),
          paddingLeft: true
        });
      }
      currentSyscall = undefined;
    }

    if ((executable.lowerMnemonic === 'mfc0' || executable.lowerMnemonic === 'mtc0') && executable.operands[1] && inRequestedRange) {
      const operand = executable.operands[1];
      const register = cp0ByOperand(operand.text);
      if (register) {
        hints.push({
          position: operand.range.end,
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

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
  syscallMarkdown,
  p7SyscallMarkdown
} from './display';
import { instructionWritesRegister } from './instructionValidation';
import { getCachedMipsParse } from './parseCache';
import { MipsSyscallInfo, canonicalRegister } from './resources';
import { MipsServerState } from './state';
import { isCourseProjectProfile } from '../../projectProfile';

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

    if (!isCourseProjectProfile(settings.project.profile) && executable.lowerMnemonic === 'li' && canonicalRegister(executable.operands[0]?.text ?? '') === '$v0' && executable.operands[1]) {
      const operand = executable.operands[1];
      const syscall = syscallByOperand(operand);
      if (syscall) {
        if (inRequestedRange) {
          hints.push({
            position: operand.range.end,
            label: ` ${syscall.name}${syscall.supported === false ? '（不支持）' : ''}`,
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
      if (settings.project.profile === 'P7' && inRequestedRange) {
        hints.push({ position: executable.range.end, label: ' ExcCode=8 → 0x4180', kind: InlayHintKind.Parameter,
          tooltip: markdownTooltip(p7SyscallMarkdown), paddingLeft: true });
      }
      if (currentSyscall && inRequestedRange) {
        hints.push({
          position: executable.range.end,
          label: ` ${currentSyscall.name}${currentSyscall.supported === false ? '（不支持）' : ''}`,
          kind: InlayHintKind.Parameter,
          tooltip: markdownTooltip(syscallMarkdown(currentSyscall)),
          paddingLeft: true
        });
      }
      currentSyscall = undefined;
    }

    if ((executable.lowerMnemonic === 'mfc0' || executable.lowerMnemonic === 'mtc0') && executable.operands[1] && inRequestedRange) {
      const operand = executable.operands[1];
      const register = cp0ByOperand(operand);
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

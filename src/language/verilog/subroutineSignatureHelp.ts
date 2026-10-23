// @index subroutine-signature-help — Callable argument context and shared lexical signature binding
import { MarkupKind, Position, SignatureHelp } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition } from '../common/lsp';
import type { VerilogParseResult, VerilogDecl, VerilogSubroutineSignature } from './model';
import { resolveVerilogSubroutineSignature } from './semanticModel';
import { widthOfDecl } from './expressions';

interface Delimiter { value: string; tokenIndex: number; parameter: number }

export function getSubroutineSignatureHelp(document: TextDocument, position: Position, parsed: VerilogParseResult): SignatureHelp | undefined {
  const offset = document.offsetAt(position);
  const module = parsed.modules.find((candidate) => containsPosition(candidate.range, position));
  if (!module) return undefined;
  const start = document.offsetAt(module.headerEnd);
  const tokens = parsed.ast.tokens;
  const stack: Delimiter[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.start < start) continue;
    if (token.start >= offset) break;
    if (['(', '[', '{'].includes(token.value)) stack.push({ value: token.value, tokenIndex: index, parameter: 0 });
    else if ([')', ']', '}'].includes(token.value)) stack.pop();
    else if (token.value === ',' && stack[stack.length - 1]?.value === '(') stack[stack.length - 1].parameter++;
  }
  for (let index = stack.length - 1; index >= 0; index--) {
    const frame = stack[index];
    const callee = tokens[frame.tokenIndex - 1];
    if (frame.value !== '(' || callee?.kind !== 'identifier') continue;
    const calleePosition = document.positionAt(callee.start);
    const signature = resolveVerilogSubroutineSignature(parsed.semantic, callee.value, calleePosition);
    if (!signature || signature.complete === false || containsPosition(signature.headerRange, calleePosition)) continue;
    const formals = signature.formals.map(formalLabel);
    const label = `${signaturePrefix(signature)} ${signature.name}(${formals.join(', ')})`;
    const width = signature.kind === 'function' ? widthOfDecl(signature.declaration, module).width : undefined;
    return {
      activeSignature: 0,
      activeParameter: signature.formals.length ? Math.min(frame.parameter, signature.formals.length - 1) : 0,
      signatures: [{
        label,
        documentation: { kind: MarkupKind.Markdown, value: `\`\`\`verilog\n${label};\n\`\`\`${width === undefined ? '' : `\n\n返回位宽：\`${width}\` 位`}` },
        parameters: formals.map((formal) => ({ label: formal, documentation: { kind: MarkupKind.Markdown, value: `\`${formal}\`` } }))
      }]
    };
  }
  return undefined;
}

function formalLabel(decl: VerilogDecl): string {
  const type = decl.valueType ?? decl.netType ?? 'reg';
  return [decl.direction ?? 'input', type, decl.signed && type !== 'integer' ? 'signed' : '', decl.width ?? '', decl.name,
    ...(decl.unpackedDimensions ?? []).map((dimension) => dimension.text)].filter(Boolean).join(' ');
}

function signaturePrefix(signature: VerilogSubroutineSignature): string {
  if (signature.kind === 'task') return 'task';
  const decl = signature.declaration;
  return ['function', decl.functionReturnType ?? 'reg', decl.signed && decl.functionReturnType !== 'integer' ? 'signed' : '', decl.width ?? ''].filter(Boolean).join(' ');
}

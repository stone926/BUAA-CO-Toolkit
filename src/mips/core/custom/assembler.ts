// @index mips-core — Custom instruction operand checking and two-pass relocation adapter
import type { AssemblerInstructionExtension } from '../assembler/assembler';
import { assemblerDiagnostic } from '../assembler/diagnostics';
import { evaluateExpression } from '../assembler/expression';
import { parseInstructionOperand } from '../assembler/operands';
import { WorkOperand, workOriginFor } from '../assembler/work';
import type { CustomInstructionMode } from './api';
import { CustomInstructionRegistry } from './registry';

export function customAssemblerExtension(registry: CustomInstructionRegistry, mode: CustomInstructionMode): AssemblerInstructionExtension {
  return {
    handlesScope: mnemonic => registry.get(mnemonic, mode) !== undefined,
    expand(statement) {
      const mnemonic = statement.mnemonic?.toLowerCase() ?? '';
      const definition = registry.get(mnemonic, mode);
      if (!definition) return undefined;
      const origin = workOriginFor(statement);
      const invalid = (message: string) => ({ ok: false, diagnostic: assemblerDiagnostic('asm.operand.invalid-immediate', `${mnemonic}: ${message}`, origin.span, origin.expansionStack) });
      if (statement.operands.length !== definition.operands.length) return { ok: false, diagnostic: assemblerDiagnostic('asm.operand.wrong-count', `${mnemonic}: expected ${definition.operands.length} operands`, origin.span, origin.expansionStack) };
      const operands: WorkOperand[] = [];
      for (let index = 0; index < definition.operands.length; index++) {
        const spec = definition.operands[index];
        const parsed = parseInstructionOperand(statement.operands[index].text, statement.operands[index].span);
        if (spec.kind === 'register') {
          if (parsed.kind !== 'register') return invalid(`operand ${index + 1} requires a GPR`);
          operands.push(parsed);
        } else if (spec.kind === 'memory') {
          if (parsed.kind !== 'memory') return invalid(`operand ${index + 1} requires offset($base)`);
          operands.push({ kind: 'memory', baseRegister: parsed.baseRegister, offsetExpression: parsed.offsetText, offsetSpan: parsed.offsetSpan, span: parsed.span });
        } else {
          if (parsed.kind !== 'immediate' && parsed.kind !== 'character') return invalid(`operand ${index + 1} requires an expression`);
          operands.push({ kind: spec.relocation ? 'label' : 'immediate', expression: parsed.text, span: parsed.span });
        }
      }
      return { ok: true, instructions: [{ mnemonic, operands, origin, pseudo: false }] };
    },
    encode(instruction, address, resolve) {
      const definition = registry.get(instruction.mnemonic, mode);
      if (!definition) return undefined;
      let code: 'asm.symbol.undefined' | 'asm.immediate.out-of-range' | 'asm.operand.invalid-immediate' = 'asm.operand.invalid-immediate';
      try {
        const fields: Record<string, number> = {};
        let expressionUsedSymbol = false;
        const expression = (text: string): number => {
          expressionUsedSymbol = false;
          const result = evaluateExpression(text, { resolve(name) { expressionUsedSymbol = true; return resolve(name); } }, { unresolvedIsError: true });
          if (!result.ok) { code = result.unresolvedSymbols?.length || /(?:undefined symbol|未定义符号)/i.test(result.error ?? '') ? 'asm.symbol.undefined' : 'asm.operand.invalid-immediate'; throw new Error(result.error ?? `Unresolved expression ${text}`); }
          return result.value!;
        };
        const assign = (field: string, value: number, signed = false): void => {
          const width = registry.fields(definition.mnemonic, mode).find(item => item.name === field)!.width;
          const min = signed ? -(2 ** (width - 1)) : 0, max = 2 ** (signed ? width - 1 : width) - 1;
          if (!Number.isInteger(value) || value < min || value > max) { code = 'asm.immediate.out-of-range'; throw new Error(`${field} must be in ${min}..${max}`); }
          fields[field] = value;
        };
        definition.operands.forEach((spec, index) => {
          const operand = instruction.operands[index];
          if (spec.kind === 'register' && operand.kind === 'register') assign(spec.field, operand.register);
          else if (spec.kind === 'memory' && operand.kind === 'memory') { assign(spec.baseField, operand.baseRegister); assign(spec.offsetField, expression(operand.offsetExpression), spec.signed ?? true); }
          else if (spec.kind === 'immediate' && (operand.kind === 'immediate' || operand.kind === 'label')) {
            let value = expression(operand.expression);
            // MARS custom branch operands accept a raw numeric displacement as well as a label.
            if (spec.relocation === 'branch' && expressionUsedSymbol) value = ((value >>> 0) - ((address + 4) >>> 0)) / 4;
            if (spec.relocation === 'jump') {
              if (((value >>> 0) & 0xf0000000) !== (((address + 4) >>> 0) & 0xf0000000) || (value & 3) !== 0) throw new Error('Jump target must be aligned and in the same 256 MiB region');
              value = (value >>> 2) & 0x03ffffff;
            }
            assign(spec.field, value, spec.signed ?? spec.relocation === 'branch');
          } else throw new Error('Operand does not match custom instruction definition');
        });
        return { word: registry.encode(definition.mnemonic, fields, mode) };
      } catch (error) {
        return { diagnostic: assemblerDiagnostic(code, `${definition.mnemonic}: ${error instanceof Error ? error.message : String(error)}`, instruction.origin.span, instruction.origin.expansionStack) };
      }
    }
  };
}

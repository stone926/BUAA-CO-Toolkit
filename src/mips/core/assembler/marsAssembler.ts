// @index mips-core — Ordinary MARS assembly through the shared two-pass assembler and official memory layouts

import type { SourceUnit } from '../api';
import { getMarsMemoryLayout, MarsMemoryConfiguration } from '../profiles/marsMemoryLayout';
import { assembleCourseSource, CourseAssemblerOptions, CourseAssemblerResult } from './assembler';
import { encodeMarsInstruction, marsInstructionWork } from './marsInstructions';
import { encodeMarsIntegerInstruction, marsIntegerWork } from './marsIntegerPseudo';

export interface MarsAssemblerOptions extends Pick<CourseAssemblerOptions,
  'sourceResolver' | 'sourceLimits' | 'maximumMacroDepth' | 'maximumExpandedInstructions'
  | 'maximumPseudoInstructionsPerStatement' | 'maximumSegmentBytes'> {
  readonly memoryConfiguration?: MarsMemoryConfiguration;
  readonly delayedBranching?: boolean;
}

/** Ordinary MARS has service syscalls at execution time; assembly stays shared. */
export function assembleMarsSource(root: SourceUnit, options: MarsAssemblerOptions = {}): CourseAssemblerResult {
  const memory = getMarsMemoryLayout(options.memoryConfiguration);
  return assembleCourseSource(root, {
    ...options,
    profile: 'P7',
    layers: ['required', 'commonExtensions', 'marsCompatibility'],
    sectionLayout: memory.sectionLayout,
    compactAddresses: memory.configuration !== 'Default',
    expandNumericMemoryOffsets: true,
    externBase: memory.externBase,
    dataPaddingBytes: 4,
    maximumExpandedInstructions: options.maximumExpandedInstructions ?? 262_144,
    p7RiInstruction: false,
    instructionExtension: {
      expand(statement, expansionOptions) {
        return marsInstructionWork(statement, expansionOptions)
          ?? marsIntegerWork(statement, {
            delayedBranching: options.delayedBranching ?? false,
            maximumInstructionsPerStatement: expansionOptions.maximumInstructionsPerStatement
          });
      },
      encode(instruction, address, resolve) {
        return encodeMarsInstruction(instruction, address, resolve)
          ?? encodeMarsIntegerInstruction(instruction, address, resolve);
      }
    }
  });
}

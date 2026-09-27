// @index hazard-theory — 课程冒险覆盖评分：13 个指令类别、P5/P6 各冲突类别的转发/阻塞元组上确界与 60+40·k/K 评分
import type { HazardClass } from './hazardTiming';

/** Course strength-table classes (P5-4-5). Instructions outside them are not graded. */
export const courseHazardClasses = [
  'cal_rr', 'cal_ri', 'br_r1', 'br_r2', 'mv_fr', 'mv_to', 'load', 'store', 'mul_div', 'lui', 'jal', 'jalr', 'jr'
] as const satisfies readonly HazardClass[];

export type CourseHazardClass = typeof courseHazardClasses[number];
export type CourseHazardModel = 'P5' | 'P6';

const courseClassMembers: Readonly<Record<CourseHazardClass, readonly string[]>> = {
  cal_rr: ['add', 'addu', 'sub', 'subu', 'slt', 'sltu', 'and', 'nor', 'or', 'xor', 'sllv', 'srav', 'srlv'],
  cal_ri: ['addi', 'addiu', 'slti', 'sltiu', 'andi', 'ori', 'xori', 'sll', 'sra', 'srl'],
  br_r1: ['bgez', 'bgtz', 'blez', 'bltz'],
  br_r2: ['beq', 'bne'],
  mv_fr: ['mfhi', 'mflo'],
  mv_to: ['mthi', 'mtlo'],
  load: ['lw', 'lh', 'lhu', 'lb', 'lbu'],
  store: ['sw', 'sh', 'sb'],
  mul_div: ['mult', 'multu', 'div', 'divu'],
  lui: ['lui'],
  jal: ['jal'],
  jalr: ['jalr'],
  jr: ['jr']
};

const courseClassByMnemonic = new Map<string, CourseHazardClass>(
  Object.entries(courseClassMembers).flatMap(([hazardClass, members]) =>
    members.map((mnemonic) => [mnemonic, hazardClass as CourseHazardClass] as const))
);

/** Course class of a mnemonic, or undefined when the course table does not grade it. */
export function courseHazardClassOf(mnemonic: string): CourseHazardClass | undefined {
  return courseClassByMnemonic.get(mnemonic);
}

export function courseHazardClassMembers(hazardClass: CourseHazardClass): readonly string[] {
  return courseClassMembers[hazardClass];
}

export interface CourseHazardBound {
  readonly forward: number;
  readonly stall: number;
}

export interface CourseHazardTheory {
  readonly forward: number;
  readonly stall: number;
  /** Key: `${consumerClass} <~~ ${producerClass}`, as printed by the course analyzer. */
  readonly byClass: Readonly<Record<string, CourseHazardBound>>;
}

function bounds(entries: ReadonlyArray<readonly [string, number, number]>): Record<string, CourseHazardBound> {
  return Object.fromEntries(entries.map(([key, forward, stall]) => [key, { forward, stall }]));
}

/** Upper bounds published with the course Hazard-Calculator strength evaluation. */
export const courseHazardTheory: Readonly<Record<CourseHazardModel, CourseHazardTheory>> = {
  P5: {
    forward: 107,
    stall: 15,
    byClass: bounds([
      ['cal_rr <~~ cal_rr', 12, 0], ['cal_rr <~~ cal_ri', 6, 0], ['cal_rr <~~ load', 4, 2],
      ['cal_rr <~~ lui', 6, 0], ['cal_rr <~~ jal', 6, 0],
      ['cal_ri <~~ cal_rr', 6, 0], ['cal_ri <~~ cal_ri', 3, 0], ['cal_ri <~~ load', 2, 1],
      ['cal_ri <~~ lui', 3, 0], ['cal_ri <~~ jal', 3, 0],
      ['br_r2 <~~ cal_rr', 4, 2], ['br_r2 <~~ cal_ri', 2, 1], ['br_r2 <~~ load', 1, 2],
      ['br_r2 <~~ lui', 3, 0], ['br_r2 <~~ jal', 2, 0],
      ['load <~~ cal_rr', 6, 0], ['load <~~ cal_ri', 3, 0], ['load <~~ load', 2, 1],
      ['load <~~ lui', 3, 0], ['load <~~ jal', 3, 0],
      ['store <~~ cal_rr', 6, 0], ['store <~~ cal_ri', 3, 0], ['store <~~ load', 3, 1],
      ['store <~~ lui', 3, 0], ['store <~~ jal', 3, 0],
      ['jr <~~ cal_rr', 4, 2], ['jr <~~ cal_ri', 2, 1], ['jr <~~ load', 1, 2], ['jr <~~ jal', 2, 0]
    ])
  },
  P6: {
    forward: 1036,
    stall: 110,
    byClass: bounds([
      ['cal_rr <~~ cal_rr', 108, 0], ['cal_rr <~~ cal_ri', 54, 0], ['cal_rr <~~ mv_fr', 36, 0],
      ['cal_rr <~~ load', 36, 18], ['cal_rr <~~ lui', 18, 0], ['cal_rr <~~ jal', 18, 0],
      ['cal_ri <~~ cal_rr', 54, 0], ['cal_ri <~~ cal_ri', 27, 0], ['cal_ri <~~ mv_fr', 18, 0],
      ['cal_ri <~~ load', 18, 9], ['cal_ri <~~ lui', 9, 0], ['cal_ri <~~ jal', 9, 0],
      ['br_r2 <~~ cal_rr', 24, 12], ['br_r2 <~~ cal_ri', 12, 6], ['br_r2 <~~ mv_fr', 8, 4],
      ['br_r2 <~~ load', 6, 12], ['br_r2 <~~ lui', 6, 0], ['br_r2 <~~ jal', 4, 0],
      ['mv_to <~~ cal_rr', 36, 0], ['mv_to <~~ cal_ri', 18, 0], ['mv_to <~~ mv_fr', 12, 0],
      ['mv_to <~~ load', 12, 6], ['mv_to <~~ lui', 6, 0], ['mv_to <~~ jal', 6, 0],
      ['load <~~ cal_rr', 54, 0], ['load <~~ cal_ri', 27, 0], ['load <~~ mv_fr', 18, 0],
      ['load <~~ load', 18, 9], ['load <~~ lui', 9, 0], ['load <~~ jal', 9, 0],
      ['store <~~ cal_rr', 54, 0], ['store <~~ cal_ri', 27, 0], ['store <~~ mv_fr', 18, 0],
      ['store <~~ load', 27, 9], ['store <~~ lui', 9, 0], ['store <~~ jal', 9, 0],
      ['mul_div <~~ cal_rr', 72, 0], ['mul_div <~~ cal_ri', 36, 0], ['mul_div <~~ mv_fr', 24, 0],
      ['mul_div <~~ load', 24, 12], ['mul_div <~~ lui', 12, 0], ['mul_div <~~ jal', 12, 0],
      ['jr <~~ cal_rr', 8, 4], ['jr <~~ cal_ri', 6, 3], ['jr <~~ mv_fr', 4, 2],
      ['jr <~~ load', 2, 4], ['jr <~~ jal', 2, 0]
    ])
  }
};

export function courseHazardPairKey(consumerClass: CourseHazardClass, producerClass: CourseHazardClass): string {
  return `${consumerClass} <~~ ${producerClass}`;
}

/** Course grade: 0 when absent, otherwise 60 + 40·k/K; undefined when the class has no tuples. */
export function courseHazardGrade(expected: number, covered: number): number | undefined {
  if (expected === 0) return undefined;
  if (covered === 0) return 0;
  return 60 + 40 * Math.min(1, covered / expected);
}

/** P5 uses its own table; P6 and P7 share the P6 table (P7 adds no graded hazard classes). */
export function courseHazardModelFor(profile: string): CourseHazardModel {
  return profile === 'P5' ? 'P5' : 'P6';
}

// @index p7-probe-mdu-operations — 中断 MDU 探针操作与变体的纯目录
export const interruptMduOperations = ['mult', 'multu', 'div', 'divu', 'mthi', 'mtlo'] as const;

export type MduOperation = typeof interruptMduOperations[number];

export const interruptMduVariants = interruptMduOperations.map((operation) => `mdu-retry-${operation}`);

/** An older MDU operation must survive an interrupt of its later HI/LO reader. */
export const olderMduVariants = [
  'mdu-older-mult-direct', 'mdu-older-mult-branch-delay',
  'mdu-older-div-direct', 'mdu-older-div-branch-delay'
] as const;

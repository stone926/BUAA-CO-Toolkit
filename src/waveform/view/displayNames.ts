// @index waveform-display-names — 信号行显示名：叶子名重名时补最短的父 scope 前缀以区分

export interface DisplayName {
  /** Dimmed scope prefix including the trailing dot, or empty. */
  readonly prefix: string;
  readonly leaf: string;
}

/**
 * Shortest unique suffixes of dot-separated paths. `tb.uut.CPU.FDreg.clk` and
 * `tb.clk` become `FDreg.` + `clk` and `tb.` + `clk`; unique leaves stay bare.
 */
export function shortestUniqueNames(paths: readonly string[]): DisplayName[] {
  const segments = paths.map((path) => path.split('.'));
  const depth = segments.map(() => 1);
  for (let round = 0; round < 64; round++) {
    const byName = new Map<string, number[]>();
    segments.forEach((parts, index) => {
      const key = parts.slice(-depth[index]).join('.');
      const list = byName.get(key) ?? [];
      list.push(index);
      byName.set(key, list);
    });
    let changed = false;
    for (const indexes of byName.values()) {
      const distinct = new Set(indexes.map((index) => paths[index]));
      if (distinct.size < 2) {
        continue;
      }
      for (const index of indexes) {
        if (depth[index] < segments[index].length) {
          depth[index]++;
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }
  return segments.map((parts, index) => {
    const shown = parts.slice(-depth[index]);
    const leaf = shown[shown.length - 1] ?? '';
    return { prefix: shown.length > 1 ? `${shown.slice(0, -1).join('.')}.` : '', leaf };
  });
}

// @index custom-generator — Reject native helpers whose encoding or assembly name is replaced by a script
import type { CustomInstructionRegistry } from '../../mips/core/custom/registry';
import { isaInstructionByMnemonic, type CourseProfile } from '../../mips/core/generated/isaCatalog';

export function assertCustomGeneratorNativeDependencies(registry: CustomInstructionRegistry | undefined, profile: CourseProfile, mnemonics: Iterable<string>): void {
  if (!registry) return;
  const conflicts = new Set<string>();
  for (const mnemonic of mnemonics) {
    const native = isaInstructionByMnemonic.get(mnemonic);
    if (!native || !native.profiles.includes(profile)) continue;
    const named = registry.get(mnemonic, profile);
    if (named) conflicts.add(`${mnemonic} (${named.mnemonic})`);
    let mask = native.runtimeMatchMask, value = native.runtimeMatchValue;
    for (const [zeroMask] of native.canonicalFixedZeroBits) mask |= zeroMask;
    if (native.formatKind === 'regimm') { mask |= 0x001f0000; value |= native.formatRt << 16; }
    if (native.formatKind === 'cop0') { mask |= 0x03e00000; value |= native.formatRs << 21; }
    const variants = native.mnemonic === 'mfc0' || native.mnemonic === 'mtc0'
      ? (native.mnemonic === 'mfc0' ? [12, 13, 14] : [12, 14]).map((rd) => ({ mask: mask | 0x0000f800, value: value | (rd << 11) }))
      : [{ mask, value }];
    for (const custom of registry.encodings(profile)) {
      if (variants.some((variant) => (((variant.value ^ custom.value) & variant.mask & custom.mask) >>> 0) === 0)) {
        conflicts.add(`${mnemonic} (${custom.mnemonic})`);
      }
    }
  }
  if (conflicts.size) throw new Error(`自定义指令覆盖自动测试依赖的课程基础指令：${[...conflicts].join('、')}；无法保证测试前导、停机和异常处理程序语义，请使用用户 ASM 测试。`);
}

export function generatedSourceMnemonics(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const code = line.replace(/#.*/, '').replace(/^\s*[\w.$]+:\s*/, '').trim();
    const mnemonic = /^([a-z][a-z0-9]*)\b/i.exec(code)?.[1]?.toLowerCase();
    return mnemonic ? [mnemonic] : [];
  });
}

// @index verilog-backend — isePath 驱动的 Icarus/ISim 两值选择器

export type VerilogBackend = 'iverilog' | 'isim';

/**
 * A non-empty resource-scoped ISE path is an explicit opt-in to ISim.
 * Deliberately do not inspect PATH or any legacy backend setting here.
 */
export function selectVerilogBackend(isePath: string | undefined | null): VerilogBackend {
  return isePath?.trim() ? 'isim' : 'iverilog';
}

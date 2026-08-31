// @index verilog-backend — 显式后端偏好；通用 Verilog 流程默认 bundled Icarus

export type VerilogBackend = 'iverilog' | 'isim';

/**
 * Tool availability is not a backend selection. Callers must explicitly ask
 * for ISim; merely keeping an ISE installation path configured never diverts a
 * generic syntax-check, simulation, or automatic-test operation from Icarus.
 */
export function selectVerilogBackend(preference?: VerilogBackend | null): VerilogBackend {
  return preference === 'isim' ? 'isim' : 'iverilog';
}

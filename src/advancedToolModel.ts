import {
  Commands,
  HAZARD_PROFILES,
  LOGISIM_PROFILES,
  VERILOG_PROFILES
} from './constants';
import { ProjectProfile } from './projectProfile';

export type CoActiveKind = 'mips' | 'verilog' | 'logisim' | 'other' | 'none';

export interface AdvancedToolContext {
  profile: ProjectProfile;
  activeKind: CoActiveKind;
  activeFileName?: string;
}

export interface AdvancedToolItemModel {
  id: string;
  label: string;
  description: string;
  detail: string;
  command: string;
}

const verilogProfiles = VERILOG_PROFILES;
const logisimProfiles = LOGISIM_PROFILES;
const hazardProfiles = HAZARD_PROFILES;

export function buildAdvancedToolItems(context: AdvancedToolContext): AdvancedToolItemModel[] {
  const items: AdvancedToolItemModel[] = [];
  const activeDetail = context.activeFileName ? `当前文件: ${context.activeFileName}` : '运行时选择输入文件';

  if (context.activeKind === 'mips') {
    items.push(
      tool('mips.workbench', 'MARS 调试工作台', '单步、断点与 syscall 参考', activeDetail, Commands.Mips.OpenWorkbench),
      tool('mips.stdin', 'ASM 带标准输入运行', '内置 MIPS 引擎', activeDetail, Commands.Mips.RunWithStdinFile),
      tool('mips.terminal', 'ASM 终端运行', '内置 MIPS 引擎', activeDetail, Commands.Mips.RunInTerminal)
    );
    if (context.profile === 'P7') {
      items.push(tool('mips.kernelDump', 'ASM 导出内核文本段', '内置汇编器', activeDetail, Commands.Mips.DumpKernelText));
    }
  }

  if (context.activeKind === 'verilog' && verilogProfiles.has(context.profile)) {
    items.push(
      tool('verilog.testbench', '生成 Verilog Testbench', 'Verilog', activeDetail, Commands.Verilog.GenerateTestbench),
      tool('verilog.syntax', '检查 Verilog 语法', 'Icarus（内置）', activeDetail, Commands.Verilog.CheckSyntax),
      tool('verilog.openVcd', '打开 VCD 波形文件', '内置波形查看器', '选择任意仿真器生成的 .vcd 文件', Commands.Waveform.OpenFile)
    );
  }

  if (shouldShowLogisimTools(context)) {
    items.push(
      tool('logisim.rom', '生成 Logisim ROM 文件', 'Logisim', '选择 ASM 并生成 ROM 文本', Commands.Logisim.GenerateRom),
      tool('logisim.csv', 'Logisim 日志转 CSV', 'Logisim', '选择 logging 文本并转换', Commands.Logisim.ConvertLogToCsv)
    );
  }

  if (hazardProfiles.has(context.profile)) {
    items.push(
      tool('hazard.analyze', '分析流水线冲突', '内置冲突分析器', '选择 ASM 文件并生成覆盖率报告', Commands.Hazard.AnalyzeCurrentMachineCode),
      tool('hazard.report', '打开冲突报告', '内置冲突分析器', '打开最近一次分析结果', Commands.Hazard.OpenReport)
    );
  }

  return items;
}

function shouldShowLogisimTools(context: AdvancedToolContext): boolean {
  return context.profile !== 'auto' && (context.activeKind === 'logisim' || logisimProfiles.has(context.profile));
}

function tool(
  id: string,
  label: string,
  description: string,
  detail: string,
  command: string
): AdvancedToolItemModel {
  return { id, label, description, detail, command };
}

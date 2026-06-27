import {
  Commands,
  HAZARD_PROFILES,
  LOGISIM_PROFILES,
  MIPS_PROFILES,
  TRACE_PROFILES,
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

const traceProfiles = TRACE_PROFILES;
const verilogProfiles = VERILOG_PROFILES;
const mipsProfiles = MIPS_PROFILES;
const logisimProfiles = LOGISIM_PROFILES;
const hazardProfiles = HAZARD_PROFILES;

export function buildAdvancedToolItems(context: AdvancedToolContext): AdvancedToolItemModel[] {
  const items: AdvancedToolItemModel[] = [];
  const activeDetail = context.activeFileName ? `当前文件: ${context.activeFileName}` : '运行时选择输入文件';

  if (context.activeKind === 'mips' && shouldShowMipsTools(context.profile)) {
    items.push(
      tool('mips.stdin', 'ASM 带标准输入运行', 'MARS', activeDetail, Commands.Mips.RunWithStdinFile),
      tool('mips.terminal', 'ASM 终端运行', 'MARS', activeDetail, Commands.Mips.RunInTerminal)
    );
    if (context.profile === 'P7') {
      items.push(tool('mips.kernelDump', 'ASM 导出内核文本段', 'MARS', activeDetail, Commands.Mips.DumpKernelText));
    }
  }

  if (traceProfiles.has(context.profile)) {
    items.push(
      tool('trace.single', '单 ASM Trace 测试', '课程测试', '选择一个 ASM，创建 case 并对拍', Commands.Test.RunFullTest),
      tool('trace.batch', '多 ASM 批量 Trace 测试', '课程测试', '选择多个 ASM，生成批量报告', Commands.Test.RunBatchTraceTests),
      tool('trace.generatedBatch', '生成并批量 Trace 测试', '课程测试', '生成 ASM 后批量对拍', Commands.Test.RunGeneratedTraceTests),
      tool('trace.generateAsm', '生成 ASM 测试点', '课程测试', '只生成并记录 ASM case', Commands.Test.GenerateAsmTests),
      tool('trace.generateAndDump', '生成并导出机器码', '课程测试', '生成 ASM 后 dump code.txt', Commands.Test.GenerateAndDumpAsmTests),
      tool('trace.compareFiles', '手动选择输出对拍', '报告', '选择两个 trace 输出文件比较', Commands.Test.CompareTraceFiles),
      tool('trace.compareLatest', '最近输出对拍', '报告', '比较 .co/out 中最近的黄金/仿真输出', Commands.Test.CompareLatestOutputs),
      tool('trace.batchReport', '打开批量测试报告', '报告', '打开 .co/out 中最近的批量报告', Commands.Test.OpenBatchTraceReport)
    );
  }

  if (context.activeKind === 'verilog' && verilogProfiles.has(context.profile)) {
    items.push(
      tool('verilog.testbench', '生成 Verilog Testbench', 'Verilog', activeDetail, Commands.Verilog.GenerateTestbench),
      tool('verilog.syntaxIse', '使用 ISE 检查语法', 'Verilog', activeDetail, Commands.Verilog.CheckSyntaxWithIse),
      tool('verilog.iseProject', '生成 ISE 工程', 'Verilog', '生成 .co/isim PRJ/TCL', Commands.Verilog.GenerateIseProject),
      tool('verilog.vcd', '导出 VCD 波形', 'Verilog', '批量运行并写入 .co/out', Commands.Verilog.ExportVcd)
    );
  }

  if (shouldShowLogisimTools(context)) {
    items.push(
      tool('logisim.rom', '生成 Logisim ROM 文件', 'Logisim', '选择 ASM 并生成 ROM 文本', Commands.Logisim.GenerateRom),
      tool('logisim.csv', 'Logisim 日志转 CSV', 'Logisim', '选择 logging 文本并转换', Commands.Logisim.ConvertLogToCsv)
    );
    if (context.profile === 'P3' || context.activeKind === 'logisim') {
      items.push(
        tool('logisim.prepare', '准备 Logisim 电路用例', 'Logisim', '选择 ASM 并注入电路副本', Commands.Test.PrepareLogisimCases),
        tool('logisim.prepareGenerated', '准备生成的 Logisim 电路用例', 'Logisim', '生成 ASM 并注入电路副本', Commands.Test.PrepareGeneratedLogisimCases),
        tool('logisim.diagnoseP3', '诊断 P3 Logisim Trace 电路', 'Logisim', '输出 trace 端口、ROM 和列映射诊断', Commands.Test.DiagnoseP3LogisimTraceCircuit)
      );
    }
  }

  if (hazardProfiles.has(context.profile)) {
    items.push(
      tool('hazard.analyze', '分析流水线冲突', 'Hazard', '当前 ASM 或运行时选择机器码', Commands.Hazard.AnalyzeCurrentMachineCode),
      tool('hazard.report', '打开冲突报告', 'Hazard', '打开最近一次分析结果', Commands.Hazard.OpenReport)
    );
  }

  return items;
}

function shouldShowMipsTools(profile: ProjectProfile): boolean {
  return profile !== 'auto' && mipsProfiles.has(profile);
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

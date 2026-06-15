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

const traceProfiles = new Set<ProjectProfile>(['P3', 'P4', 'P5', 'P6', 'P7']);
const verilogProfiles = new Set<ProjectProfile>(['P1', 'P4', 'P5', 'P6', 'P7']);
const mipsProfiles = new Set<ProjectProfile>(['P2', 'P4', 'P5', 'P6', 'P7']);
const logisimProfiles = new Set<ProjectProfile>(['P0', 'P3']);
const hazardProfiles = new Set<ProjectProfile>(['P5', 'P6', 'P7']);

export function buildAdvancedToolItems(context: AdvancedToolContext): AdvancedToolItemModel[] {
  const items: AdvancedToolItemModel[] = [];
  const activeDetail = context.activeFileName ? `当前文件: ${context.activeFileName}` : '运行时选择输入文件';

  if (context.activeKind === 'mips' && shouldShowMipsTools(context.profile)) {
    items.push(
      tool('mips.stdin', 'ASM 带标准输入运行', 'MARS', activeDetail, 'co.mips.runWithStdinFile'),
      tool('mips.terminal', 'ASM 终端运行', 'MARS', activeDetail, 'co.mips.runInTerminal')
    );
    if (context.profile === 'P7') {
      items.push(tool('mips.kernelDump', 'ASM 导出内核文本段', 'MARS', activeDetail, 'co.mips.dumpKernelText'));
    }
  }

  if (traceProfiles.has(context.profile)) {
    items.push(
      tool('trace.single', '单 ASM Trace 测试', '课程测试', '选择一个 ASM，创建 case 并对拍', 'co.test.runFullTest'),
      tool('trace.batch', '多 ASM 批量 Trace 测试', '课程测试', '选择多个 ASM，生成批量报告', 'co.test.runBatchTraceTests'),
      tool('trace.generatedBatch', '生成并批量 Trace 测试', '课程测试', '生成 ASM 后批量对拍', 'co.test.runGeneratedTraceTests'),
      tool('trace.generateAsm', '生成 ASM 测试点', '课程测试', '只生成并记录 ASM case', 'co.test.generateAsmTests'),
      tool('trace.generateAndDump', '生成并导出机器码', '课程测试', '生成 ASM 后 dump code.txt', 'co.test.generateAndDumpAsmTests'),
      tool('trace.compareFiles', '手动选择输出对拍', '报告', '选择两个 trace 输出文件比较', 'co.test.compareTraceFiles'),
      tool('trace.compareLatest', '最近输出对拍', '报告', '比较 .co/out 中最近的黄金/仿真输出', 'co.test.compareLatestOutputs'),
      tool('trace.batchReport', '打开批量测试报告', '报告', '打开 .co/out 中最近的批量报告', 'co.test.openBatchTraceReport')
    );
  }

  if (context.activeKind === 'verilog' && verilogProfiles.has(context.profile)) {
    items.push(
      tool('verilog.testbench', '生成 Verilog Testbench', 'Verilog', activeDetail, 'co.verilog.generateTestbench'),
      tool('verilog.syntaxIse', '使用 ISE 检查语法', 'Verilog', activeDetail, 'co.verilog.checkSyntaxWithIse'),
      tool('verilog.iseProject', '生成 ISE 工程', 'Verilog', '生成 .co/isim PRJ/TCL', 'co.verilog.generateIseProject'),
      tool('verilog.vcd', '导出 VCD 波形', 'Verilog', '批量运行并写入 .co/out', 'co.verilog.exportVcd')
    );
  }

  if (shouldShowLogisimTools(context)) {
    items.push(
      tool('logisim.rom', '生成 Logisim ROM 文件', 'Logisim', '选择 ASM 并生成 ROM 文本', 'co.logisim.generateRom'),
      tool('logisim.csv', 'Logisim 日志转 CSV', 'Logisim', '选择 logging 文本并转换', 'co.logisim.convertLogToCsv')
    );
    if (context.profile === 'P3' || context.activeKind === 'logisim') {
      items.push(
        tool('logisim.prepare', '准备 Logisim 电路用例', 'Logisim', '选择 ASM 并注入电路副本', 'co.test.prepareLogisimCases'),
        tool('logisim.prepareGenerated', '准备生成的 Logisim 电路用例', 'Logisim', '生成 ASM 并注入电路副本', 'co.test.prepareGeneratedLogisimCases'),
        tool('logisim.diagnoseP3', '诊断 P3 Logisim Trace 电路', 'Logisim', '输出 trace 端口、ROM 和列映射诊断', 'co.test.diagnoseP3LogisimTraceCircuit')
      );
    }
  }

  if (hazardProfiles.has(context.profile)) {
    items.push(
      tool('hazard.analyze', '分析流水线冲突', 'Hazard', '当前 ASM 或运行时选择机器码', 'co.hazard.analyzeCurrentMachineCode'),
      tool('hazard.report', '打开冲突报告', 'Hazard', '打开最近一次分析结果', 'co.hazard.openReport')
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

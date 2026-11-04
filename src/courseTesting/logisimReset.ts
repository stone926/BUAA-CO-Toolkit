// @index logisim-reset — 为 P3 派生电路驱动一次异步复位，不改写 CPU 内部状态
import { parseLogisimTraceSpec, type LogisimTraceSpec } from './logisimTrace';

export interface PreparedLogisimReset {
  text: string;
  traceSpec: LogisimTraceSpec;
  applied: boolean;
}

/** The course top-level reset is active-high; release it on the first falling clock edge. */
export function prepareP3LogisimReset(text: string, traceSpec: LogisimTraceSpec): PreparedLogisimReset {
  const circuit = [...text.matchAll(/<circuit\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/circuit>/g)]
    .find(match => decode(match[1]) === traceSpec.circuitName);
  if (!circuit) throw new Error('Logisim 复位准备失败：未找到测试顶层。');
  const block = circuit[0];
  const components = [...block.matchAll(/<comp\b[^>]*?(?:\/>|>[\s\S]*?<\/comp>)/g)].map(match => match[0]);
  const resets = components.filter(comp => attr(comp, 'name') === 'Pin'
    && setting(comp, 'output') !== 'true' && setting(comp, 'label')?.toLowerCase() === 'reset');
  // Already self-initializing harnesses remain supported.
  if (!resets.length) return { text, traceSpec, applied: false };
  if (resets.length !== 1 || (setting(resets[0], 'width') ?? '1') !== '1') {
    throw new Error('Logisim 复位准备失败：测试顶层需要唯一的 1 位 reset 输入。');
  }
  const libraries = new Map([...text.matchAll(/<lib\b[^>]*>/g)]
    .map(match => [attr(match[0], 'desc'), attr(match[0], 'name')]));
  const wiring = libraries.get('#Wiring');
  const memory = libraries.get('#Memory');
  const gates = libraries.get('#Gates');
  if (!wiring || !memory || !gates) throw new Error('Logisim 复位准备失败：缺少 Wiring、Memory 或 Gates 库。');
  const clocks = components.filter(comp => attr(comp, 'name') === 'Clock' && attr(comp, 'lib') === wiring);
  if (clocks.length !== 1) throw new Error('Logisim 复位准备失败：测试顶层需要唯一的内置 Clock。');

  const resetLoc = location(resets[0]);
  const clockLoc = location(clocks[0]);
  const locations = [...block.matchAll(/\((-?\d+),(-?\d+)\)/g)];
  const x = Math.ceil(Math.max(0, ...locations.map(match => Number(match[1]))) / 10) * 10 + 200;
  const y = Math.ceil(Math.max(0, ...locations.map(match => Number(match[2]))) / 10) * 10 + 200;
  let prefix = '__co_boot';
  while (text.includes(prefix)) prefix += '_';
  const component = (lib: string, name: string, cx: number, cy: number, settings: Record<string, string> = {}) =>
    `<comp lib="${lib}" name="${name}" loc="(${cx},${cy})">${Object.entries(settings)
      .map(([name, val]) => `<a name="${name}" val="${val}"/>`).join('')}</comp>`;
  const tunnel = (cx: number, cy: number, label: string) => component(wiring, 'Tunnel', cx, cy, { label });
  const generated = [
    tunnel(clockLoc.x, clockLoc.y, `${prefix}_clock`),
    component(memory, 'Register', x, y, { width: '1', trigger: 'falling' }),
    component(wiring, 'Constant', x - 30, y, { value: '0x1' }),
    component(wiring, 'Constant', x - 30, y + 10, { value: '0x1' }),
    component(wiring, 'Constant', x - 10, y + 20, { value: '0x0' }),
    tunnel(x - 20, y + 20, `${prefix}_clock`),
    `<wire from="(${x},${y})" to="(${x + 20},${y})"/>`,
    component(gates, 'NOT Gate', x + 50, y),
    tunnel(x + 50, y, `${prefix}_reset`),
    // Keep the private marker last in the CLI's location-sorted output columns.
    `<wire from="(${x + 50},${y})" to="(${x + 90},${y})"/>`,
    component(wiring, 'Pin', x + 90, y, { output: 'true', facing: 'west', label: `${prefix}_active` })
  ].join('\n');
  let updated = block.replace(resets[0], tunnel(resetLoc.x, resetLoc.y, `${prefix}_reset`));
  // Explicit appearances determine which pins the CLI sees. Remove the replaced
  // input port and expose the private marker alongside the original outputs.
  updated = updated.replace(/<appear\b[^>]*>[\s\S]*?<\/appear>/, appearance => appearance
    .replace(/<circ-port\b[^>]*\/>/g, port => attr(port, 'pin') === `${resetLoc.x},${resetLoc.y}` ? '' : port)
    .replace('</appear>', `<circ-port height="10" width="10" x="${x}" y="${y}" pin="${x + 90},${y}"/></appear>`));
  updated = updated.replace('</circuit>', `${generated}\n</circuit>`);
  const preparedText = text.slice(0, circuit.index) + updated + text.slice(circuit.index! + block.length);
  const columns = Object.fromEntries(Object.entries(traceSpec.required).map(([key, column]) => [key, column.index]));
  if (traceSpec.instruction) columns.instr = traceSpec.instruction.index;
  const preparedSpec = parseLogisimTraceSpec(preparedText, traceSpec.circuitName, { traceColumns: columns });
  const marker = preparedSpec.columns.find(column => column.label === `${prefix}_active`);
  if (!marker || marker.index !== traceSpec.columns.length) throw new Error('Logisim 复位准备失败：复位观察列顺序异常。');
  return { text: preparedText, traceSpec: { ...preparedSpec, resetColumn: marker.index }, applied: true };
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function setting(comp: string, name: string): string | undefined {
  const tag = [...comp.matchAll(/<a\b[^>]*>/g)].find(match => attr(match[0], 'name') === name)?.[0];
  return tag ? decode(attr(tag, 'val') ?? '') : undefined;
}

function location(comp: string): { x: number; y: number } {
  const loc = attr(comp, 'loc')?.match(/^\((-?\d+),(-?\d+)\)$/);
  if (!loc) throw new Error('Logisim 复位准备失败：reset 或 Clock 位置无效。');
  return { x: Number(loc[1]), y: Number(loc[2]) };
}

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

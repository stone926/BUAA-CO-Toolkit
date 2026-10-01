// @index formatting-structure — 线性结构索引、受控语句与分支状态
import { Source, FormatToken } from './source';
import { CoSettings } from '../../common/settings';
import { splitInstanceTokenGroup } from '../instanceSyntax';
import { proceduralStatementEnd } from '../proceduralBoundary';

export type Style = CoSettings['verilog']['format'];
export interface Structure {
  indent: number[];
  extra: number[];
  matching: Map<number, number>;
  list: Set<number>;
  listAnchor: Map<number, number>;
  modulePort: Set<number>;
  declarationRange: Set<number>;
  unary: Set<number>;
  rangeColon: Set<number>;
  labelColon: Set<number>;
  ternaryQuestion: Set<number>;
  preserve: Set<number>;
}
interface Block { kind: string; close: number; body: number; label?: boolean }
interface Delimiter { index: number; close: number; body: number }
interface State { blocks: Block[]; delimiters: Delimiter[]; continuation?: number; parameter?: number }
const opens: Record<string, string> = Object.assign(Object.create(null), { '(': ')', '[': ']', '{': '}', begin: 'end', case: 'endcase', casex: 'endcase', casez: 'endcase', module: 'endmodule', generate: 'endgenerate', function: 'endfunction', task: 'endtask', fork: 'join' });
const closes = new Set(Object.values(opens));
const controls = new Set(['if', 'for', 'while', 'repeat', 'wait']);
const declarations = new Set(['input', 'output', 'inout', 'wire', 'reg', 'tri', 'tri0', 'tri1', 'signed', 'unsigned', 'integer', 'parameter', 'localparam', 'function']);
const operators = new Set(['=', '?', ':', '+', '-', '*', '/', '%', '**', '&', '|', '^', '&&', '||', '==', '!=', '===', '!==', '<', '>', '<=', '>=', '<<', '>>', '<<<', '>>>']);
const isCode = (token: FormatToken): boolean => (!token.protected || !!token.structural) && token.kind !== 'comment';
const snapshot = (s: State): State => ({ ...s, blocks: s.blocks.map(b => ({ ...b })), delimiters: s.delimiters.map(d => ({ ...d })) });

export function analyzeStructure(source: Source, style: Style): Structure {
  const { tokens } = source;
  const result: Structure = { indent: tokens.map(() => 0), extra: tokens.map(() => 0), matching: new Map(), list: new Set(), listAnchor: new Map(), modulePort: new Set(), declarationRange: new Set(), unary: new Set(), rangeColon: new Set(), labelColon: new Set(), ternaryQuestion: new Set(), preserve: new Set() };
  const code = tokens.map((t, i) => isCode(t) ? i : -1).filter(i => i >= 0);
  const position = new Map(code.map((i, p) => [i, p]));
  const tokenIndex = new Map(tokens.map((token, i) => [token, i]));
  const stack: number[] = [];
  for (const i of code) {
    const v = tokens[i].value;
    if (opens[v]) stack.push(i);
    else if (closes.has(v)) {
      const last = stack[stack.length - 1];
      if (last !== undefined && opens[tokens[last].value] === v) {
        stack.pop(); result.matching.set(last, i); result.matching.set(i, last);
      } else if (v === 'endmodule') stack.length = 0;
    }
  }
  // 每个 token 的单条语句出口只计算一次，嵌套 if 不重复扫描后缀。
  const ends = new Map<number, number>();
  const next = (i: number): number => code[(position.get(i) ?? code.length) + 1] ?? tokens.length;
  const endAt = (i: number): number => ends.get(i) ?? tokens.length;
  const afterClose = (i: number): number => {
    const n = next(i);
    return tokens[n]?.value === ':' && tokens[next(n)]?.kind === 'identifier' ? next(next(n)) : n;
  };
  const bodyAt = (i: number): number => {
    const n = next(i);
    const close = result.matching.get(n);
    return tokens[n]?.value === '(' && close !== undefined ? next(close) : n;
  };
  for (let p = code.length - 1; p >= 0; p--) {
    const i = code[p]; const v = tokens[i].value; const n = next(i);
    let end = endAt(n);
    const close = result.matching.get(i);
    if (v === ';' || closes.has(v)) end = v === 'end' ? afterClose(i) : n;
    else if (close !== undefined && opens[v]) end = ['(', '[', '{'].includes(v) ? endAt(next(close)) : afterClose(close);
    else if (controls.has(v)) {
      end = endAt(bodyAt(i));
      if (v === 'if' && tokens[end]?.value === 'else') end = endAt(next(end));
    } else if (v === '@' || v === '#') {
      const body = tokens[n]?.value === '(' ? next(result.matching.get(n) ?? n) : next(n);
      end = endAt(body);
    }
    ends.set(i, end);
  }
  // 模块头与实例列表边界复用已有实例分组，按独立语句扫描而非扫描每个后缀。
  let statementStart = 0;
  for (let p = 0; p < code.length; p++) {
    const i = code[p]; const v = tokens[i].value;
    if (v === 'module') {
      let q = p + 1;
      for (; q < code.length && ![';', 'module', 'endmodule'].includes(tokens[code[q]].value); q++) {
        const j = code[q];
        if (tokens[j].value === '(') {
          result.list.add(j);
          result.listAnchor.set(j, i);
          const close = result.matching.get(j);
          if (tokens[code[q - 1]]?.value !== '#') {
            result.modulePort.add(j);
            if (close !== undefined) for (let r = q + 1; r < code.length && code[r] < close; r++) result.modulePort.add(code[r]);
          }
          if (close !== undefined) q = position.get(close) ?? q;
        }
      }
      statementStart = q + 1;
    }
    if (v === ';') {
      const segment = code.slice(statementStart, p + 1);
      const first = tokens[segment[0]];
      if (first?.kind === 'identifier' && segment.length > 2) {
        const group = splitInstanceTokenGroup(segment.map(j => tokens[j]));
        if (group) for (const declarator of group.declarators) {
          if (declarator[0]?.kind !== 'identifier') continue;
          const open = declarator.find(t => t.value === '(');
          if (open) {
            const j = tokenIndex.get(open as FormatToken);
            if (j !== undefined) { result.list.add(j); result.listAnchor.set(j, segment[0]); }
          }
        }
        if (tokens[segment[1]]?.value === '#' && tokens[segment[2]]?.value === '(') {
          result.list.add(segment[2]); result.listAnchor.set(segment[2], segment[0]);
        }
      }
      statementStart = p + 1;
    } else if (['end', 'endcase', 'endgenerate', 'begin', 'generate'].includes(v)) {
      // 命名块的标签不属于块内第一条声明或实例。
      statementStart = position.get(afterClose(i)) ?? code.length;
    }
  }
  const followingCode: number[] = [];
  let upcoming = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    followingCode[i] = upcoming;
    if (isCode(tokens[i])) upcoming = i;
  }
  let state: State = { blocks: [], delimiters: [] };
  const branches: Array<{ entry: State; exits: State[]; otherwise: boolean; bodyBase?: number; active: Array<{ end: number; indent: number }> }> = [];
  const bodyBase = new Map<number, number>();
  const bodyIndent = new Map<number, number>();
  const controlEnd = new Map<number, number>();
  const active: Array<{ end: number; indent: number }> = [];
  let previous: number | undefined;
  let declaration = false;
  let bracket = 0;
  const ternaryDepths = new Map<number, number>();
  let lastLine = -1;
  let lineIndent = 0;
  let uncertain = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]; const v = token.value;
    while (active.length && active[active.length - 1].end <= i) active.pop();
    if (token.protected && !token.structural) {
      if (v === '`ifdef' || v === '`ifndef') branches.push({ entry: snapshot(state), exits: [], otherwise: false, bodyBase: bodyBase.get(followingCode[i]), active: active.map(a => ({ ...a })) });
      else if (v === '`else' || v === '`elsif') {
        const branch = branches[branches.length - 1];
        if (branch) {
          branch.exits.push(snapshot(state)); state = snapshot(branch.entry); branch.otherwise ||= v === '`else';
          active.splice(0, active.length, ...branch.active.filter(a => a.end > i).map(a => ({ ...a })));
          // 每个互斥分支重新消费同一受控语句，而不是沿用前一分支的出口。
          const body = followingCode[i];
          if (branch.bodyBase !== undefined && body < tokens.length) {
            bodyBase.set(body, branch.bodyBase);
            bodyIndent.set(body, branch.bodyBase + (tokens[body].value === 'begin' ? 0 : 1));
            controlEnd.set(body, endAt(body));
          }
        }
      } else if (v === '`endif') {
        const branch = branches.pop();
        if (branch) {
          branch.exits.push(snapshot(state));
          if (!branch.otherwise) branch.exits.push(branch.entry);
          const key = (s: State): string => JSON.stringify({ blocks: s.blocks, delimiters: s.delimiters.map(d => ({ close: d.close, body: d.body })), continuation: s.continuation, parameter: s.parameter });
          const same = branch.exits.every(s => key(s) === key(branch.exits[0]));
          state = snapshot(same ? branch.exits[0] : branch.entry);
          // 缺少 else 时，隐式空分支可能仍等待 if 的语句；歧义尾部保守保留。
          uncertain ||= !same || !branch.otherwise && branch.bodyBase !== undefined;
          active.splice(0, active.length, ...branch.active.filter(a => a.end > i).map(a => ({ ...a })));
        }
      }
      continue;
    }
    if (uncertain) {
      if (['endmodule', 'module', 'always', 'initial', 'function', 'task', 'assign'].includes(v)) {
        uncertain = false;
        state = { blocks: v === 'module' ? [] : state.blocks.filter(block => block.kind === 'module'), delimiters: [] };
        active.length = 0;
      } else { result.preserve.add(i); continue; }
    }
    let base = state.blocks[state.blocks.length - 1]?.body ?? 0;
    if (active.length) base = Math.max(base, active[active.length - 1].indent);
    const scheduled = bodyIndent.get(i);
    if (scheduled !== undefined) {
      base = scheduled;
      const end = controlEnd.get(i);
      if (end !== undefined && end > i) active.push({ end, indent: base });
    }
    const isNewLine = token.line !== lastLine;
    const closeBlock = closes.has(v) && ![')', ']', '}'].includes(v);
    if (closeBlock && isCode(token)) {
      const b = state.blocks[state.blocks.length - 1];
      if (b && opens[b.kind] === v) { base = b.close; state.blocks.pop(); }
      else base = Math.max(0, base - 1);
      state.continuation = undefined; state.parameter = undefined;
    }
    const delimiter = state.delimiters[state.delimiters.length - 1];
    if (isNewLine && delimiter) base = ['(', '[', '{'].includes(v) || ![')', ']', '}'].includes(v) ? delimiter.body : delimiter.close;
    else if (isNewLine && !closeBlock && scheduled === undefined && state.continuation !== undefined) base = Math.max(base, state.continuation);
    const caseBlock = state.blocks[state.blocks.length - 1];
    if (isCode(token) && caseBlock && ['case', 'casex', 'casez'].includes(caseBlock.kind) && !delimiter && v !== 'else') {
      // 标签只在 case 项边界开始，冒号与括号、三元运算分别计数。
      let labelStart = false;
      if (!caseBlock.label && v !== 'endcase' && scheduled === undefined && (active[active.length - 1]?.indent ?? 0) <= caseBlock.close) {
        labelStart = true;
        let depth = 0; let questions = 0;
        const p = position.get(i) ?? 0;
        for (let q = p; q < code.length; q++) {
          const j = code[q]; const value = tokens[j].value;
          if (['(', '[', '{'].includes(value)) depth++;
          else if ([')', ']', '}'].includes(value)) depth--;
          if (depth === 0 && value === '?') questions++;
          if (depth === 0 && value === ':') {
            if (questions) questions--;
            else { result.labelColon.add(j); break; }
          }
          if (depth === 0 && [';', 'begin', 'endcase'].includes(value)) break;
        }
        caseBlock.label = true; caseBlock.body = caseBlock.close + 1;
      }
      base = labelStart ? caseBlock.body : Math.max(base, caseBlock.body);
    }
    if (isNewLine) { lineIndent = base; lastLine = token.line; }
    result.indent[i] = isNewLine || closeBlock || scheduled !== undefined ? base : lineIndent;
    if (isNewLine && state.parameter !== undefined && !delimiter && !closeBlock && previous !== undefined && tokens[previous].value === ',') result.extra[i] = state.parameter;
    if (!isCode(token)) continue;
    const pv = previous === undefined ? '' : tokens[previous].value;
    if ([';', 'begin', 'end'].includes(pv)) declaration = false;
    if (declarations.has(v)) declaration = true;
    if (v === '[') {
      bracket++;
      if (declaration) { result.declarationRange.add(i); const close = result.matching.get(i); if (close !== undefined) result.declarationRange.add(close); }
    }
    if (v === ']') bracket = Math.max(0, bracket - 1);
    if (declaration && bracket === 0 && token.kind === 'identifier') declaration = false;
    const expressionDepth = state.delimiters.length;
    if (v === '?') {
      ternaryDepths.set(expressionDepth, (ternaryDepths.get(expressionDepth) ?? 0) + 1);
      if (!delimiter) result.ternaryQuestion.add(i);
    }
    if (v === ':') {
      const count = ternaryDepths.get(expressionDepth) ?? 0;
      if (count) ternaryDepths.set(expressionDepth, count - 1);
      else if (bracket) result.rangeColon.add(i);
    }
    if (['!', '~', '+', '-', '&', '|', '^', '~&', '~|', '~^', '^~'].includes(v) && (previous === undefined || operators.has(pv) || ['(', '[', '{', ',', '#', '@', ';'].includes(pv))) result.unary.add(i);
    const tokenIndent = controls.has(v) || ['begin', 'case', 'casex', 'casez', 'generate', 'function', 'task', 'fork', 'always', 'initial', 'forever'].includes(v) ? base : result.indent[i];
    const schedule = (body: number, indent: number, end: number, branchBase?: number): void => {
      if (body < tokens.length) {
        bodyIndent.set(body, indent); controlEnd.set(body, end);
        if (branchBase !== undefined) bodyBase.set(body, branchBase);
      }
    };
    if (controls.has(v)) {
      const body = bodyAt(i);
      const bodyLevel = tokens[body]?.value === 'begin' || tokens[body]?.line === token.line ? tokenIndent : tokenIndent + 1;
      let end = endAt(body);
      schedule(body, bodyLevel, end, tokenIndent);
      if (v === 'if' && tokens[end]?.value === 'else') {
        schedule(end, tokenIndent, endAt(i));
        const alternate = next(end);
        schedule(alternate, tokens[alternate]?.value === 'if' || tokens[alternate]?.value === 'begin' || tokens[alternate]?.line === tokens[end].line ? tokenIndent : tokenIndent + 1, endAt(alternate));
      }
    } else if (['always', 'initial', 'forever', '@', '#'].includes(v)) {
      let body = next(i);
      if (v === '@' || v === '#') body = tokens[body]?.value === '(' ? next(result.matching.get(body) ?? body) : next(body);
      // 已有边界工具用于不完整事件控制的有界恢复；正常路径使用预计算出口。
      let end = endAt(body);
      if (end === tokens.length && body < tokens.length && code.length < 256) {
        const p = position.get(body) ?? 0;
        const local = code.slice(p).map(j => tokens[j]);
        const boundary = proceduralStatementEnd(local, 0);
        end = code[p + boundary] ?? tokens.length;
      }
      schedule(body, tokens[body]?.value === 'begin' || tokens[body]?.line === token.line ? tokenIndent : tokenIndent + 1, end, tokenIndent);
    }
    if (['(', '[', '{'].includes(v)) {
      const list = result.list.has(i);
      const anchor = result.listAnchor.get(i);
      const listIndent = anchor === undefined ? tokenIndent : result.indent[anchor];
      state.delimiters.push({ index: i, close: (list ? listIndent : tokenIndent) + (list ? 1 : 0), body: (list ? listIndent : tokenIndent) + style.continuationIndent });
    } else if ([')', ']', '}'].includes(v)) state.delimiters.pop();
    else if (opens[v]) {
      if (v === 'module') state.blocks.push({ kind: v, close: tokenIndent, body: tokenIndent + 1 });
      else state.blocks.push({ kind: v, close: tokenIndent, body: tokenIndent + 1 });
    }
    if ((result.labelColon.has(i) || v === 'default' && tokens[next(i)]?.value !== ':') && caseBlock) {
      if (tokens[next(i)]?.line > token.line) caseBlock.body = caseBlock.close + 2;
      state.continuation = undefined;
    }
    if (v === ';') {
      state.continuation = undefined; state.parameter = undefined; declaration = false;
      const b = state.blocks[state.blocks.length - 1];
      if (b && ['case', 'casex', 'casez'].includes(b.kind)) b.label = false;
    } else if (v === 'end') {
      const b = state.blocks[state.blocks.length - 1];
      if (b && ['case', 'casex', 'casez'].includes(b.kind)) b.label = false;
    }
    const following = tokens[next(i)];
    if (following?.line !== token.line && !state.delimiters.length && operators.has(v) && !result.labelColon.has(i)) state.continuation ??= tokenIndent + style.continuationIndent;
    if ((v === 'parameter' || v === 'localparam') && !state.delimiters.length) state.parameter = v.length + 1;
    previous = i;
  }
  return result;
}

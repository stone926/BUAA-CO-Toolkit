// @index preprocessor-state — source-preserving conditional and macro lifecycle validation
import { lexVerilog, VerilogToken } from './lexer';
import { verilogLanguageCatalog } from './model';
import { macroExpansionBreaksExpression } from './preprocessorExpressionContexts';

export const preprocessorDirectives = new Set(verilogLanguageCatalog.compilerDirectives);

export interface VerilogPreprocessorSource { uri: string; text: string }
/** Closed producer contract, also consumed by the generated diagnostic catalog. */
export type VerilogPreprocessorDiagnosticCode =
  | 'preprocessor-undefined-macro'
  | 'preprocessor-incomplete-expression'
  | 'preprocessor-missing-argument'
  | 'preprocessor-conditional-mismatch'
  | 'preprocessor-unclosed-conditional'
  | 'preprocessor-macro-arity'
  | 'preprocessor-invalid-default-nettype'
  | 'preprocessor-invalid-timescale'
  | 'preprocessor-invalid-define';
export interface VerilogPreprocessorIssue {
  uri: string; start: number; end: number; code: VerilogPreprocessorDiagnosticCode; message: string; severity: 'error' | 'warning';
}
export interface VerilogPreprocessorOptions {
  uri?: string;
  /** Already supplied command-line/configuration macros. Omitted values are object macros. */
  initialMacros?: ReadonlyMap<string, string | undefined>;
  /** Potential compilation-unit/configuration definitions, whose order is unknown. */
  externalMacroNames?: ReadonlySet<string>;
  unknownDependencies?: boolean;
  resolveInclude?: (path: string, fromUri: string) => VerilogPreprocessorSource | undefined;
  /** File-local parsers select branches without claiming to resolve compilation-unit headers. */
  followIncludes?: boolean;
  collectIssues?: boolean;
}
export interface VerilogPreprocessorResult {
  tokens: VerilogToken[];
  issues: VerilogPreprocessorIssue[];
  /** Tokens retain their original offsets; no expansion manufactures source positions. */
  tokenSources: ReadonlyMap<VerilogToken, { uri: string; start: number; end: number }>;
}
interface MacroDefinition { parameters?: string[]; body?: VerilogToken[] }
type Truth = boolean | undefined;
interface ConditionalFrame { parent: Truth; taken: Truth; active: Truth; seenElse: boolean; token: VerilogToken }
const netTypes = new Set(['wire', 'tri', 'tri0', 'tri1', 'wand', 'triand', 'wor', 'trior', 'trireg', 'supply0', 'supply1', 'uwire', 'none']);
const timeUnits = ['s', 'ms', 'us', 'ns', 'ps', 'fs'];

/** Preprocessor identifiers occupy their own namespace and may spell Verilog keywords. */
export function isVerilogMacroNameToken(token: VerilogToken | undefined): token is VerilogToken {
  return token?.kind === 'identifier' || token?.kind === 'keyword';
}

export function verilogDirectiveLineEnd(text: string, start: number, continuation = false): number {
  let end = text.indexOf('\n', start);
  while (end >= 0 && continuation && (text[end - 1] === '\\' || (text[end - 1] === '\r' && text[end - 2] === '\\'))) {
    end = text.indexOf('\n', end + 1);
  }
  return end < 0 ? text.length : end;
}

/** A single ordered traversal is shared by branch selection and preprocessor diagnostics. */
export function preprocessVerilogTokens(text: string, tokens: VerilogToken[], options: VerilogPreprocessorOptions = {}): VerilogPreprocessorResult {
  const issues: VerilogPreprocessorIssue[] = [];
  const definitions = new Map<string, MacroDefinition | null>();
  for (const [name, body] of options.initialMacros ?? []) definitions.set(name, { body: body === undefined ? [] : lexVerilog(body).tokens.filter((token) => token.kind !== 'eof') });
  let unknown = options.unknownDependencies ?? false;
  const includeStack = new Set<string>();
  const reported = new Set<string>();
  const rootUri = options.uri ?? '';
  const report = (uri: string, token: VerilogToken, code: VerilogPreprocessorDiagnosticCode, message: string, severity: 'error' | 'warning' = 'error') => {
    const key = JSON.stringify([uri, token.start, token.end, code, message]);
    if (options.collectIssues !== false && !reported.has(key)) {
      reported.add(key);
      issues.push({ uri, start: token.start, end: token.end, code, message, severity });
    }
  };
  const defined = (name: string): Truth => definitions.has(name) ? definitions.get(name) !== null
    : unknown || options.externalMacroNames?.has(name) ? undefined : false;
  const process = (source: string, sourceTokens: VerilogToken[], uri: string, inherited: Truth = true): VerilogToken[] => {
    const selected: VerilogToken[] = [];
    const stack: ConditionalFrame[] = [];
    const active = (): Truth => stack.length ? stack[stack.length - 1].active : inherited;
    for (let index = 0; index < sourceTokens.length; index++) {
      const token = sourceTokens[index];
      const name = token.kind === 'directive' ? token.value.slice(1) : undefined;
      if (!name || !preprocessorDirectives.has(name)) {
        if (active() !== false || token.kind === 'eof') selected.push(token);
        if (name && active() === true && options.collectIssues !== false) {
          const budget = { remaining: 4096 };
          const missing: Array<{ token: VerilogToken; name: string }> = [];
          const expanded = expandMacroInvocation(sourceTokens, index, token, [], budget, missing);
          const incomplete = macroExpansionBreaksExpression(sourceTokens, index, expanded.tokens, expanded.end);
          for (const unresolved of missing) {
            report(uri, unresolved.token, 'preprocessor-undefined-macro', `Macro '${unresolved.name}' is not defined at this invocation.`,
              incomplete ? 'error' : 'warning');
          }
          if (!missing.length && incomplete) report(uri, token, 'preprocessor-incomplete-expression', `Expansion of macro '${name}' leaves an incomplete expression.`);
        }
        continue;
      }
      const end = verilogDirectiveLineEnd(source, token.end, name === 'define');
      const argument = sourceTokens[index + 1]?.start < end && sourceTokens[index + 1]?.kind !== 'eof' ? sourceTokens[index + 1] : undefined;
      const condition = name === 'ifdef' || name === 'ifndef' || name === 'elsif';
      if (condition && !isVerilogMacroNameToken(argument)) {
        report(uri, token, 'preprocessor-missing-argument', `Directive \`${name} requires a macro name.`);
      }
      if (name === 'ifdef' || name === 'ifndef') {
        const match = defined(argument?.value ?? '');
        const truth = name === 'ifndef' ? negate(match) : match;
        const parent = active();
        stack.push({ parent, taken: truth, active: and(parent, truth), seenElse: false, token });
      } else if (name === 'elsif' || name === 'else') {
        const frame = stack[stack.length - 1];
        if (!frame || frame.seenElse) {
          report(uri, token, 'preprocessor-conditional-mismatch', !frame ? `Directive \`${name} has no matching \`ifdef or \`ifndef.` : `Directive \`${name} cannot follow \`else.`);
        } else {
          const match = name === 'else' ? true : defined(argument?.value ?? '');
          frame.active = and(frame.parent, and(negate(frame.taken), match));
          frame.taken = or(frame.taken, match);
          frame.seenElse = name === 'else';
        }
      } else if (name === 'endif') {
        if (!stack.pop()) report(uri, token, 'preprocessor-conditional-mismatch', 'Directive `endif has no matching `ifdef or `ifndef.');
      } else if (active() !== false) {
        const certain = active() === true;
        if (certain && options.collectIssues !== false) validateDirective(sourceTokens, index, end, name, (anchor, code, message) => report(uri, anchor, code, message));
        if (name === 'define' && isVerilogMacroNameToken(argument)) {
          const next = sourceTokens[index + 2];
          let parameters: string[] | undefined;
          let bodyStart = index + 2;
          if (next?.value === '(' && next.start === argument.end) {
            const call = macroArguments(sourceTokens, index + 2);
            if (call && call.end <= end) {
              parameters = call.arguments.map((parts) => parts.map((part) => part.value).join(''));
              bodyStart = call.endIndex + 1;
            }
          }
          const body: VerilogToken[] = [];
          if (options.collectIssues !== false) {
            for (let offset = bodyStart; sourceTokens[offset]?.start < end; offset++) {
              if (sourceTokens[offset].value !== '\\') body.push(sourceTokens[offset]);
            }
          }
          if (certain) definitions.set(argument.value, { parameters, body });
          else { definitions.delete(argument.value); unknown = true; }
        } else if (name === 'undef' && isVerilogMacroNameToken(argument)) {
          if (certain) definitions.set(argument.value, null);
          else { definitions.delete(argument.value); unknown = true; }
        } else if (name === 'undefineall') {
          definitions.clear(); unknown = !certain;
        } else if (name === 'include' && options.followIncludes !== false) {
          const path = argument?.kind === 'string' ? argument.value.slice(1, -1) : undefined;
          const included = path === undefined ? undefined : options.resolveInclude?.(path, uri);
          if (!included || includeStack.has(included.uri) || includeStack.size >= 64) {
            // An unresolved header may define, undefine or replace any macro.
            definitions.clear(); unknown = true;
          } else {
            includeStack.add(included.uri);
            process(included.text, lexVerilog(included.text).tokens, included.uri, active());
            includeStack.delete(included.uri);
          }
        }
        selected.push(token);
        if (name === 'define') {
          while (sourceTokens[index + 1]?.start < end) selected.push(sourceTokens[++index]);
          continue;
        }
        continue;
      }
      if (name === 'define') {
        while (sourceTokens[index + 1]?.start < end) index++;
      } else if (argument && condition) index++;
    }
    for (const frame of stack) report(uri, frame.token, 'preprocessor-unclosed-conditional', 'Conditional compilation directive is missing `endif.');
    return selected;

    function expandMacroInvocation(parts: VerilogToken[], at: number, origin: VerilogToken, chain: string[], budget: { remaining: number },
      missing: Array<{ token: VerilogToken; name: string }>): { tokens: VerilogToken[]; end: number } {
      const invocation = parts[at];
      const macroName = invocation.value.slice(1);
      const anchor = chain.length ? origin : invocation;
      const definition = definitions.get(macroName);
      if (--budget.remaining < 0 || chain.length >= 64 || chain.includes(macroName)) return { tokens: [invocation], end: at };
      if (defined(macroName) === false) {
        missing.push({ token: anchor, name: macroName });
        return { tokens: [], end: at };
      }
      if (!definition) return { tokens: [invocation], end: at };
      const call = definition.parameters ? macroArguments(parts, at + 1) : undefined;
      if (definition.parameters && (!call || call.count !== definition.parameters.length)) {
        report(uri, anchor, 'preprocessor-macro-arity', `Macro '${macroName}' expects ${definition.parameters.length} argument(s), but ${call ? call.count : 0} were supplied.`);
        return { tokens: [invocation], end: at };
      }
      // Token pasting and macro quoting require a character-level replacement pass.
      // Keep those bodies opaque rather than interpreting a bare backtick as a macro.
      if (definition.body?.some((part) => part.kind === 'directive' && part.value === '`')) {
        return { tokens: [invocation], end: call?.endIndex ?? at };
      }
      const actuals = new Map(definition.parameters?.map((parameter, argument) => [parameter, call!.arguments[argument]]));
      const body: VerilogToken[] = [];
      for (const part of definition.body ?? [invocation]) {
        const replacement = isVerilogMacroNameToken(part) ? actuals.get(part.value) : undefined;
        if (body.length + (replacement?.length ?? 1) > budget.remaining) return { tokens: [invocation], end: call?.endIndex ?? at };
        if (replacement) body.push(...replacement);
        else body.push(part);
      }
      const result: VerilogToken[] = [];
      for (let offset = 0; offset < body.length; offset++) {
        const part = body[offset];
        if (--budget.remaining < 0) { result.push(...body.slice(offset)); break; }
        if (part.kind === 'directive' && !preprocessorDirectives.has(part.value.slice(1))) {
          const nested = expandMacroInvocation(body, offset, anchor, [...chain, macroName], budget, missing);
          result.push(...nested.tokens);
          offset = nested.end;
        } else result.push(part);
      }
      return { tokens: result, end: call?.endIndex ?? at };
    }
  };
  includeStack.add(rootUri);
  const selected = process(text, tokens, rootUri);
  return { tokens: selected, issues, tokenSources: new Map(selected.map((token) => [token, { uri: rootUri, start: token.start, end: token.end }])) };
}

function and(left: Truth, right: Truth): Truth { return left === false || right === false ? false : left === undefined || right === undefined ? undefined : true; }
function or(left: Truth, right: Truth): Truth { return left === true || right === true ? true : left === undefined || right === undefined ? undefined : false; }
function negate(value: Truth): Truth { return value === undefined ? undefined : !value; }

function macroArguments(tokens: VerilogToken[], start: number): { count: number; end: number; endIndex: number; arguments: VerilogToken[][] } | undefined {
  if (tokens[start]?.value !== '(') return undefined;
  const args: VerilogToken[][] = [[]];
  const closing: string[] = [')'];
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'eof') return undefined;
    if (token.value === closing[closing.length - 1]) {
      closing.pop();
      if (!closing.length) {
        // F() supplies one empty actual argument, accepted by Verilog-2005.
        return { count: args.length, arguments: args, end: token.end, endIndex: index };
      }
    } else if (token.value === ',' && closing.length === 1) { args.push([]); continue; }
    else if (['(', '[', '{'].includes(token.value)) closing.push(token.value === '(' ? ')' : token.value === '[' ? ']' : '}');
    args[args.length - 1].push(token);
  }
  return undefined;
}

function validateDirective(tokens: VerilogToken[], index: number, end: number, name: string,
  report: (token: VerilogToken, code: VerilogPreprocessorDiagnosticCode, message: string) => void): void {
  const directive = tokens[index];
  const args: VerilogToken[] = [];
  for (let offset = index + 1; tokens[offset]?.start < end && tokens[offset].kind !== 'eof'; offset++) args.push(tokens[offset]);
  const requiredName = ['define', 'undef'].includes(name);
  const requiredString = ['include', 'begin_keywords'].includes(name);
  if ((requiredName && !isVerilogMacroNameToken(args[0])) || (requiredString && args[0]?.kind !== 'string') ||
    (['timescale', 'default_nettype', 'unconnected_drive', 'line'].includes(name) && !args.length)) {
    report(directive, 'preprocessor-missing-argument', `Directive \`${name} requires ${requiredName ? 'a macro name' : requiredString ? 'a quoted string' : 'an argument'}.`);
    return;
  }
  if (name === 'default_nettype' && !netTypes.has(args[0].value)) {
    report(args[0], 'preprocessor-invalid-default-nettype', `Invalid default net type '${args[0].value}'.`);
  } else if (name === 'timescale' && !args.some((token) => token.kind === 'directive')) {
    const slash = args.findIndex((token) => token.value === '/');
    const unit = timeValue(args.slice(0, slash < 0 ? args.length : slash));
    const precision = slash < 0 ? undefined : timeValue(args.slice(slash + 1, slash + 3));
    if (unit === undefined || precision === undefined || precision > unit) {
      report(args[0], 'preprocessor-invalid-timescale', 'Timescale requires 1, 10 or 100 followed by s/ms/us/ns/ps/fs, with precision no larger than the time unit.');
    }
  } else if (name === 'define' && args[1]?.value === '(' && args[1].start === args[0].end) {
    const parameters = macroArguments(args, 1);
    if (!parameters || parameters.end > end || parameters.arguments.some((parts) => parts.length !== 1 || !isVerilogMacroNameToken(parts[0])) ||
      new Set(parameters.arguments.map((parts) => parts[0]?.value)).size !== parameters.count) {
      report(args[0], 'preprocessor-invalid-define', 'Function-like macro requires a closed list of distinct parameter names.');
    }
  }
}

function timeValue(tokens: VerilogToken[]): number | undefined {
  if (tokens.length !== 2 || !['1', '10', '100'].includes(tokens[0].value)) return undefined;
  const exponent = timeUnits.indexOf(tokens[1].value);
  return exponent < 0 ? undefined : Number(tokens[0].value) * 10 ** (-3 * exponent);
}

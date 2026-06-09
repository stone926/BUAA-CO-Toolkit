import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { VerilogCstDocument, VerilogCstStatement } from './cst';
import { VerilogToken, VerilogTokenKind } from './lexer';
import { VerilogModule, verilogKeywords } from './model';

// ============================================================================
// 基于 IEEE 1364-2001 BNF 语法的语句级语法验证器
//
// 设计原则：
//   每个验证函数对应一条 BNF 语法规则。
//   验证器通过 TokenCursor 按语法规则消费 token 序列。
//   当 token 与语法规则不匹配时，报告「期望 X，但找到 Y」。
//   表达式部分使用平衡跳过策略（跟踪 ()、[]、{} 深度）。
//
// 参考标准：IEEE Std 1364-2001, Annex A (Formal Syntax Definition)
// ============================================================================

// ============================================================================
// TokenCursor — 带深度跟踪的 token 导航器
// ============================================================================

class TokenCursor {
  readonly tokens: VerilogToken[];
  private _pos: number;

  constructor(tokens: VerilogToken[], pos: number = 0) {
    this.tokens = tokens;
    this._pos = pos;
  }

  get pos(): number {
    return this._pos;
  }

  /** 当前位置的 token，超出范围返回 undefined */
  current(): VerilogToken | undefined {
    return this._pos < this.tokens.length ? this.tokens[this._pos] : undefined;
  }

  /** 向前看 n 个 token（不移动位置） */
  peek(offset: number = 0): VerilogToken | undefined {
    const index = this._pos + offset;
    return index < this.tokens.length ? this.tokens[index] : undefined;
  }

  /** 移动到下一个 token，返回被跳过的 token */
  advance(): VerilogToken | undefined {
    const token = this.current();
    if (token) {
      this._pos++;
    }
    return token;
  }

  /** 保存当前位置，用于回溯 */
  save(): number {
    return this._pos;
  }

  /** 恢复到之前保存的位置 */
  restore(pos: number): void {
    this._pos = pos;
  }

  /** token 序列是否已消费完毕 */
  isAtEnd(): boolean {
    return this._pos >= this.tokens.length;
  }

  // ---- 深度感知导航 ----

  /**
   * 跳过表达式。
   *
   * 从当前位置开始，平衡地消费 token 直到遇到以下情况之一：
   *   - 在顶层遇到 ','、';'、')'、']'、'}'、end、endcase 等
   *   - token 序列结束
   *
   * 调用后，cursor 停在分隔符之前的 token 位置。
   */
  skipExpression(): void {
    let paren = 0;
    let bracket = 0;
    let brace = 0;

    // 收集跳过的 token 用于在遇到分隔符时停止
    while (!this.isAtEnd()) {
      const token = this.current()!;

      if (token.value === '(') {
        paren++;
      } else if (token.value === ')') {
        if (paren === 0) {
          // 顶层 ')' — 属于外层结构，停止
          return;
        }
        paren--;
      } else if (token.value === '[') {
        bracket++;
      } else if (token.value === ']') {
        if (bracket === 0) {
          return;
        }
        bracket--;
      } else if (token.value === '{') {
        brace++;
      } else if (token.value === '}') {
        if (brace === 0) {
          return;
        }
        brace--;
      } else if (paren === 0 && bracket === 0 && brace === 0) {
        // 顶层遇到以下 token 说明表达式结束
        if (
          token.value === ',' ||
          token.value === ';' ||
          token.value === ')' ||
          token.value === ']' ||
          token.value === '}' ||
          token.value === ':' ||
          token.value === '?' ||
          this.isBlockBoundary(token.value)
        ) {
          return;
        }
      }

      this.advance();
    }
  }

  /**
   * 在顶层寻找特定运算符并跳过到该位置之前。
   *
   * 用于在表达式中定位关键运算符（如赋值中的 '='）。
   * 返回找到的运算符索引；如果未找到则返回 -1 且不移动 cursor。
   *
   * 注意：会跳过 expression 到达运算符，但不会消费运算符本身。
   */
  findTopLevelOperator(): number {
    const saved = this.save();
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    let operandCount = 0;

    while (!this.isAtEnd()) {
      const token = this.current()!;

      if (token.value === '(') {
        paren++;
      } else if (token.value === ')') {
        if (paren > 0) {
          paren--;
        } else {
          break; // 顶层 ')' 不属于此表达式
        }
      } else if (token.value === '[') {
        bracket++;
      } else if (token.value === ']') {
        if (bracket > 0) {
          bracket--;
        } else {
          break;
        }
      } else if (token.value === '{') {
        brace++;
      } else if (token.value === '}') {
        if (brace > 0) {
          brace--;
        } else {
          break;
        }
      } else if (paren === 0 && bracket === 0 && brace === 0) {
        // 顶层
        if (token.value === ',' || token.value === ';' || this.isBlockBoundary(token.value)) {
          break;
        }
        if (token.kind === 'operator') {
          if (operandCount > 0) {
            // 找到第一个运算符（已经跳过至少一个操作数）
            const opPos = this._pos;
            this.restore(saved);
            return opPos;
          }
        } else if (isValueToken(token)) {
          operandCount++;
        }
      }

      this.advance();
    }

    this.restore(saved);
    return -1;
  }

  /**
   * 跳过表达式直到顶层遇到指定 token 值。
   * 消费该终止 token（或停在它前面取决于 consumeStopToken）。
   */
  skipUntilTopLevel(stopValues: Set<string>, consumeStop: boolean = false): void {
    let paren = 0;
    let bracket = 0;
    let brace = 0;

    while (!this.isAtEnd()) {
      const token = this.current()!;

      if (token.value === '(') {
        paren++;
      } else if (token.value === ')') {
        if (paren > 0) {
          paren--;
        } else {
          if (stopValues.has(')')) {
            if (consumeStop) this.advance();
            return;
          }
          // 顶层的 ')' 不属于我们 — 停止
          return;
        }
      } else if (token.value === '[') {
        bracket++;
      } else if (token.value === ']') {
        if (bracket > 0) {
          bracket--;
        } else {
          if (stopValues.has(']')) {
            if (consumeStop) this.advance();
            return;
          }
          return;
        }
      } else if (token.value === '{') {
        brace++;
      } else if (token.value === '}') {
        if (brace > 0) {
          brace--;
        } else {
          if (stopValues.has('}')) {
            if (consumeStop) this.advance();
            return;
          }
          return;
        }
      } else if (paren === 0 && bracket === 0 && brace === 0) {
        if (stopValues.has(token.value)) {
          if (consumeStop) this.advance();
          return;
        }
      }

      this.advance();
    }
  }

  /**
   * 在顶层匹配一个具体的 token 值。
   * 成功返回 null，失败返回错误描述。
   */
  matchToken(expectedValue: string): string | null {
    const token = this.current();
    if (!token) {
      return `期望 '${expectedValue}'，但语句已结束`;
    }
    if (token.value !== expectedValue) {
      return `期望 '${expectedValue}'，但找到 '${token.value}'`;
    }
    this.advance();
    return null;
  }

  /**
   * 在顶层匹配一个 token 种类。
   * 成功返回 null，失败返回错误描述。
   */
  matchKind(expectedKind: VerilogTokenKind, description: string): string | null {
    const token = this.current();
    if (!token) {
      return `期望 ${description}，但语句已结束`;
    }
    if (token.kind !== expectedKind) {
      return `期望 ${description}，但找到 '${token.value}'`;
    }
    this.advance();
    return null;
  }

  // ---- 辅助方法 ----

  /** 判断当前 token 是否在顶层的指定值 */
  currentIs(value: string): boolean {
    const token = this.current();
    return token !== undefined && token.value === value;
  }

  /** 判断 token 值是否是块边界关键词 */
  private isBlockBoundary(value: string): boolean {
    return value === 'end' || value === 'endcase' || value === 'endmodule' ||
           value === 'endfunction' || value === 'endtask' || value === 'endgenerate' ||
           value === 'join' || value === 'join_any' || value === 'join_none' ||
           value === 'else';
  }
}

/** 可出现在表达式中的"值"类 token */
function isValueToken(token: VerilogToken): boolean {
  return (
    token.kind === 'identifier' ||
    token.kind === 'keyword' ||
    token.kind === 'number' ||
    token.kind === 'string' ||
    token.kind === 'systemIdentifier'
  );
}

// ============================================================================
// 语法规则验证器
//
// 每个函数对应 IEEE 1364-2001 附录 A 中的一条 BNF 规则。
// 错误消息使用中文描述，引用对应的语法规则。
// ============================================================================

// ---- 语句分类 ----

/** 声明关键词（module_item 中以关键词开头的声明） */
const declarationKeywords = new Set([
  'input', 'output', 'inout', 'wire', 'reg', 'logic',
  'integer', 'real', 'realtime', 'time',
  'parameter', 'localparam', 'genvar'
]);

/** 网络类型关键词 */
const netTypes = new Set([
  'wire', 'tri', 'tri0', 'tri1', 'supply0', 'supply1',
  'wand', 'wor', 'triand', 'trior', 'trireg'
]);

/** 端口方向关键词 */
const portDirections = new Set(['input', 'output', 'inout']);

/** IEEE 1364-2001 门级原语关键词 */
const gatePrimitives = new Set([
  'and', 'nand', 'or', 'nor', 'xor', 'xnor',
  'buf', 'bufif0', 'bufif1', 'not', 'notif0', 'notif1',
  'nmos', 'pmos', 'cmos', 'rnmos', 'rpmos', 'rcmos',
  'tran', 'tranif0', 'tranif1', 'rtran', 'rtranif0', 'rtranif1',
  'pullup', 'pulldown'
]);

/** 仅在过程块内合法的关键词（在模块体顶层出现则为错误） */
const proceduralOnlyKeywords = new Set([
  'if', 'case', 'casex', 'casez', 'else',
  'for', 'while', 'forever', 'repeat',
  'disable', 'wait', 'fork', 'deassign', 'force', 'release'
]);

/** 合法的模块体顶层结构关键词（不会被上面的 dispatch 捕获的） */
const topLevelBlockKeywords = new Set([
  'module', 'endmodule', 'begin', 'end', 'endcase',
  'endfunction', 'endtask', 'endgenerate', 'join', 'join_any', 'join_none',
  'generate', 'function', 'task', 'specify', 'defparam', 'event'
]);

/** 综合所有已知合法首 token */
const allKnownFirstTokens = new Set([
  ...declarationKeywords,
  ...gatePrimitives,
  ...portDirections,
  ...proceduralOnlyKeywords,
  ...topLevelBlockKeywords,
  'assign', 'always', 'initial'
]);

// ============================================================================
// 入口：遍历 CST 语句并按语法规则分发验证
// ============================================================================

export function collectStatementSyntaxDiagnostics(
  document: TextDocument,
  cst: VerilogCstDocument,
  modules: VerilogModule[],
  diagnostics: Diagnostic[]
): void {
  // 先找出哪些 CST 语句位于过程块内部。
  // CST 中的 'begin' 打开过程上下文，后续语句直到 'end' 都在过程块内。
  const proceduralRanges = collectProceduralRanges(cst);
  const isProcedural = (statement: VerilogCstStatement): boolean =>
    proceduralRanges.some(r => statement.start >= r.start && statement.end <= r.end);

  for (const statement of cst.statements) {
    const tokens = trimStatement(statement.tokens);
    if (!tokens.length) continue;

    // 验证语句中的所有数字字面量（在任何上下文中）
    for (const token of tokens) {
      if (token.kind === 'number') {
        validateNumberLiteral(document, token, diagnostics);
      }
    }

    const containingModule = findContainingModule(statement, modules, document);
    const cursor = new TokenCursor(tokens);
    const first = cursor.current()!;

    // 如果语句在过程块内部，使用过程语句验证
    if (isProcedural(statement)) {
      validateProceduralStatement(document, cursor, diagnostics);
      continue;
    }

    // ---- 模块体顶层语句：必须匹配某条 module_item 语法规则 ----

    if (first.value === 'assign') {
      // IEEE 1364-2001 A.5: continuous_assign
      validateContinuousAssign(document, cursor, diagnostics);
    } else if (first.value === 'always' || first.value === 'initial') {
      // IEEE 1364-2001 A.7: always_construct / initial_construct
      validateProceduralConstruct(document, cursor, diagnostics);
    } else if (portDirections.has(first.value)) {
      // IEEE 1364-2001 A.4: input_declaration / output_declaration / inout_declaration
      validatePortDeclaration(document, cursor, diagnostics);
    } else if (netTypes.has(first.value)) {
      // IEEE 1364-2001 A.4: net_declaration
      validateNetDeclaration(document, cursor, diagnostics);
    } else if (first.value === 'reg' || first.value === 'logic') {
      // IEEE 1364-2001 A.4: reg_declaration
      validateRegDeclaration(document, cursor, diagnostics);
    } else if (first.value === 'integer' || first.value === 'genvar') {
      // IEEE 1364-2001 A.4: integer_declaration / genvar_declaration
      validateSimpleDecl(document, cursor, diagnostics);
    } else if (first.value === 'parameter' || first.value === 'localparam') {
      // IEEE 1364-2001 A.4: parameter_declaration / localparam_declaration
      validateParameterDeclaration(document, cursor, diagnostics);
    } else if (first.value === 'real' || first.value === 'realtime' || first.value === 'time') {
      // IEEE 1364-2001 A.4: real_declaration / time_declaration
      validateSimpleDecl(document, cursor, diagnostics);
    } else if (gatePrimitives.has(first.value)) {
      // IEEE 1364-2001 A.6: gate_instantiation
      validateGateInstance(document, cursor, diagnostics);
    } else if (proceduralOnlyKeywords.has(first.value)) {
      // 过程性关键词出现在模块体顶层 → 语法错误
      diagnostics.push(makeDiagnostic(
        rangeOf(document, first),
        `语法错误：'${first.value}' 语句只能出现在 always/initial 过程块内部，不能直接放在模块体顶层。`,
        DiagnosticSeverity.Error,
        'syntax-procedural-keyword-at-top-level'
      ));
    } else if (topLevelBlockKeywords.has(first.value)) {
      // 模块级结构关键词（begin, end, generate, function, task 等）
      // 这些由其他检查处理（块平衡、模块解析等），不在此报错
    } else if (
      containingModule &&
      first.kind === 'identifier' &&
      !verilogKeywords.has(first.value) &&
      first.value !== containingModule.name &&
      looksLikeInstance(cursor)
    ) {
      // IEEE 1364-2001 A.6: module_instantiation
      validateModuleInstance(document, cursor, diagnostics);
    } else if (containingModule && first.kind !== 'directive') {
      // 模块体内无法识别的语句
      diagnostics.push(makeDiagnostic(
        rangeOf(document, first),
        `语法错误：无法识别的语句 '${first.value}'。模块体内只允许声明（wire/reg/input/output/parameter 等）、连续赋值（assign）、模块/门实例化、always/initial 块。`,
        DiagnosticSeverity.Error,
        'syntax-unrecognized-module-item'
      ));
    }
  }
}

// ============================================================================
// A.5 连续赋值: assign [strength] [delay] net_assignment { , net_assignment } ;
//   net_assignment ::= net_lvalue = expression
// ============================================================================

function validateContinuousAssign(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  // 消费 'assign'
  cursor.advance();

  // 跳过可选的 drive_strength 和 delay3（实际课程代码中罕见）
  // drive_strength: ( strength0 , strength1 ) | ( strength1 , strength0 ) | ...
  // delay3: # delay_value | # ( delay_value ) | ...
  // 简化处理：如果看到 '(' 或 '#' 且后面没有 lvalue，尝试跳过
  if (cursor.currentIs('(')) {
    // 可能是 drive_strength，跳过到匹配的 ')'
    cursor.advance();
    cursor.skipUntilTopLevel(new Set([')']), true);
  }
  if (cursor.currentIs('#')) {
    cursor.advance();
    if (cursor.currentIs('(')) {
      cursor.advance();
      cursor.skipUntilTopLevel(new Set([')']), true);
    } else {
      // 简单的 #delay_value
      cursor.advance(); // 跳过数字
    }
  }

  // 验证一个或多个 net_assignment（以 ',' 分隔）
  validateNetAssignment(document, cursor, diagnostics);

  while (cursor.currentIs(',')) {
    cursor.advance(); // 消费 ','
    validateNetAssignment(document, cursor, diagnostics);
  }
}

/**
 * 验证 net_assignment ::= net_lvalue = expression
 *
 * 核心检查：在 lvalue 之后，语法要求 '='。如果找到其他运算符，
 * 报告语法期望与实际不符。
 */
function validateNetAssignment(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  if (cursor.isAtEnd()) return;

  const startToken = cursor.current()!;

  // 检查空左值：assign = expr;  — 第一个 token 就是运算符
  if (startToken.kind === 'operator') {
    diagnostics.push(makeDiagnostic(
      rangeOf(document, startToken),
      `语法错误：赋值语句缺少左值（lvalue）。期望一个标识符或拼接，但找到运算符 '${startToken.value}'。`,
      DiagnosticSeverity.Error,
      'syntax-missing-lvalue'
    ));
    cursor.advance();
    cursor.skipExpression();
    return;
  }

  // 在当前 token 序列中查找顶层运算符（=、<= 等）
  // findTopLevelOperator 从当前 cursor 位置开始，跳过 lvalue（作为操作数），
  // 然后返回找到的第一个顶层运算符的位置索引
  const assignStart = cursor.save();
  const opPos = cursor.findTopLevelOperator();

  if (opPos < 0) {
    // 没有找到运算符 — 可能是纯声明（无初始化）或不完整语句
    cursor.restore(assignStart);
    cursor.skipExpression();
    return;
  }

  // findTopLevelOperator 已将 cursor 恢复到调用前位置
  // 移动到运算符 token
  while (cursor.pos < opPos) {
    cursor.advance();
  }

  const operatorToken = cursor.current();
  if (!operatorToken) {
    return;
  }

  if (operatorToken.value === '=') {
    // 正确的赋值运算符 — 消费 '='，跳过 RHS expression
    cursor.advance();
    // 检查空右值：assign a = ;  — '=' 后面立即是 ',' 或语句结束
    if (cursor.isAtEnd() || cursor.current()!.value === ',' || cursor.current()!.value === ';') {
      diagnostics.push(makeDiagnostic(
        rangeOf(document, operatorToken),
        `语法错误：赋值语句缺少右值（expression）。'=' 后面需要一个表达式。`,
        DiagnosticSeverity.Error,
        'syntax-missing-rvalue'
      ));
    } else {
      cursor.skipExpression();
    }
  } else {
    // 语法期望 '='，但找到其他运算符
    const errorDetail = operatorToken.value === '<='
      ? `不能使用 '<='，非阻塞赋值仅在 always/initial 过程块内合法`
      : `找到 '${operatorToken.value}'，你可能误用了比较或复合赋值运算符`;
    diagnostics.push(makeDiagnostic(
      rangeOf(document, operatorToken),
      `语法错误：连续赋值语句期望 '='（赋值运算符），但${errorDetail}。`,
      DiagnosticSeverity.Error,
      'syntax-continuous-assign-operator'
    ));
    cursor.advance();
    cursor.skipExpression();
  }
}

// ============================================================================
// A.6 模块实例化
//   module_instantiation ::= module_identifier [ #(params) ] instance { , instance } ;
//   instance ::= name_of_instance ( [list_of_module_connections] )
//   list_of_module_connections ::= ordered { , ordered } | named { , named }
//   named_port_connection ::= .port_identifier ( [expression] )
//   ordered_port_connection ::= [expression]
// ============================================================================

function validateModuleInstance(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  // 跳过 module_identifier
  cursor.advance();

  // 跳过 name_of_instance（实例名）
  const instanceToken = cursor.current();
  if (instanceToken && (instanceToken.kind === 'identifier' || instanceToken.kind === 'keyword')) {
    cursor.advance();
  } else {
    // 不是合法的实例名，不继续验证
    return;
  }

  // 可能的位选 [range] on instance name
  if (cursor.currentIs('[')) {
    cursor.advance();
    cursor.skipUntilTopLevel(new Set([']']), true);
  }

  // 跳过可选的参数覆盖 #( ... )
  if (cursor.currentIs('#')) {
    cursor.advance();
    if (cursor.currentIs('(')) {
      cursor.advance();
      cursor.skipUntilTopLevel(new Set([')']), true);
    }
  }

  // 期望 '(' 开始端口连接列表
  if (!cursor.currentIs('(')) {
    // 可能是无端口实例: M inst ;
    return;
  }
  cursor.advance(); // 消费 '('

  // 验证端口连接列表
  if (!cursor.currentIs(')') && !cursor.isAtEnd()) {
    validatePortConnectionList(document, cursor, diagnostics);
  }

  // 期望 ')' 闭合端口列表
  if (cursor.currentIs(')')) {
    cursor.advance();
  }
}

/**
 * 验证端口连接列表。
 *
 * 语法：
 *   list_of_module_connections ::= ordered_port_connection { , ordered_port_connection }
 *                                | named_port_connection { , named_port_connection }
 *
 * 核心检查：
 *   1. 连接项必须用 ',' 分隔
 *   2. 不能混用命名连接（.name(expr)）和位置连接（expr）
 */
function validatePortConnectionList(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  // 先扫描整体：判断是命名还是位置连接风格，同时检测缺逗号
  const items = splitConnectionItems(cursor);

  // 检测混用风格
  const namedItems = items.filter(item => item.style === 'named');
  const positionalItems = items.filter(item => item.style === 'positional');

  if (namedItems.length > 0 && positionalItems.length > 0) {
    // 报告混用错误，定位到第一个冲突连接
    const firstNamed = items.findIndex(item => item.style === 'named');
    const firstPositional = items.findIndex(item => item.style === 'positional');
    const conflictIndex = Math.max(firstNamed, firstPositional);
    const conflictItem = items[conflictIndex];
    if (conflictItem) {
      diagnostics.push(makeDiagnostic(
        rangeFromTokens(document, conflictItem.tokens),
        `语法错误：模块实例端口连接不能混用命名连接（.name(expr)）和位置连接（expr）。请统一使用一种风格。`,
        DiagnosticSeverity.Error,
        'syntax-mixed-port-connections'
      ));
    }
  }

  // 检测缺失的逗号：相邻两个连接项之间如果没有 ','，报告错误
  // 用原始 token 序列重新遍历
  validateConnectionCommas(document, cursor, diagnostics);
}

/** 连接项信息 */
interface ConnectionItem {
  style: 'named' | 'positional';
  tokens: VerilogToken[];
  startOffset: number;
  endOffset: number;
}

/**
 * 从 cursor 当前位置分析并分割端口连接项。
 * 不修改 cursor 位置（先保存再恢复）。
 */
function splitConnectionItems(cursor: TokenCursor): ConnectionItem[] {
  const saved = cursor.save();
  const items: ConnectionItem[] = [];
  let currentTokens: VerilogToken[] = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let itemStyle: 'named' | 'positional' | undefined;

  while (!cursor.isAtEnd()) {
    const token = cursor.current()!;

    // 跟踪嵌套深度
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      if (paren > 0) {
        paren--;
      } else {
        // 顶层 ')' — 端口列表结束，保存最后一个连接项
        if (currentTokens.length > 0 && itemStyle) {
          items.push({
            style: itemStyle,
            tokens: [...currentTokens],
            startOffset: currentTokens[0].start,
            endOffset: currentTokens[currentTokens.length - 1].end
          });
        }
        break;
      }
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      if (bracket > 0) bracket--;
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      if (brace > 0) brace--;
    }

    // 顶层逗号 — 分隔符
    if (token.value === ',' && paren === 0 && bracket === 0 && brace === 0) {
      if (currentTokens.length > 0 && itemStyle) {
        items.push({
          style: itemStyle,
          tokens: [...currentTokens],
          startOffset: currentTokens[0].start,
          endOffset: currentTokens[currentTokens.length - 1].end
        });
      }
      currentTokens = [];
      itemStyle = undefined;
      cursor.advance();
      continue;
    }

    // 确定连接风格（仅在该连接项的第一个有效 token）
    if (itemStyle === undefined && token.value !== ',' && token.value !== ')') {
      itemStyle = token.value === '.' ? 'named' : 'positional';
    }

    currentTokens.push(token);
    cursor.advance();
  }

  // 处理最后一个连接项（如果没遇到 ')' 闭合）
  if (currentTokens.length > 0 && itemStyle) {
    items.push({
      style: itemStyle,
      tokens: [...currentTokens],
      startOffset: currentTokens[0].start,
      endOffset: currentTokens[currentTokens.length - 1].end
    });
  }

  cursor.restore(saved);
  return items;
}

/**
 * 验证端口连接之间的逗号分隔。
 *
 * 遍历连接列表，检查每个命名连接 `)` 之后是否紧跟着下一个连接的开头
 * 而没有 ',' 分隔。
 */
function validateConnectionCommas(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  const saved = cursor.save();
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let inConnection = false;

  while (!cursor.isAtEnd()) {
    const token = cursor.current()!;

    // 跟踪嵌套
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      if (paren > 0) {
        paren--;
        // 命名连接的 ')' 闭合
        if (paren === 0 && bracket === 0 && brace === 0 && inConnection) {
          inConnection = false;
          // 检查 ')' 之后是什么
          const next = nextSignificant(cursor.tokens, cursor.pos + 1);
          if (next && next.value !== ',' && next.value !== ')') {
            diagnostics.push(makeDiagnostic(
              Range.create(
                document.positionAt(token.end),
                document.positionAt(next.start)
              ),
              `语法错误：端口连接之间缺少 ','。在 ')' 后期望 ',' 或 ')'，但找到 '${next.value}'。`,
              DiagnosticSeverity.Error,
              'syntax-missing-comma-in-port-connection'
            ));
          }
        }
      } else {
        // 顶层 ')' — 列表结束
        break;
      }
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      if (bracket > 0) bracket--;
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      if (brace > 0) brace--;
    } else if (paren === 0 && bracket === 0 && brace === 0) {
      if (token.value === ',') {
        inConnection = false;
      } else if (token.value === ')') {
        break;
      } else if (!inConnection && token.value !== '.') {
        // 顶层非 '.' 非 ',' 非 ')' — 可能是位置连接的表达式
        inConnection = true;
      } else if (token.value === '.') {
        inConnection = true;
      }
    }

    cursor.advance();
  }

  cursor.restore(saved);
}

// ============================================================================
// A.4 端口声明
//   input_declaration  ::= 'input'  [net_type] [signed] [range] list_of_port_identifiers ;
//   output_declaration ::= 'output' [net_type] [signed] [range] list_of_port_identifiers ;
//   inout_declaration  ::= 'inout'  [net_type] [signed] [range] list_of_port_identifiers ;
//
// 注意：端口声明中的 port_identifier 不能包含初始化赋值。
//       'input a = 1;' 是非法的。
// ============================================================================

function validatePortDeclaration(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance(); // 消费 'input' / 'output' / 'inout'
  skipOptionalModifiers(cursor);
  // 端口不能初始化，只需跳过分隔的标识符列表
  skipCommaSeparatedIdentifiers(cursor);
}

// ============================================================================
// A.4 网络/reg声明（带初始化验证）
//   net_declaration ::= net_type [...] list_of_net_decl_assignments ;
//   reg_declaration ::= 'reg' [...] list_of_register_identifiers ;
//   其中 net_decl_assignment ::= net_identifier = expression
//
// net 声明支持初始化 (wire a = b)，reg 声明在 Verilog-2001 也支持初始化。
// 两者使用 '='，不能使用 '<=', '!=', '==' 等。
// ============================================================================

function validateNetDeclaration(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance();
  skipOptionalModifiers(cursor);
  validateDeclarationAssignments(document, cursor, diagnostics);
}

function validateRegDeclaration(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance();
  skipOptionalModifiers(cursor);
  validateDeclarationAssignments(document, cursor, diagnostics);
}

// ============================================================================
// A.4 parameter / localparam 声明
//   param_assignment ::= parameter_identifier = constant_expression
//   验证初始化运算符是 '=' 而非 '<=' 等
// ============================================================================

function validateParameterDeclaration(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance();
  skipOptionalModifiers(cursor);
  validateDeclarationAssignments(document, cursor, diagnostics);
}

// ============================================================================
// A.4 integer / genvar / real / realtime / time — 简单声明
// ============================================================================

function validateSimpleDecl(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance();
  skipCommaSeparatedIdentifiers(cursor);
}

// ============================================================================
// A.7 过程块: always_construct / initial_construct
//   always_construct ::= 'always' statement
//   initial_construct ::= 'initial' statement
// ============================================================================

function validateProceduralConstruct(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance(); // 消费 'always' / 'initial'

  // 跳过 @(...) 或 @* 事件控制
  if (cursor.currentIs('@')) {
    cursor.advance();
    if (cursor.currentIs('(')) {
      cursor.advance();
      // 验证敏感列表
      validateSensitivityList(document, cursor, diagnostics);
      // 跳到 ')' 之后
      if (cursor.currentIs(')')) {
        cursor.advance();
      }
    } else if (cursor.currentIs('*')) {
      cursor.advance();
    }
  }

  // 跳过可选的 #
  if (cursor.currentIs('#')) {
    cursor.advance();
    if (cursor.currentIs('(')) {
      cursor.advance();
      cursor.skipUntilTopLevel(new Set([')']), true);
    } else {
      cursor.skipExpression();
    }
  }
}

/**
 * 验证敏感列表: [posedge|negedge] signal { or [posedge|negedge] signal }
 *
 * 检查：
 *   - posedge/negedge 后面必须跟信号标识符
 *   - 信号之间用 'or' 分隔（逗号在 Verilog-2001 也合法）
 */
function validateSensitivityList(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  let expectSignal = false;
  let expectSeparator = false;

  while (!cursor.isAtEnd() && !cursor.currentIs(')')) {
    const token = cursor.current()!;

    if (token.value === 'posedge' || token.value === 'negedge') {
      expectSignal = true;
      expectSeparator = false;
      cursor.advance();
      continue;
    }

    if (token.value === 'or' || token.value === ',') {
      expectSeparator = false;
      expectSignal = false;
      cursor.advance();
      continue;
    }

    if (expectSignal && (token.kind === 'identifier' || token.kind === 'keyword')) {
      // 边缘关键词后找到了信号 — 检查通过
      expectSignal = false;
      expectSeparator = true;
      cursor.advance();
      continue;
    }

    if (expectSignal && token.kind !== 'identifier' && token.kind !== 'keyword') {
      // posedge/negedge 后面跟的不是信号标识符
      diagnostics.push(makeDiagnostic(
        rangeOf(document, token),
        `语法错误：posedge/negedge 后期望信号标识符，但找到 '${token.value}'。`,
        DiagnosticSeverity.Error,
        'syntax-incomplete-sensitivity'
      ));
      expectSignal = false;
      cursor.advance();
      continue;
    }

    // 普通信号（没有 posedge/negedge 前缀）
    if (!expectSignal && token.kind === 'identifier') {
      expectSeparator = true;
      cursor.advance();
      continue;
    }

    // 其他情况：消费并继续
    cursor.advance();
  }

  // 检查 posedge/negedge 后跟了 ')'（缺少信号）
  if (expectSignal) {
    diagnostics.push(makeDiagnostic(
      rangeOf(document, cursor.current() ?? cursor.peek(-1)!),
      `语法错误：posedge/negedge 后面缺少信号标识符。`,
      DiagnosticSeverity.Error,
      'syntax-incomplete-sensitivity'
    ));
  }
}

// ============================================================================
// A.6 门级实例化
//   gate_instantiation ::= gate_type [drive_strength] [delay] gate_instance { , gate_instance } ;
//   gate_instance ::= [name_of_instance] ( output_term , input_term { , input_term } )
//
// 语法类似于模块实例化，但原语名称是关键词。
// 验证端口连接列表的逗号分隔。
// ============================================================================

function validateGateInstance(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance(); // 消费原语类型 (and, or, nand, etc.)

  // 跳过可选的 drive_strength 和 delay
  skipOptionalStrengthDelay(cursor);

  // 跳过可选的实例名
  const saved = cursor.save();
  if (cursor.current() && cursor.current()!.kind === 'identifier') {
    cursor.advance();
    // 实例名后可跟位选 [range]
    if (cursor.currentIs('[')) {
      cursor.advance();
      cursor.skipUntilTopLevel(new Set([']']), true);
    }
  }

  // 期望 '(' 开始端口连接列表
  if (!cursor.currentIs('(')) {
    cursor.restore(saved);
    return;
  }
  cursor.advance(); // 消费 '('

  // 验证端口连接列表
  if (!cursor.currentIs(')') && !cursor.isAtEnd()) {
    validatePortConnectionList(document, cursor, diagnostics);
  }

  if (cursor.currentIs(')')) {
    cursor.advance();
  }
}

// ============================================================================
// 过程块内语句验证
//
// IEEE 1364-2001 A.7 定义了过程块内的合法语句类型。
// 在 CST 中，过程块内的每个 ';' 都分割出一个 statement。
// 我们检查这些 statement 的语法合法性。
// ============================================================================

/** 过程块内的合法语句首 token（非穷举，覆盖课程常用） */
const proceduralStatementStarters = new Set([
  'if', 'case', 'casex', 'casez',
  'for', 'while', 'forever', 'repeat',
  'begin', 'end', 'endcase', 'join', 'join_any', 'join_none',
  'disable', 'wait', 'fork',
  'assign', 'deassign', 'force', 'release',
  'else', 'default',
]);

function validateProceduralStatement(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  const first = cursor.current();
  if (!first) return;

  // 块结构关键词 — 由块平衡检查处理
  if (first.value === 'begin' || first.value === 'end' ||
      first.value === 'endcase' || first.value === 'join' ||
      first.value === 'join_any' || first.value === 'join_none' ||
      first.value === 'else' || first.value === 'default') {
    return;
  }

  // if 语句: if (expression) — 检查必须有 '(condition)'
  if (first.value === 'if') {
    validateIfHeader(document, cursor, diagnostics);
    return;
  }

  // case 语句: case (expression) — 检查必须有 '(expression)'
  if (first.value === 'case' || first.value === 'casex' || first.value === 'casez') {
    validateCaseHeader(document, cursor, first.value, diagnostics);
    return;
  }

  // for 语句: for (init; cond; step) — 基本结构检查
  if (first.value === 'for') {
    validateForHeader(document, cursor, diagnostics);
    return;
  }

  // while 语句: while (expression)
  if (first.value === 'while') {
    validateWhileHeader(document, cursor, diagnostics);
    return;
  }

  // 延迟控制: #delay 或 #(delay) — 过程块内合法
  if (first.value === '#') {
    return;
  }

  // 事件控制: @(event) 或 @identifier 或 @* — 过程块内合法
  if (first.value === '@') {
    return;
  }

  // 事件触发: -> event_trigger — 过程块内合法
  if (first.value === '->') {
    return;
  }

  // 其他控制语句 — 当前不做深入验证
  if (first.value === 'forever' || first.value === 'repeat' ||
      first.value === 'disable' || first.value === 'wait' || first.value === 'fork' ||
      first.value === 'assign' || first.value === 'deassign' || first.value === 'force' ||
      first.value === 'release') {
    return;
  }

  // 系统任务 ($display, $monitor 等) — 合法
  if (first.kind === 'systemIdentifier') {
    return;
  }

  // 标识符开头 — 检查是否是 case 项 (value : statement)
  if (first.kind === 'identifier' || first.kind === 'keyword' || first.kind === 'number') {
    // 可能是过程赋值或 case 项
    // case 项的特征：后面紧跟 ':'（如有冒号）
    if (looksLikeCaseItem(cursor)) {
      // case 项语法正确，不需要额外检查
      return;
    }
    validateProceduralAssignment(document, cursor, diagnostics);
    return;
  }

  // 拼接开头 — 过程赋值 {a, b} <= ...
  if (first.value === '{') {
    validateProceduralAssignment(document, cursor, diagnostics);
    return;
  }

  // 其他意外 token
  if (first.kind !== 'directive') {
    diagnostics.push(makeDiagnostic(
      rangeOf(document, first),
      `语法错误：过程块内无法识别的语句 '${first.value}'。`,
      DiagnosticSeverity.Error,
      'syntax-unrecognized-procedural-statement'
    ));
  }
}

/**
 * 验证 if 语句头部: if (expression)
 */
function validateIfHeader(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance(); // 消费 'if'

  if (!cursor.currentIs('(')) {
    diagnostics.push(makeDiagnostic(
      rangeOf(document, cursor.current() ?? cursor.peek(-1)!),
      `语法错误：'if' 后面必须跟 '(condition)'。期望 '(' 但找到 '${cursor.current()?.value ?? '无'}'。`,
      DiagnosticSeverity.Error,
      'syntax-if-missing-paren'
    ));
    return;
  }
  // 有 '('，消费并跳过到 ')'
  cursor.advance();
  cursor.skipUntilTopLevel(new Set([')']), true);
}

/**
 * 验证 case 语句头部: case (expression)
 */
function validateCaseHeader(
  document: TextDocument,
  cursor: TokenCursor,
  keyword: string,
  diagnostics: Diagnostic[]
): void {
  cursor.advance(); // 消费 'case' / 'casex' / 'casez'

  if (!cursor.currentIs('(')) {
    diagnostics.push(makeDiagnostic(
      rangeOf(document, cursor.current() ?? cursor.peek(-1)!),
      `语法错误：'${keyword}' 后面必须跟 '(expression)'。期望 '(' 但找到 '${cursor.current()?.value ?? '无'}'。`,
      DiagnosticSeverity.Error,
      'syntax-case-missing-paren'
    ));
    return;
  }
  // 有 '('，消费并跳过到 ')'
  cursor.advance();
  cursor.skipUntilTopLevel(new Set([')']), true);
}

/**
 * 验证 for 语句头部: for (init; cond; step)
 */
function validateForHeader(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance(); // 消费 'for'

  if (!cursor.currentIs('(')) {
    diagnostics.push(makeDiagnostic(
      rangeOf(document, cursor.current() ?? cursor.peek(-1)!),
      `语法错误：'for' 后面必须跟 '(init; cond; step)'。期望 '(' 但找到 '${cursor.current()?.value ?? '无'}'。`,
      DiagnosticSeverity.Error,
      'syntax-for-missing-paren'
    ));
    return;
  }
  cursor.advance();
  cursor.skipUntilTopLevel(new Set([')']), true);
}

/**
 * 验证 while 语句头部: while (expression)
 */
function validateWhileHeader(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  cursor.advance(); // 消费 'while'

  if (!cursor.currentIs('(')) {
    diagnostics.push(makeDiagnostic(
      rangeOf(document, cursor.current() ?? cursor.peek(-1)!),
      `语法错误：'while' 后面必须跟 '(condition)'。期望 '(' 但找到 '${cursor.current()?.value ?? '无'}'。`,
      DiagnosticSeverity.Error,
      'syntax-while-missing-paren'
    ));
    return;
  }
  cursor.advance();
  cursor.skipUntilTopLevel(new Set([')']), true);
}

/**
 * 判断当前语句是否看起来像 case 项（value : statement）
 * case 项的特征：在顶层遇到 ':'（冒号），冒号前有表达式
 */
function looksLikeCaseItem(cursor: TokenCursor): boolean {
  const saved = cursor.save();
  let paren = 0;
  let bracket = 0;
  let brace = 0;

  while (!cursor.isAtEnd()) {
    const token = cursor.current()!;

    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      if (paren > 0) paren--;
      else break;
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      if (bracket > 0) bracket--;
      else break;
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      if (brace > 0) brace--;
      else break;
    } else if (paren === 0 && bracket === 0 && brace === 0) {
      if (token.value === ';') {
        break; // 到达语句结束 — 没有冒号
      }
      if (token.value === ':') {
        cursor.restore(saved);
        return true; // 找到冒号 — 是 case 项
      }
      if (token.value === ',' || token.value === ')' || token.kind === 'operator') {
        // 还在 case 项表达式中（可能有逗号分隔的值列表）
        // continue
      }
    }

    cursor.advance();
  }

  cursor.restore(saved);
  return false;
}

/**
 * 验证过程赋值语句。
 *
 * 过程赋值语法：
 *   blocking_assignment    ::= variable_lvalue = [delay_or_event_control] expression
 *   nonblocking_assignment ::= variable_lvalue <= [delay_or_event_control] expression
 *
 * 合法运算符：'='（阻塞）、'<='（非阻塞）
 * 不合法的运算符：'!=', '==', '+=', 等 — 这些不是过程赋值运算符
 */
function validateProceduralAssignment(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  if (cursor.isAtEnd()) return;

  const assignStart = cursor.save();
  const opPos = cursor.findTopLevelOperator();

  if (opPos < 0) {
    // 没有运算符 — 可能是函数/任务调用，或者表达式语句（合法）
    cursor.restore(assignStart);
    return;
  }

  // 移动到运算符位置
  while (cursor.pos < opPos) {
    cursor.advance();
  }

  const operatorToken = cursor.current();
  if (!operatorToken) return;

  if (operatorToken.value === '=' || operatorToken.value === '<=') {
    // 合法的过程赋值运算符
    cursor.advance();
    cursor.skipExpression();
  } else {
    // 语法期望 '=' 或 '<='，但找到其他运算符
    // 注意：裸表达式语句（如 a != b;）在 Verilog 中语法合法，但极可能是 bug
    // 我们将其报告为警告而非错误
    diagnostics.push(makeDiagnostic(
      rangeOf(document, operatorToken),
      `语法警告：过程块中此位置通常为赋值运算符（= 或 <=），但找到 '${operatorToken.value}'。如果意图为赋值，请检查运算符。`,
      DiagnosticSeverity.Warning,
      'syntax-suspicious-procedural-operator'
    ));
    cursor.advance();
    cursor.skipExpression();
  }
}

// ============================================================================
// 过程块范围检测
//
// 从 CST 中找到所有 begin/end 和 fork/join 对之间的语句范围。
// 用于区分模块体顶层语句和过程块内语句。
// ============================================================================

interface ByteRange {
  start: number;
  end: number;
}

function collectProceduralRanges(cst: VerilogCstDocument): ByteRange[] {
  const ranges: ByteRange[] = [];
  const beginStack: number[] = [];
  const forkStack: number[] = [];

  for (const statement of cst.statements) {
    const tokens = trimStatement(statement.tokens);
    if (!tokens.length) continue;

    const first = tokens[0];

    if (first.value === 'begin' || first.value === 'fork') {
      const stack = first.value === 'begin' ? beginStack : forkStack;
      stack.push(statement.start);
    } else if (first.value === 'end') {
      if (beginStack.length > 0) {
        ranges.push({ start: beginStack.pop()!, end: statement.end });
      }
    } else if (first.value === 'join' || first.value === 'join_any' || first.value === 'join_none') {
      if (forkStack.length > 0) {
        ranges.push({ start: forkStack.pop()!, end: statement.end });
      }
    }
  }

  return ranges;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 验证声明中带初始化的项列表（wire/reg/parameter 等）。
 * net_decl_assignment ::= identifier = expression
 *
 * 对每个声明项：如果是 `name = expr` 形式，验证 `=` 的正确性。
 */
function validateDeclarationAssignments(
  document: TextDocument,
  cursor: TokenCursor,
  diagnostics: Diagnostic[]
): void {
  // 跳过第一个标识符（声明名）
  if (cursor.isAtEnd()) return;

  // 在整个声明中，检查每个 `=` 是否在正确的上下文中
  // 声明中的 `=` 是合法的初始化；但是 `<=` 或其他运算符就不对
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let lastWasComma = true; // 在开头或逗号之后期望标识符

  while (!cursor.isAtEnd()) {
    const token = cursor.current()!;

    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      if (paren > 0) paren--;
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      if (bracket > 0) bracket--;
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      if (brace > 0) brace--;
    } else if (paren === 0 && bracket === 0 && brace === 0) {
      // 顶层
      if (token.value === ';') {
        break; // 语句结束，由其他检查处理
      }
      if (token.value === ',') {
        lastWasComma = true;
      } else if (token.kind === 'operator') {
        if (token.value === '=') {
          // 声明初始化 — 合法
          lastWasComma = false;
        } else if (token.value === '<=') {
          // 声明中不应用非阻塞赋值
          diagnostics.push(makeDiagnostic(
            rangeOf(document, token),
            `语法错误：声明初始化中不应使用 '<='。如果这是声明，请使用 '=' 而不是 '<='。`,
            DiagnosticSeverity.Error,
            'syntax-declaration-operator'
          ));
          lastWasComma = false;
        } else {
          // 其他运算符出现在声明顶层可能表示语法错误
          // 但在此不做判断，因为表达式内部可能含各种运算符
          lastWasComma = false;
        }
      } else if (isValueToken(token)) {
        lastWasComma = false;
      }
    }

    cursor.advance();
  }
}

/** 跳过可选的修饰符序列：signed, unsigned, range, delay, vectored, scalared 等 */
function skipOptionalModifiers(cursor: TokenCursor): void {
  const modifiers = new Set([
    'signed', 'unsigned', 'vectored', 'scalared', 'automatic'
  ]);

  while (!cursor.isAtEnd()) {
    const token = cursor.current()!;
    if (modifiers.has(token.value)) {
      cursor.advance();
    } else if (token.value === '[') {
      // 跳过 range [msb:lsb]
      cursor.advance();
      cursor.skipUntilTopLevel(new Set([']']), true);
    } else {
      break;
    }
  }
}

/** 跳过可选的 drive_strength 和 delay（用于门级实例化） */
function skipOptionalStrengthDelay(cursor: TokenCursor): void {
  // drive_strength: ( strength0 , strength1 ) 等
  if (cursor.currentIs('(')) {
    cursor.advance();
    cursor.skipUntilTopLevel(new Set([')']), true);
  }
  // delay: #number 或 #(number, number)
  if (cursor.currentIs('#')) {
    cursor.advance();
    if (cursor.currentIs('(')) {
      cursor.advance();
      cursor.skipUntilTopLevel(new Set([')']), true);
    } else {
      cursor.skipExpression();
    }
  }
}

/** 跳过逗号分隔的标识符列表 */
function skipCommaSeparatedIdentifiers(cursor: TokenCursor): void {
  while (!cursor.isAtEnd()) {
    const token = cursor.current()!;
    if (token.value === ';' || cursor.isAtEnd()) break;
    if (token.kind === 'identifier' || token.kind === 'keyword') {
      cursor.advance();
      // 跳过可能的 range [msb:lsb]
      if (cursor.currentIs('[')) {
        cursor.advance();
        cursor.skipUntilTopLevel(new Set([']']), true);
      }
    } else if (token.value === ',') {
      cursor.advance();
    } else {
      break;
    }
  }
}

// ============================================================================
// Token 工具
// ============================================================================

/**
 * 判断一个以标识符开头的语句是否"看起来像"模块实例化。
 *
 * 实例化语法: ModuleName [#(params)] instanceName [range] ( [ports] ) ;
 *
 * 排除明显不是实例的情况：
 *   - 第一个标识符后紧跟运算符（如 !=, ==, <=, +, - 等）→ 是表达式语句
 *   - 只有一个 token → 不是实例
 */
function looksLikeInstance(cursor: TokenCursor): boolean {
  const second = cursor.peek(1);
  if (!second) return false;

  // ModuleName #(...) — 参数覆盖，是实例
  if (second.value === '#') return true;

  // ModuleName instName — 第二个 token 是标识符或关键词
  // 注意：实例名不能是运算符
  if (second.kind === 'operator' || second.kind === 'punctuation') {
    // ModuleName 后直接跟运算符或标点 → 不是实例
    return false;
  }

  // 第二个 token 是标识符 → 可能是实例
  return second.kind === 'identifier' || second.kind === 'keyword';
}

/**
 * 验证 Verilog 数字字面量的数字是否合法。
 *
 * 格式: [size]'[s][base]digits
 *   base b/B: 允许 0,1,x,X,z,Z,?,_
 *   base o/O: 允许 0-7,x,X,z,Z,?,_
 *   base d/D: 允许 0-9,x,X,z,Z,?,_
 *   base h/H: 允许 0-9,a-f,A-F,x,X,z,Z,?,_
 *
 * 不含 base 的纯数字: 只允许 0-9,_
 */
function validateNumberLiteral(
  document: TextDocument,
  token: VerilogToken,
  diagnostics: Diagnostic[]
): void {
  const value = token.value;
  const apostrophe = value.indexOf("'");

  if (apostrophe < 0) {
    // 纯数字（无基）: 只允许 0-9 和下划线
    // 由 lexer 保证格式正确，不额外验证
    return;
  }

  // 提取基字符
  const remainder = value.slice(apostrophe + 1);
  // 跳过可选的 's' 或 'S'
  let baseIndex = 0;
  if (remainder.length > 0 && (remainder[0] === 's' || remainder[0] === 'S')) {
    baseIndex = 1;
  }
  if (baseIndex >= remainder.length) {
    // 只有 's 没有基 → 格式错误（但 lexer 可能已处理）
    return;
  }

  const baseChar = remainder[baseIndex];
  const digits = remainder.slice(baseIndex + 1);

  if (!digits) return;

  const base = baseChar.toLowerCase();
  let radix: number;
  let validPattern: RegExp;

  switch (base) {
    case 'b':
      radix = 2;
      // 二进制：只允许 0,1,x,X,z,Z,?,_
      validPattern = /^[01xz?_]+$/i;
      break;
    case 'o':
      radix = 8;
      // 八进制：只允许 0-7,x,X,z,Z,?,_
      validPattern = /^[0-7xz?_]+$/i;
      break;
    case 'd':
      radix = 10;
      // 十进制：只允许 0-9,x,X,z,Z,?,_
      validPattern = /^[0-9xz?_]+$/i;
      break;
    case 'h':
      radix = 16;
      // 十六进制：只允许 0-9,a-f,x,X,z,Z,?,_
      validPattern = /^[0-9a-fxz?_]+$/i;
      break;
    default:
      return; // 未知基，可能是格式错误
  }

  // 移除下划线再检查
  const cleanDigits = digits.replace(/_/g, '');
  if (cleanDigits.length === 0) return;

  if (!validPattern.test(cleanDigits)) {
    // 找出第一个非法字符
    const illegal = [...cleanDigits].find((c) => !validPattern.test(c));
    diagnostics.push(makeDiagnostic(
      rangeOf(document, token),
      `语法错误：${radix}进制数字字面量中包含非法字符 '${illegal}'。期望的有效字符为 ${radix === 2 ? '0/1/x/z' : radix === 8 ? '0-7/x/z' : radix === 10 ? '0-9/x/z' : '0-9/a-f/x/z'}。`,
      DiagnosticSeverity.Error,
      'syntax-invalid-number-literal'
    ));
  }
}

/** 去除 eof token 和尾部分号 */
function trimStatement(tokens: VerilogToken[]): VerilogToken[] {
  const filtered = tokens.filter((token) => token.kind !== 'eof');
  if (filtered.length === 0) return filtered;
  return filtered[filtered.length - 1]?.value === ';' ? filtered.slice(0, -1) : filtered;
}

/** 查找包含某语句的模块 */
function findContainingModule(
  statement: VerilogCstStatement,
  modules: VerilogModule[],
  document: TextDocument
): VerilogModule | undefined {
  return modules.find((module) => {
    const moduleStart = document.offsetAt(module.range.start);
    const moduleEnd = document.offsetAt(module.range.end);
    return statement.start >= moduleStart && statement.start < moduleEnd;
  });
}

/** 获取单个 token 的 Range */
function rangeOf(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

/** 获取 token 数组的 Range */
function rangeFromTokens(document: TextDocument, tokens: VerilogToken[]): Range {
  if (!tokens.length) return Range.create(0, 0, 0, 0);
  return Range.create(
    document.positionAt(tokens[0].start),
    document.positionAt(tokens[tokens.length - 1].end)
  );
}

/** 获取指定位置之后的下一个非 eof token */
function nextSignificant(tokens: VerilogToken[], start: number): VerilogToken | undefined {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'eof') return token;
  }
  return undefined;
}

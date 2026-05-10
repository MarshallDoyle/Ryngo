/**
 * cgql — lexer + recursive-descent parser.
 *
 * Hand-rolled because (a) the grammar is small enough to fit in one file, (b)
 * chevrotain pulls a non-trivial dep + a 200KB+ runtime that the viewer would
 * have to ship, and (c) the parser needs precise span info for diagnostics —
 * easier to thread by hand than to recover from a parser-generator's locations.
 *
 * The grammar implemented (subset of design/query-language.md §2):
 *
 *   query     := (matchClause)*
 *                ('WHERE' expr)?
 *                ('WITH' projection (',' projection)* ('WHERE' expr)?)*
 *                ('ORDER' 'BY' orderItem (',' orderItem)*)?
 *                ('LIMIT' int)?
 *                'RETURN' ('DISTINCT')? projection (',' projection)*
 *
 *   matchClause := 'MATCH' (var '=')? pattern (',' pattern)*
 *   pattern   := nodePat (edgePat nodePat)*
 *   nodePat   := '(' (var)? (':' label)? ('{' propFilters '}')? ')'
 *   edgePat   := '<-' '[' edgeBody ']' '-'
 *              | '-'  '[' edgeBody ']' '->'
 *              | '-'  '[' edgeBody ']' '-'
 *
 * `--params` substitution happens *before* the lexer: the engine calls
 * `substituteParams(source, params)` first; the parser only sees `$name`
 * if it survived substitution (which is then a parse error per §2.5).
 */

import {
  CgqlParseError,
  type Expr,
  type EdgePattern,
  type MatchClause,
  type NodeLabel,
  type NodePattern,
  type OrderByClause,
  type Pattern,
  type ProjectionItem,
  type PropFilter,
  type QueryAST,
  type ReturnClause,
  type Span,
  type WithClause,
} from "./types.js";

// =============================================================================
// Param substitution
// =============================================================================

/**
 * Replace `$name` references with literal values. Substitution is textual but
 * type-aware: strings are emitted as JSON-quoted literals, numbers/booleans
 * are emitted bare, null becomes `null`. Unknown names fall through (the
 * parser will then surface a "$name not bound" error with a precise span).
 */
export function substituteParams(
  source: string,
  params?: Record<string, string | number | boolean | null>,
): string {
  if (!params) return source;
  return source.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const v = params[name]!;
    if (v === null) return "null";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return whole;
  });
}

// =============================================================================
// Lexer
// =============================================================================

type TokKind =
  | "lparen" | "rparen" | "lbrace" | "rbrace" | "lbracket" | "rbracket"
  | "comma" | "colon" | "dot" | "pipe" | "star" | "slash" | "plus" | "minus"
  | "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
  | "regex"
  | "arrow_r" | "arrow_l" | "dash"
  | "rangedots"
  | "dollar"
  | "ident" | "string" | "number" | "boolean" | "null"
  | "kw"
  | "eof";

interface Tok {
  kind: TokKind;
  text: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set([
  "MATCH", "WHERE", "WITH", "RETURN", "DISTINCT",
  "ORDER", "BY", "ASC", "DESC", "LIMIT",
  "AND", "OR", "NOT",
  "IN", "IS", "EXISTS",
  "STARTS", "ENDS", "CONTAINS",
  "AS", "CASE", "WHEN", "THEN", "ELSE", "END",
]);

class Lexer {
  private i = 0;
  private line = 1;
  private col = 1;
  constructor(private src: string) {}

  tokenize(): Tok[] {
    const out: Tok[] = [];
    while (this.i < this.src.length) {
      this.skipTrivia();
      if (this.i >= this.src.length) break;
      const start = { line: this.line, col: this.col };
      const c = this.src[this.i]!;

      if (c === "(") { out.push(this.one("lparen")); continue; }
      if (c === ")") { out.push(this.one("rparen")); continue; }
      if (c === "{") { out.push(this.one("lbrace")); continue; }
      if (c === "}") { out.push(this.one("rbrace")); continue; }
      if (c === "[") { out.push(this.one("lbracket")); continue; }
      if (c === "]") { out.push(this.one("rbracket")); continue; }
      if (c === ",") { out.push(this.one("comma")); continue; }
      if (c === ":") { out.push(this.one("colon")); continue; }
      if (c === ".") {
        if (this.peek(1) === ".") {
          this.advance(); this.advance();
          out.push({ kind: "rangedots", text: "..", line: start.line, col: start.col });
          continue;
        }
        out.push(this.one("dot")); continue;
      }
      if (c === "|") { out.push(this.one("pipe")); continue; }
      if (c === "*") { out.push(this.one("star")); continue; }
      if (c === "/") { out.push(this.one("slash")); continue; }
      if (c === "+") { out.push(this.one("plus")); continue; }
      if (c === "$") { out.push(this.one("dollar")); continue; }

      if (c === "<") {
        if (this.peek(1) === "=") {
          this.advance(); this.advance();
          out.push({ kind: "lte", text: "<=", line: start.line, col: start.col });
          continue;
        }
        if (this.peek(1) === ">") {
          this.advance(); this.advance();
          out.push({ kind: "neq", text: "<>", line: start.line, col: start.col });
          continue;
        }
        if (this.peek(1) === "-") {
          this.advance(); this.advance();
          out.push({ kind: "arrow_l", text: "<-", line: start.line, col: start.col });
          continue;
        }
        out.push(this.one("lt")); continue;
      }
      if (c === ">") {
        if (this.peek(1) === "=") {
          this.advance(); this.advance();
          out.push({ kind: "gte", text: ">=", line: start.line, col: start.col });
          continue;
        }
        out.push(this.one("gt")); continue;
      }
      if (c === "=") {
        if (this.peek(1) === "~") {
          this.advance(); this.advance();
          out.push({ kind: "regex", text: "=~", line: start.line, col: start.col });
          continue;
        }
        out.push(this.one("eq")); continue;
      }
      if (c === "!") {
        if (this.peek(1) === "=") {
          this.advance(); this.advance();
          out.push({ kind: "neq", text: "!=", line: start.line, col: start.col });
          continue;
        }
        throw new CgqlParseError("Unexpected '!'", start.line, start.col);
      }
      if (c === "-") {
        if (this.peek(1) === ">") {
          this.advance(); this.advance();
          out.push({ kind: "arrow_r", text: "->", line: start.line, col: start.col });
          continue;
        }
        out.push({ kind: "dash", text: "-", line: start.line, col: start.col });
        this.advance();
        continue;
      }
      if (c === '"') { out.push(this.string('"', start)); continue; }
      if (c === "'") { out.push(this.string("'", start)); continue; }
      if (this.isDigit(c)) { out.push(this.number(start)); continue; }
      if (this.isIdentStart(c)) { out.push(this.identOrKeyword(start)); continue; }

      throw new CgqlParseError(`Unexpected character '${c}'`, start.line, start.col);
    }
    out.push({ kind: "eof", text: "", line: this.line, col: this.col });
    return out;
  }

  private one(kind: TokKind): Tok {
    const t: Tok = { kind, text: this.src[this.i]!, line: this.line, col: this.col };
    this.advance();
    return t;
  }

  private skipTrivia(): void {
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === " " || c === "\t" || c === "\r") { this.advance(); continue; }
      if (c === "\n") { this.i++; this.line++; this.col = 1; continue; }
      // // line comment
      if (c === "/" && this.peek(1) === "/") {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.advance();
        continue;
      }
      // /* block comment */
      if (c === "/" && this.peek(1) === "*") {
        this.advance(); this.advance();
        while (this.i < this.src.length && !(this.src[this.i] === "*" && this.peek(1) === "/")) {
          if (this.src[this.i] === "\n") { this.i++; this.line++; this.col = 1; }
          else this.advance();
        }
        if (this.i < this.src.length) { this.advance(); this.advance(); }
        continue;
      }
      break;
    }
  }

  private string(quote: '"' | "'", start: Span): Tok {
    this.advance(); // opening quote
    let text = "";
    while (this.i < this.src.length && this.src[this.i] !== quote) {
      const c = this.src[this.i]!;
      if (c === "\\") {
        this.advance();
        const esc = this.src[this.i];
        if (esc === undefined) throw new CgqlParseError("Unterminated string", start.line, start.col);
        switch (esc) {
          case "n": text += "\n"; break;
          case "t": text += "\t"; break;
          case "r": text += "\r"; break;
          case "\\": text += "\\"; break;
          case '"': text += '"'; break;
          case "'": text += "'"; break;
          default: text += esc; break;
        }
        this.advance();
      } else {
        text += c;
        if (c === "\n") { this.i++; this.line++; this.col = 1; }
        else this.advance();
      }
    }
    if (this.i >= this.src.length) {
      throw new CgqlParseError("Unterminated string", start.line, start.col);
    }
    this.advance(); // closing quote
    return { kind: "string", text, line: start.line, col: start.col };
  }

  private number(start: Span): Tok {
    let text = "";
    while (this.i < this.src.length && this.isDigit(this.src[this.i]!)) {
      text += this.src[this.i]!;
      this.advance();
    }
    if (this.src[this.i] === "." && this.isDigit(this.peek(1) ?? "")) {
      text += ".";
      this.advance();
      while (this.i < this.src.length && this.isDigit(this.src[this.i]!)) {
        text += this.src[this.i]!;
        this.advance();
      }
    }
    return { kind: "number", text, line: start.line, col: start.col };
  }

  private identOrKeyword(start: Span): Tok {
    let text = "";
    while (this.i < this.src.length && this.isIdentCont(this.src[this.i]!)) {
      text += this.src[this.i]!;
      this.advance();
    }
    const upper = text.toUpperCase();
    if (KEYWORDS.has(upper)) {
      return { kind: "kw", text: upper, line: start.line, col: start.col };
    }
    if (text === "true" || text === "false") {
      return { kind: "boolean", text, line: start.line, col: start.col };
    }
    if (text === "null") {
      return { kind: "null", text, line: start.line, col: start.col };
    }
    return { kind: "ident", text, line: start.line, col: start.col };
  }

  private advance(): void {
    this.i++;
    this.col++;
  }
  private peek(off: number): string | undefined {
    return this.src[this.i + off];
  }
  private isDigit(c: string): boolean {
    return c >= "0" && c <= "9";
  }
  private isIdentStart(c: string): boolean {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  }
  private isIdentCont(c: string): boolean {
    return this.isIdentStart(c) || this.isDigit(c) || c === "-";
  }
}

// =============================================================================
// Parser
// =============================================================================

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private src: string) {}

  parseQuery(): QueryAST {
    const matches: MatchClause[] = [];
    while (this.atKw("MATCH")) {
      matches.push(...this.parseMatch());
    }

    let where: Expr | undefined;
    if (this.eatKw("WHERE")) {
      where = this.parseExpr();
    }

    const withClauses: WithClause[] = [];
    while (this.atKw("WITH")) {
      this.advance();
      const items = this.parseProjectionList();
      let wWhere: Expr | undefined;
      if (this.eatKw("WHERE")) wWhere = this.parseExpr();
      const w: WithClause = { items };
      if (wWhere !== undefined) w.where = wWhere;
      withClauses.push(w);
    }

    let orderBy: OrderByClause[] | undefined;
    if (this.eatKw("ORDER")) {
      this.expectKw("BY");
      orderBy = this.parseOrderItems();
    }

    let limit: number | undefined;
    if (this.eatKw("LIMIT")) {
      const t = this.expect("number");
      limit = Number.parseInt(t.text, 10);
    }

    this.expectKw("RETURN");
    const distinct = this.eatKw("DISTINCT");
    const items = this.parseProjectionList();
    const ret: ReturnClause = { items };

    if (this.peek().kind !== "eof") {
      const t = this.peek();
      throw new CgqlParseError(
        `Unexpected '${t.text || t.kind}' after RETURN`,
        t.line,
        t.col,
      );
    }

    const ast: QueryAST = {
      matches,
      withClauses,
      ret,
      distinct,
      source: this.src,
    };
    if (where !== undefined) ast.where = where;
    if (orderBy !== undefined) ast.orderBy = orderBy;
    if (limit !== undefined) ast.limit = limit;
    return ast;
  }

  // ---------------------------------------------------------------- MATCH
  private parseMatch(): MatchClause[] {
    this.expectKw("MATCH");
    const out: MatchClause[] = [];
    out.push(this.parseMatchEntry());
    while (this.eat("comma")) out.push(this.parseMatchEntry());
    return out;
  }

  private parseMatchEntry(): MatchClause {
    // Optional path binding: `p = (...)-...`
    let pathVar: string | undefined;
    if (this.peek().kind === "ident" && this.toks[this.i + 1]?.kind === "eq") {
      pathVar = this.advance().text;
      this.advance(); // =
    }
    const pattern = this.parsePattern();
    const m: MatchClause = { pattern };
    if (pathVar !== undefined) m.pathVar = pathVar;
    return m;
  }

  private parsePattern(): Pattern {
    const nodes: NodePattern[] = [];
    const edges: EdgePattern[] = [];
    nodes.push(this.parseNodePattern());
    while (this.atEdgeStart()) {
      const e = this.parseEdgePattern();
      const n = this.parseNodePattern();
      edges.push(e);
      nodes.push(n);
    }
    return { nodes, edges };
  }

  private atEdgeStart(): boolean {
    const k = this.peek().kind;
    return k === "dash" || k === "arrow_l";
  }

  private parseNodePattern(): NodePattern {
    this.expect("lparen");
    const np: NodePattern = { inlineFilters: [] };
    if (this.peek().kind === "ident") np.var = this.advance().text;
    if (this.eat("colon")) {
      const labelTok = this.expect("ident");
      np.label = labelTok.text as NodeLabel;
    }
    if (this.peek().kind === "lbrace") {
      np.inlineFilters = this.parsePropFilters();
    }
    this.expect("rparen");
    return np;
  }

  private parseEdgePattern(): EdgePattern {
    let direction: "in" | "out" | "both" = "out";
    if (this.eat("arrow_l")) {
      direction = "in";
    } else {
      this.expect("dash");
    }
    let categories: string[] = [];
    let varLen: { min: number; max: number } | undefined;
    let varName: string | undefined;
    let inlineFilters: PropFilter[] = [];

    if (this.eat("lbracket")) {
      // [varName?] [:cat | cat | cat]? [*min..max]? [{...}]?
      if (this.peek().kind === "ident") {
        varName = this.advance().text;
      }
      if (this.eat("colon")) {
        categories.push(this.expect("ident").text);
        while (this.eat("pipe")) categories.push(this.expect("ident").text);
      }
      if (this.eat("star")) {
        // ranges: `*`, `*5`, `*1..`, `*..5`, `*1..5`
        let min = 1;
        let max = -1; // sentinel: unbounded; resolved in planner
        if (this.peek().kind === "number") {
          min = Number.parseInt(this.advance().text, 10);
          max = min;
        }
        if (this.eat("rangedots")) {
          if (this.peek().kind === "number") {
            max = Number.parseInt(this.advance().text, 10);
          } else {
            max = -1; // unbounded
          }
          if (min === max && max === -1) min = 1;
        }
        varLen = { min, max };
      }
      if (this.peek().kind === "lbrace") {
        inlineFilters = this.parsePropFilters();
      }
      this.expect("rbracket");
    }

    // closing '-' or '->'
    if (this.eat("arrow_r")) {
      // outbound; direction stays "out" unless we entered with arrow_l
    } else {
      this.expect("dash");
      if (direction !== "in") direction = "both";
    }

    const ep: EdgePattern = { categories, direction, inlineFilters };
    if (varName !== undefined) ep.var = varName;
    if (varLen !== undefined) ep.varLen = varLen;
    return ep;
  }

  private parsePropFilters(): PropFilter[] {
    this.expect("lbrace");
    const out: PropFilter[] = [];
    if (!this.at("rbrace")) {
      out.push(this.parsePropFilter());
      while (this.eat("comma")) out.push(this.parsePropFilter());
    }
    this.expect("rbrace");
    return out;
  }

  private parsePropFilter(): PropFilter {
    const key = this.expectIdentOrKw().text;
    this.expect("colon");
    const tok = this.peek();
    let value: PropFilter["value"];
    if (tok.kind === "string") {
      value = { value: this.advance().text };
    } else if (tok.kind === "number") {
      value = { value: Number.parseFloat(this.advance().text) };
    } else if (tok.kind === "boolean") {
      value = { value: this.advance().text === "true" };
    } else if (tok.kind === "null") {
      this.advance();
      value = { value: null };
    } else {
      throw new CgqlParseError(
        `Expected literal in property filter, got ${tok.text || tok.kind}`,
        tok.line, tok.col,
      );
    }
    return { key, value: value as never };
  }

  // ---------------------------------------------------------------- projection
  private parseProjectionList(): ProjectionItem[] {
    const out: ProjectionItem[] = [];
    out.push(this.parseProjection());
    while (this.eat("comma")) out.push(this.parseProjection());
    return out;
  }

  private parseProjection(): ProjectionItem {
    const expr = this.parseExpr();
    let alias: string;
    if (this.eatKw("AS")) {
      alias = this.expectIdentOrKw().text;
    } else {
      alias = displayOf(expr);
    }
    return { expr, alias };
  }

  private parseOrderItems(): OrderByClause[] {
    const out: OrderByClause[] = [];
    out.push(this.parseOrderItem());
    while (this.eat("comma")) out.push(this.parseOrderItem());
    return out;
  }

  private parseOrderItem(): OrderByClause {
    const expr = this.parseExpr();
    let dir: "asc" | "desc" = "asc";
    if (this.eatKw("ASC")) dir = "asc";
    else if (this.eatKw("DESC")) dir = "desc";
    return { expr, dir };
  }

  // ---------------------------------------------------------------- expressions
  // Operator precedence (low → high):
  //   OR
  //   AND
  //   NOT
  //   comparison (= <> < <= > >= IN STARTS/ENDS/CONTAINS WITH IS NULL =~)
  //   additive (+ -)
  //   multiplicative (* /)
  //   unary  -
  //   primary

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    const span = exprSpan(left);
    while (this.eatKw("OR")) {
      const right = this.parseAnd();
      if (left.type === "or") left.args.push(right);
      else left = { type: "or", args: [left, right], span };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    const span = exprSpan(left);
    while (this.eatKw("AND")) {
      const right = this.parseNot();
      if (left.type === "and") left.args.push(right);
      else left = { type: "and", args: [left, right], span };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.atKw("NOT")) {
      const t = this.advance();
      const arg = this.parseNot();
      return { type: "unary", op: "NOT", arg, span: { line: t.line, col: t.col } };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    const span = exprSpan(left);
    while (true) {
      const t = this.peek();
      if (t.kind === "eq" || t.kind === "neq" || t.kind === "lt" || t.kind === "lte" || t.kind === "gt" || t.kind === "gte") {
        this.advance();
        const right = this.parseAdditive();
        left = { type: "binary", op: t.text as "=" | "<>" | "<" | "<=" | ">" | ">=", left, right, span };
      } else if (t.kind === "regex") {
        this.advance();
        const right = this.parseAdditive();
        left = { type: "regex", target: left, pattern: right, span };
      } else if (this.atKw("IN")) {
        this.advance();
        const list = this.parsePrimary();
        left = { type: "between", target: left, kind: "IN", operand: list, span };
      } else if (this.atKw("STARTS")) {
        this.advance();
        this.expectKw("WITH");
        const right = this.parseAdditive();
        left = { type: "between", target: left, kind: "STARTS_WITH", operand: right, span };
      } else if (this.atKw("ENDS")) {
        this.advance();
        this.expectKw("WITH");
        const right = this.parseAdditive();
        left = { type: "between", target: left, kind: "ENDS_WITH", operand: right, span };
      } else if (this.atKw("CONTAINS")) {
        this.advance();
        const right = this.parseAdditive();
        left = { type: "between", target: left, kind: "CONTAINS", operand: right, span };
      } else if (this.atKw("IS")) {
        this.advance();
        const not = this.eatKw("NOT");
        if (!this.atKw("NULL")) {
          // `null` was lexed as kind "null", not a keyword — accept it explicitly.
          if (this.peek().kind !== "null") {
            const tok = this.peek();
            throw new CgqlParseError(`Expected NULL after IS, got ${tok.text}`, tok.line, tok.col);
          }
        }
        // consume null
        if (this.peek().kind === "null") this.advance();
        left = { type: "between", target: left, kind: not ? "IS_NOT_NULL" : "IS_NULL", span };
      } else {
        break;
      }
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    const span = exprSpan(left);
    while (true) {
      const t = this.peek();
      if (t.kind === "plus" || t.kind === "dash") {
        this.advance();
        const right = this.parseMultiplicative();
        left = { type: "binary", op: t.kind === "plus" ? "+" : "-", left, right, span };
      } else break;
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    const span = exprSpan(left);
    while (true) {
      const t = this.peek();
      if (t.kind === "star" || t.kind === "slash") {
        this.advance();
        const right = this.parseUnary();
        left = { type: "binary", op: t.kind === "star" ? "*" : "/", left, right, span };
      } else break;
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().kind === "dash") {
      const t = this.advance();
      const arg = this.parseUnary();
      return { type: "unary", op: "-", arg, span: { line: t.line, col: t.col } };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    const span: Span = { line: t.line, col: t.col };

    if (t.kind === "number") {
      this.advance();
      return { type: "lit", value: Number.parseFloat(t.text), span };
    }
    if (t.kind === "string") {
      this.advance();
      return { type: "lit", value: t.text, span };
    }
    if (t.kind === "boolean") {
      this.advance();
      return { type: "lit", value: t.text === "true", span };
    }
    if (t.kind === "null") {
      this.advance();
      return { type: "lit", value: null, span };
    }
    if (t.kind === "dollar") {
      this.advance();
      const nm = this.expect("ident");
      throw new CgqlParseError(
        `Unbound parameter $${nm.text}; pass it via --params`,
        nm.line, nm.col,
      );
    }
    if (t.kind === "lbracket") {
      this.advance();
      const items: Expr[] = [];
      if (!this.at("rbracket")) {
        items.push(this.parseExpr());
        while (this.eat("comma")) items.push(this.parseExpr());
      }
      this.expect("rbracket");
      return { type: "list", items, span };
    }
    if (t.kind === "lparen") {
      this.advance();
      const e = this.parseExpr();
      this.expect("rparen");
      return e;
    }
    if (this.atKw("CASE")) {
      this.advance();
      this.expectKw("WHEN");
      const when = this.parseExpr();
      this.expectKw("THEN");
      const then = this.parseExpr();
      this.expectKw("ELSE");
      const els = this.parseExpr();
      this.expectKw("END");
      return { type: "case", when, then, els, span };
    }
    if (this.atKw("EXISTS")) {
      this.advance();
      this.expect("lbrace");
      const pat = this.parsePattern();
      this.expect("rbrace");
      return { type: "exists", pattern: pat, not: false, span };
    }

    if (t.kind === "ident") {
      const head = this.advance();
      // Function call?
      if (this.eat("lparen")) {
        const args: Expr[] = [];
        let distinct = false;
        if (this.atKw("DISTINCT")) {
          this.advance();
          distinct = true;
        }
        if (!this.at("rparen")) {
          // Cypher convention: count(*) sweetener is allowed.
          if (this.peek().kind === "star") {
            this.advance();
            // synthesize a placeholder literal — engine treats count(*) specially.
            args.push({ type: "lit", value: "*", span });
          } else {
            args.push(this.parseExpr());
          }
          while (this.eat("comma")) args.push(this.parseExpr());
        }
        this.expect("rparen");
        return { type: "fnCall", name: head.text, args, distinct, span };
      }
      // Property access chain: a.b.c.d
      if (this.at("dot")) {
        const path: string[] = [];
        while (this.eat("dot")) {
          path.push(this.expectIdentOrKw().text);
        }
        return { type: "prop", base: head.text, path, span };
      }
      return { type: "var", name: head.text, span };
    }

    throw new CgqlParseError(
      `Unexpected token '${t.text || t.kind}'`,
      t.line, t.col,
    );
  }

  // ---------------------------------------------------------------- helpers
  private advance(): Tok {
    const t = this.toks[this.i]!;
    if (t.kind !== "eof") this.i++;
    return t;
  }
  private peek(): Tok {
    return this.toks[this.i]!;
  }
  private at(kind: TokKind): boolean {
    return this.peek().kind === kind;
  }
  private atKw(kw: string): boolean {
    const t = this.peek();
    return t.kind === "kw" && t.text === kw;
  }
  private eat(kind: TokKind): boolean {
    if (this.at(kind)) { this.advance(); return true; }
    return false;
  }
  private eatKw(kw: string): boolean {
    if (this.atKw(kw)) { this.advance(); return true; }
    return false;
  }
  private expect(kind: TokKind): Tok {
    const t = this.peek();
    if (t.kind !== kind) {
      throw new CgqlParseError(
        `Expected ${kind}, got '${t.text || t.kind}'`,
        t.line, t.col,
      );
    }
    return this.advance();
  }
  private expectKw(kw: string): Tok {
    const t = this.peek();
    if (!(t.kind === "kw" && t.text === kw)) {
      throw new CgqlParseError(
        `Expected '${kw}', got '${t.text || t.kind}'`,
        t.line, t.col,
      );
    }
    return this.advance();
  }
  private expectIdentOrKw(): Tok {
    const t = this.peek();
    if (t.kind === "ident" || t.kind === "kw") return this.advance();
    throw new CgqlParseError(
      `Expected identifier, got '${t.text || t.kind}'`,
      t.line, t.col,
    );
  }
}

// =============================================================================
// Helpers
// =============================================================================

function exprSpan(e: Expr): Span {
  return e.span;
}

function displayOf(e: Expr): string {
  switch (e.type) {
    case "var": return e.name;
    case "prop": return `${e.base}.${e.path.join(".")}`;
    case "fnCall": return `${e.name}(${e.args.map(displayOf).join(",")})`;
    case "lit":
      if (e.value === null) return "null";
      if (typeof e.value === "string") return JSON.stringify(e.value);
      return String(e.value);
    default: return "_expr";
  }
}

// =============================================================================
// Public entry
// =============================================================================

export function parse(src: string, params?: Record<string, string | number | boolean | null>): QueryAST {
  const subbed = substituteParams(src, params);
  const toks = new Lexer(subbed).tokenize();
  return new Parser(toks, subbed).parseQuery();
}

/** Internal export — the engine inspects AST node display names for table columns. */
export const __internal = { displayOf };

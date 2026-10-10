// A small evaluator for GitHub Actions expressions — the `if:` of a workflow
// job — so a test can run a workflow's own condition against a sample event
// instead of matching its text. It covers what the repo's workflows use:
// literals ('text', numbers, true, false, null), context paths
// (github.event.pull_request.number), ! == != && || and parentheses, and the
// functions contains, startsWith, endsWith and fromJSON. As on GitHub, string
// comparisons ignore case. Anything else throws, so a workflow that starts
// using more fails its test rather than passing by accident.

type Value = unknown;

const FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  contains: (haystack, needle) =>
    Array.isArray(haystack)
      ? haystack.some((item) => equal(item, needle))
      : text(haystack).toLowerCase().includes(text(needle).toLowerCase()),
  startsWith: (s, prefix) => text(s).toLowerCase().startsWith(text(prefix).toLowerCase()),
  endsWith: (s, suffix) => text(s).toLowerCase().endsWith(text(suffix).toLowerCase()),
  fromJSON: (json) => JSON.parse(text(json)),
};

function text(v: Value): string {
  return v === null || v === undefined ? "" : String(v);
}

function equal(a: Value, b: Value): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return (a ?? null) === (b ?? null);
}

function truthy(v: Value): boolean {
  return !(v === false || v === 0 || v === "" || v === null || v === undefined || Number.isNaN(v));
}

/** Evaluates `expression` (with or without its `${{ }}`) against `context`. */
export function evaluate(expression: string, context: Record<string, Value>): Value {
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const tokens = source.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[!(),]|[A-Za-z_][\w.-]*|-?\d+(?:\.\d+)?|\S/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = (want?: string) => {
    const t = tokens[at++];
    if (want !== undefined && t !== want) throw new Error(`expected ${want}, got ${t ?? "the end"} in ${source}`);
    return t!;
  };

  const or = (): Value => {
    let v = and();
    while (peek() === "||") { take(); const r = and(); v = truthy(v) ? v : r; }
    return v;
  };
  const and = (): Value => {
    let v = comparison();
    while (peek() === "&&") { take(); const r = comparison(); v = truthy(v) ? r : v; }
    return v;
  };
  const comparison = (): Value => {
    const left = unary();
    if (peek() === "==" || peek() === "!=") {
      const op = take();
      const same = equal(left, unary());
      return op === "==" ? same : !same;
    }
    return left;
  };
  const unary = (): Value => (peek() === "!" ? (take(), !truthy(unary())) : primary());
  const primary = (): Value => {
    const t = take();
    if (t === "(") { const v = or(); take(")"); return v; }
    if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
    if (/^-?\d/.test(t)) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    if (t === "null") return null;
    if (peek() === "(") {
      const fn = FUNCTIONS[t];
      if (!fn) throw new Error(`unsupported function ${t} in ${source}`);
      take("(");
      const args: Value[] = [];
      while (peek() !== ")") { args.push(or()); if (peek() === ",") take(","); }
      take(")");
      return fn(...args);
    }
    if (/^[A-Za-z_]/.test(t)) {
      return t.split(".").reduce<Value>((obj, key) => (obj as Record<string, Value> | undefined)?.[key], context);
    }
    throw new Error(`unsupported token ${t} in ${source}`);
  };

  const result = or();
  if (at !== tokens.length) throw new Error(`unexpected ${peek()} in ${source}`);
  return result;
}

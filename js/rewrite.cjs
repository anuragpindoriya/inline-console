// Finds console.log/info/warn/error/debug( calls in JS/TS/JSX source and inserts a prefix right
// after the opening paren, e.g. console.log(x) -> console.log(<prefix(line)>x). Lines are 1-based.
// ponytail: a small lexer, not a parser. Strings/comments/templates/regexes are skipped; quoted
// strings never run past a newline, so odd quoting (JSX text like Don't) only costs that line.
const KINDS = /^console\.(log|info|warn|error|debug)\s*\(/;
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;
const isId = (ch) => ch !== undefined && /[\w$]/.test(ch);

function rewriteConsoleCalls(code, prefixFor) {
  const inserts = [];
  let i = 0, line = 1, prev = '';
  const n = code.length;

  function skipQuoted(q) {
    for (i++; i < n; i++) {
      const ch = code[i];
      if (ch === '\\') { if (code[i + 1] === '\n') line++; i++; continue; }
      if (ch === q) { i++; return; }
      if (ch === '\n') return;
    }
  }

  function skipTemplate() {
    for (i++; i < n; i++) {
      const ch = code[i];
      if (ch === '\\') { if (code[i + 1] === '\n') line++; i++; continue; }
      if (ch === '`') { i++; return; }
      if (ch === '\n') line++;
      if (ch === '$' && code[i + 1] === '{') { i += 2; scan(true); i--; }
    }
  }

  function skipRegex() {
    let inClass = false;
    for (i++; i < n; i++) {
      const ch = code[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '\n') return;
      if (inClass) { if (ch === ']') inClass = false; }
      else if (ch === '[') inClass = true;
      else if (ch === '/') { i++; while (isId(code[i])) i++; return; }
    }
  }

  function scan(untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = code[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && code[i + 1] === '/') { while (i < n && code[i] !== '\n') i++; continue; }
      if (c === '/' && code[i + 1] === '*') {
        const end = code.indexOf('*/', i + 2) < 0 ? n : code.indexOf('*/', i + 2) + 2;
        for (; i < end; i++) if (code[i] === '\n') line++;
        continue;
      }
      if (c === '"' || c === "'") { skipQuoted(c); prev = '"'; continue; }
      if (c === '`') { skipTemplate(); prev = '"'; continue; }
      if (c === '/' && (prev === '' || REGEX_AFTER.has(prev) || REGEX_KEYWORD.test(code.slice(Math.max(0, i - 12), i).trimEnd()))) {
        skipRegex(); prev = '"'; continue;
      }
      if (c === '{') depth++;
      if (c === '}') { if (untilBrace && depth === 0) { i++; return; } depth--; }
      if (c === 'c' && !isId(code[i - 1]) && code[i - 1] !== '.') {
        const m = KINDS.exec(code.slice(i, i + 32));
        if (m) { inserts.push([i + m[0].length, prefixFor(line)]); i += m[0].length; prev = '('; continue; }
      }
      prev = c; i++;
    }
  }

  scan(false);
  if (!inserts.length) return null;
  let out = '', last = 0;
  for (const [pos, text] of inserts) { out += code.slice(last, pos) + text; last = pos; }
  return out + code.slice(last);
}

const parseError = (parse, code) => {
  try {
    parse(code);
    return null;
  } catch (e) {
    return (e && e.message) || String(e);
  }
};

// Like rewriteConsoleCalls, but never hands back code that could crash the app's build:
// { code } is the rewritten source (or null: leave the file untouched), { problem } says why not.
// With a parser, a result that no longer parses is dropped. If the original doesn't parse
// either, that parser can't read this language (TS with a JS parser), so the lexer is trusted.
function safeRewrite(code, prefixFor, parse) {
  let out;
  try {
    out = rewriteConsoleCalls(code, prefixFor);
  } catch (e) {
    return { code: null, problem: `couldn't scan the file (${e && e.message})` };
  }
  if (!out || !parse) return { code: out };
  const error = parseError(parse, out);
  if (!error || parseError(parse, code)) return { code: out };
  return { code: null, problem: `the rewrite would break this file's syntax (${error.split('\n')[0]})` };
}

module.exports = { rewriteConsoleCalls, safeRewrite };

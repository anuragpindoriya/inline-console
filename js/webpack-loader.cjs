// webpack / Turbopack loader (used by inline-console/next). Runs on the original source, before
// SWC/Babel: rewrites console calls to carry their file:line and imports inline-console/runtime,
// whose package "exports" conditions pick the browser, Node or (no-op) edge runtime per bundle.
// ponytail: no source map is returned; only columns move, so line mappings stay right.
const path = require('path');
const { createRequire } = require('module');
const { safeRewrite } = require('./rewrite.cjs');

const OWN_DIR = __dirname + path.sep;
const RUNTIME = 'inline-console/runtime';

// The added import must resolve from the app itself, or the build fails with "Module not found".
// Resolve as a file in the app's root would (not from here: this package always finds itself).
const resolvable = new Map();
function runtimeResolves(root) {
  if (!resolvable.has(root)) {
    let ok = true;
    try {
      createRequire(path.join(root, 'noop.js')).resolve(RUNTIME);
    } catch {
      ok = false;
    }
    resolvable.set(root, ok);
  }
  return resolvable.get(root);
}

// index just past any leading comments and directives ('use client', 'use server', 'use strict'),
// which must stay first in the file
function afterDirectives(code) {
  let i = 0, end = 0;
  for (;;) {
    const rest = code.slice(i);
    const gap = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (gap) { i += gap[0].length; continue; }
    const directive = /^(['"])use [\w -]+\1;?/.exec(rest);
    if (directive) { i += directive[0].length; end = i; continue; }
    return end;
  }
}

// Any failure leaves the file exactly as it was and reports the reason to WebStorm's tab.
module.exports = function inlineConsoleLoader(source) {
  try {
    return rewrite(this.resourcePath, source, this.rootContext || process.cwd());
  } catch (e) {
    try {
      require('./send.cjs').reportProblem('next.js', `${this.resourcePath}: ${e && e.message}. Left this file untouched`);
    } catch {}
    return source;
  }
};

// ponytail: no parser here to double-check the result (Vite has one); the lexer keeps damage to a line
function rewrite(file, source, root) {
  if (!file || /[\\/]node_modules[\\/]/.test(file) || file.startsWith(OWN_DIR)) return source;
  const { code: out, problem } = safeRewrite(source, (line) =>
    `...(globalThis.__icAt?.(${JSON.stringify(file.replace(/\\/g, '/'))},${line})??[]),`);
  if (problem) throw new Error(problem);
  if (!out) return source;
  if (!runtimeResolves(root)) {
    throw new Error(`the app at ${root} can't resolve "${RUNTIME}"; install the package in the app`
      + ' (npm pack in inline-console/js, then npm i -D the .tgz)');
  }
  const commonJs = !/^\s*(?:import|export)\b/m.test(out) && /\b(?:module\.exports|exports\.|require\()/.test(out);
  // same line as the directives, so every line number below stays put
  const load = commonJs ? `require(${JSON.stringify(RUNTIME)});` : `import ${JSON.stringify(RUNTIME)};`;
  const at = afterDirectives(out);
  // leading ';' ends a directive written without one ('use client' + newline)
  return out.slice(0, at) + (at ? ';' : '') + load + out.slice(at);
}

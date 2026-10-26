// Browser console wrapper. Vite injects it as a classic <script> at the top of <head>, so it runs
// before any app module; Next.js bundles it through runtime.browser.cjs instead.
// Console calls are rewritten to console.log(...__icAt(file, line), x): __icAt records where the
// call is, and the console wrapper below pairs that location with the logged values.
// Safety rule: nothing here may break, freeze or slow the app. Every failure is caught, the app's
// own console call always runs, and a problem shows once as an "[inline-console]" warning in the
// browser console (so you know) and in WebStorm's Inline Console tab.
(() => {
  if (window.__icAt) return;
  // the real console methods, for the app's calls and our own warnings (never the wrapped ones)
  const real = {};
  for (const kind of ['log', 'info', 'warn', 'error', 'debug']) real[kind] = console[kind];
  const pending = [];
  const queue = [];
  const problems = new Set();
  let deliver = null, timer = 0, busy = false;

  // Rewritten calls depend on this, so it is total: it never throws and always returns [] to spread,
  // even if everything below failed to start.
  window.__icAt = (file, line) => {
    try {
      if (pending.length > 100) pending.length = 0; // locations left behind by calls that threw
      pending.push([file, line]);
    } catch {}
    return [];
  };

  const flush = () => {
    timer = 0;
    try { if (deliver && queue.length) deliver(queue.splice(0)); } catch {}
  };
  const push = (entry) => {
    if (queue.length >= 1000) queue.shift(); // not connected (yet): keep the newest, never grow unbounded
    queue.push(entry);
    if (!timer) timer = setTimeout(flush, 30);
  };
  const problem = (text) => {
    try {
      if (problems.has(text) || problems.size > 20) return;
      problems.add(text);
      if (typeof real.warn === 'function') real.warn.call(console, `[inline-console] ${text}. Your app is unaffected.`);
      push({ kind: 'problem', source: 'browser', text, ts: Date.now() });
    } catch {}
  };
  // called by the plugin's module once Vite's HMR channel (or Next's fetch) is ready
  window.__icConnect = (fn) => {
    try { deliver = fn; flush(); } catch {}
  };

  try {
    /* @serialize */
    // Vite pastes serialize.cjs above; bundlers resolve the require instead
    const toFull = typeof fullValue === 'function' ? fullValue : require('./serialize.cjs').fullValue;
    // a property for the preview without running its getter (app code, maybe with side effects)
    const property = (v, k, depth) => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (d && !('value' in d)) return d.get ? '[Getter]' : '[Setter]';
      return show(d && d.value, depth + 1);
    };

    let budget = 0; // one-line preview: at most this many values per console call
    const show = (v, depth) => {
      if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
      if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}()`;
      if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? `${v}n` : String(v);
      if (++budget > 2000) return '…';
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (typeof Element !== 'undefined' && v instanceof Element) return `<${v.localName}${v.id ? '#' + v.id : ''}>`;
      if (depth > 3) return Array.isArray(v) ? '[…]' : '{…}';
      try {
        if (Array.isArray(v)) return `[${v.slice(0, 100).map((x) => show(x, depth + 1)).join(', ')}${v.length > 100 ? ', …' : ''}]`;
        if (v instanceof Map) return `Map(${v.size}) {${[...v].slice(0, 100).map(([k, x]) => `${show(k, depth + 1)} => ${show(x, depth + 1)}`).join(', ')}}`;
        if (v instanceof Set) return `Set(${v.size}) {${[...v].slice(0, 100).map((x) => show(x, depth + 1)).join(', ')}}`;
        const ctor = v.constructor && v.constructor.name;
        const name = ctor && ctor !== 'Object' ? ctor + ' ' : '';
        return `${name}{${Object.keys(v).slice(0, 100).map((k) => `${k}: ${property(v, k, depth)}`).join(', ')}}`;
      } catch {
        return '{…}';
      }
    };

    // like the browser console: printf-style %s/%d/%o/%c in the first argument, then the rest
    const format = (args) => {
      budget = 0;
      let rest = args;
      let head = '';
      if (typeof args[0] === 'string' && args[0].includes('%')) {
        let n = 1;
        head = args[0].replace(/%[sdifoOjc%]/g, (t) => (t === '%%' ? '%' : n >= args.length ? t : t === '%c' ? (n++, '') : show(args[n++], 0)));
        rest = args.slice(n);
      } else if (args.length) {
        head = show(args[0], 0);
        rest = args.slice(1);
      }
      return [head, ...rest.map((x) => show(x, 0))].join(' ').slice(0, 20000);
    };

    const capture = (kind, args) => {
      const at = pending.pop();
      const error = args.find((a) => a instanceof Error);
      if (at || kind === 'error' || kind === 'warn') {
        push({
          kind, file: at && at[0], line: at && at[1], text: format(args), values: args.map(toFull),
          stack: error && error.stack, ts: Date.now(), source: 'browser',
        });
      }
    };

    for (const kind of Object.keys(real)) {
      const original = real[kind];
      if (typeof original !== 'function') continue; // nothing to wrap in this environment
      console[kind] = function (...args) {
        if (busy) {
          // logged from inside our own capture (a getter that logs): don't loop back in
          try { pending.pop(); } catch {}
        } else {
          busy = true;
          try {
            capture(kind, args);
          } catch (e) {
            problem(`couldn't capture a console.${kind} call (${e && e.message})`);
          } finally {
            busy = false;
          }
        }
        return original.apply(this, args); // the app's own console call always runs
      };
    }

    const uncaught = (err) => {
      try {
        push({
          kind: 'error', text: err instanceof Error ? `${err.name}: ${err.message}` : `Uncaught ${show(err, 0)}`,
          stack: err && err.stack, ts: Date.now(), source: 'browser', uncaught: true,
        });
      } catch (e) {
        problem(`couldn't capture an uncaught error (${e && e.message})`);
      }
    };
    window.addEventListener('error', (e) => uncaught(e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => uncaught(e.reason));
  } catch (e) {
    problem(`couldn't start in this page (${e && e.message}); console values won't reach WebStorm`);
  }
})();

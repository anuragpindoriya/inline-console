// Node preload: wraps console.* so each call is also sent to WebStorm with the caller's file:line.
// Usage: node --require inline-console/register app.js   (or NODE_OPTIONS="--require inline-console/register")
// Locations come from the call stack, so TypeScript lines are right when source maps are on
// (tsx, ts-node, or node --enable-source-maps). Bundled code (Next.js) is rewritten at build time
// to pass its exact file:line through __icAt instead, since its stacks point into bundles.
// Safety rule, as in the browser client: nothing here may break the app. Failures are caught, the
// app's own console call always runs, and a problem prints once to stderr and to WebStorm's tab.
if (!globalThis.__inlineConsoleNode) {
  globalThis.__inlineConsoleNode = true;

  // Rewritten calls depend on this, so it comes first and is total: never throws, always returns [].
  const pending = [];
  globalThis.__icAt = (file, line) => {
    try {
      if (pending.length > 100) pending.length = 0; // locations left behind by calls that threw
      pending.push({ file, line });
    } catch {}
    return [];
  };

  const say = (text) => {
    try { process.stderr.write(`[inline-console] ${text}. Your app is unaffected.\n`); } catch {}
  };

  try {
    const { formatWithOptions } = require('util');
    const { fileURLToPath } = require('url');
    const { send, flushSync, probe, reportProblem } = require('./send.cjs');
    const { fullValue } = require('./serialize.cjs');
    const problem = (text) => {
      try { if (reportProblem('node', text)) say(text); } catch {}
    };

    const FRAME = /\(?((?:file:\/\/\/?|[A-Za-z]:[\\/]|\/)[^()]*?):(\d+):\d+\)?$/;

    const toLocation = (frameLine) => {
      const m = FRAME.exec((frameLine || '').trim());
      if (!m) return null;
      const file = m[1].startsWith('file:') ? fileURLToPath(m[1]) : m[1];
      if (/[\\/]node_modules[\\/]/.test(file)) return null;
      return { file, line: Number(m[2]) };
    };

    const callerOf = (fn) => {
      const holder = {};
      const limit = Error.stackTraceLimit;
      try {
        Error.stackTraceLimit = 1;
        Error.captureStackTrace(holder, fn);
      } finally {
        Error.stackTraceLimit = limit;
      }
      return toLocation(String(holder.stack).split('\n')[1]);
    };

    // first stack frame that is the user's own code
    const errorLocation = (stack) => {
      for (const frame of String(stack || '').split('\n').slice(1)) {
        const at = toLocation(frame);
        if (at) return at;
      }
      return null;
    };

    const format = (args) => formatWithOptions({ breakLength: Infinity, depth: 4 }, ...args).slice(0, 20000);

    let busy = false;
    for (const kind of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[kind];
      if (typeof original !== 'function') continue;
      console[kind] = function inlineConsole(...args) {
        if (busy) {
          // logged from inside our own capture (a getter that logs): don't loop back in
          try { pending.pop(); } catch {}
        } else {
          busy = true;
          try {
            const at = pending.pop() || callerOf(inlineConsole);
            const error = args.find((a) => a instanceof Error);
            if (at || kind === 'error' || kind === 'warn') {
              send({
                kind, file: at?.file, line: at?.line, text: format(args), values: args.map(fullValue),
                stack: error?.stack, ts: Date.now(), source: 'node',
              });
            }
          } catch (e) {
            problem(`couldn't capture a console.${kind} call (${e && e.message})`);
          } finally {
            busy = false;
          }
        }
        return original.apply(this, args); // the app's own console call always runs
      };
    }

    probe(require('path').basename(process.argv[1] || 'node'));

    // Monitor only: Node's own crash behaviour is unchanged. Unhandled rejections land here too.
    process.on('uncaughtExceptionMonitor', (err) => {
      try {
        const at = errorLocation(err?.stack);
        flushSync({
          kind: 'error', file: at?.file, line: at?.line, text: err instanceof Error ? `${err.name}: ${err.message}` : format([err]),
          stack: err?.stack, ts: Date.now(), source: 'node', uncaught: true,
        });
      } catch {} // the app is already crashing; never add a second error on top
    });
  } catch (e) {
    say(`couldn't start (${e && e.message}); console values won't reach WebStorm`);
  }
}

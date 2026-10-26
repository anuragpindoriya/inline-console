// Server runtime for bundled Node code (Next.js server components, API routes, SSR):
// the same console wrapper as the --require preload, installed once per process.
// Every rewritten module imports this, so it must never throw (register.cjs reports its own problems).
try {
  require('./register.cjs');
} catch (e) {
  try { process.stderr.write(`[inline-console] couldn't start (${e && e.message}). Your app is unaffected.\n`); } catch {}
}

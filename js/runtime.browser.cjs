// Browser runtime for bundled apps (Next.js): the console wrapper from client.browser.js, sending
// straight to WebStorm. A plain-text no-cors POST is a "simple" request, so it needs no CORS preflight.
// Every rewritten module imports this, so it must never throw: a failure here would break the
// import of the app's own module. Problems become a console warning instead.
// ponytail: uncaught errors arrive without a file:line here (no source-map lookup like the Vite plugin
// does); they still show in the tool window with their stack.
try {
  if (typeof window !== 'undefined' && !window.__icAt) {
    require('./client.browser.js');
    const url = 'http://127.0.0.1:' + (window.__INLINE_CONSOLE_PORT__ || 47321) + '/log';
    window.__icConnect((entries) => {
      fetch(url, { method: 'POST', mode: 'no-cors', body: JSON.stringify(entries) }).catch(() => {});
    });
  }
} catch (e) {
  try { console.warn('[inline-console] couldn\'t start in this page; your app is unaffected.', e); } catch {}
}

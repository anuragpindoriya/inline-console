// Zero-config entry. The WebStorm plugin adds one guarded line at the top of Vite's own entry file
// (node_modules/vite/bin/vite.js, or dist/vite/bin/vite.js for Vite+) that imports this module.
// Here, inside the Vite process, the moment Vite loads its config is hooked and inlineConsole() is
// added to the plugins: in memory only, vite.config stays untouched.
// Never throws: any failure leaves Vite exactly as it was. Opt out with INLINE_CONSOLE_AUTO=0.
import module from 'node:module';

try {
  // `vite`, `vite dev`, `vite serve`, `vite <root>` start a dev server; build/preview/optimize don't
  const command = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'dev';
  const devServer = !['build', 'preview', 'optimize'].includes(command);
  if (devServer && process.env.INLINE_CONSOLE_AUTO !== '0' && !globalThis.__inlineConsoleAuto) {
    globalThis.__inlineConsoleAuto = true;
    if (typeof module.register !== 'function') {
      throw new Error(`Node ${process.versions.node} can't hook module loading (needs 18.19+ or 20.6+)`);
    }
    // ES module configs (the usual case): Vite bundles and import()s them; a loader hook wraps that import
    module.register(new URL('./auto-hooks.mjs', import.meta.url));

    // CommonJS configs: Vite require()s them; wrap the export once it compiles
    const { wrapConfig } = await import('./auto-config.mjs');
    const compile = module.Module.prototype._compile;
    module.Module.prototype._compile = function (content, filename) {
      const result = compile.apply(this, arguments);
      try {
        if (/[\\/]vite\.config\.[^\\/]+$/.test(filename)) {
          const original = this.exports && this.exports.__esModule ? this.exports.default : this.exports;
          if (this.exports && this.exports.__esModule) this.exports.default = wrapConfig(original);
          else this.exports = wrapConfig(original);
        }
      } catch {}
      return result;
    };
  }
} catch (e) {
  try {
    process.stderr.write(`[inline-console] auto-connect skipped (${e && e.message}); add inlineConsole() to vite.config instead. Vite is unaffected.\n`);
  } catch {}
}

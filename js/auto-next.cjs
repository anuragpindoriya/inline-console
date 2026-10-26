// Zero-config entry for Next.js (next dev only). The WebStorm plugin adds one guarded line to
// node_modules/next/dist/bin/next that requires this file. It works in two processes:
//  - the `next` CLI: copies this package into the app's node_modules/inline-console (Turbopack only
//    loads loaders and modules from inside the project, and rewritten files import
//    "inline-console/runtime"), then has Next's forked dev server preload that copy;
//  - the dev server: when Next loads next.config, wraps it with withInlineConsole(), in memory only.
// Never throws: any failure leaves Next exactly as it was. Opt out with INLINE_CONSOLE_AUTO=0.
const fs = require('fs');
const path = require('path');

const MARKER = '.inline-console-auto';
const CLI = /[\\/]next[\\/]dist[\\/]bin[\\/]next$/;
const DEV_SERVER = /[\\/]next[\\/]dist[\\/]server[\\/]lib[\\/]start-server\.js$/;
// next.config.js/.mjs/.ts, and next.config.compiled.js (Next runs next.config.ts through SWC under that name)
const CONFIG_FILE = /[\\/]next\.config\.[^\\/]+$/;

const say = (text) => { try { process.stderr.write(`[inline-console] ${text}\n`); } catch {} };

// the user's config (object, function or promise; a transpiled module's exports too) -> wrapped
function wrapConfig(config) {
  try {
    const own = config && config.__esModule && 'default' in config ? config.default : config;
    return require('./next.cjs')(own, { auto: true });
  } catch {
    return config;
  }
}

// Copies this package into <app>/node_modules/inline-console, or reuses one the app installed itself.
// Only a folder carrying our marker is ever written to.
function packageIn(root) {
  const dest = path.join(root, 'node_modules', 'inline-console');
  if (path.resolve(dest) === path.resolve(__dirname)) return dest;
  if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARKER))) {
    if (fs.existsSync(path.join(dest, 'auto-next.cjs'))) return dest;
    throw new Error(`the inline-console package installed in ${dest} predates auto-connect; update or remove it`);
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(__dirname)) {
    if (!/\.(?:c?js|mjs|json)$/.test(name) || name === 'test.cjs') continue;
    const data = fs.readFileSync(path.join(__dirname, name));
    const to = path.join(dest, name);
    let same = false;
    try { same = data.equals(fs.readFileSync(to)); } catch {}
    if (!same) fs.writeFileSync(to, data); // unchanged files keep their timestamps, so nothing rebuilds
  }
  if (!fs.existsSync(path.join(dest, MARKER))) {
    fs.writeFileSync(path.join(dest, MARKER), 'Copied by the Inline Console WebStorm plugin for Next.js auto-connect. Safe to delete.\n');
  }
  return dest;
}

// `next dev` forks its dev server (again after a next.config change); give that one process, not every
// child, a preload of our copy. The copy is checked at each fork: a missing --require file would crash
// the dev server, and `npm install` deletes packages it didn't install.
function preloadIntoDevServer(root) {
  const childProcess = require('child_process');
  const fork = childProcess.fork;
  childProcess.fork = function (modulePath, args, options) {
    try {
      if (DEV_SERVER.test(String(modulePath))) {
        const preload = path.join(packageIn(root), 'auto-next.cjs');
        if (!fs.existsSync(preload)) throw new Error(`${preload} is missing`);
        if (!Array.isArray(args)) [args, options] = [[], args];
        const execArgv = [...((options && options.execArgv) || process.execArgv), '--require', preload];
        return fork.call(this, modulePath, args, { ...options, execArgv });
      }
    } catch (e) {
      say(`auto-connect skipped for this dev server (${e && e.message}). Next.js is unaffected.`);
    }
    return fork.apply(this, arguments);
  };
}

function hookConfigLoading() {
  const module = require('module');
  // next.config.mjs / .js / native .ts: Next import()s them; a loader hook wraps that import
  module.register(require('url').pathToFileURL(path.join(__dirname, 'auto-hooks.mjs')), {
    data: { config: String.raw`\/next\.config\.[cm]?[jt]s$`, wrap: require('url').pathToFileURL(__filename).href },
  });
  // next.config.ts through SWC, and CommonJS configs: wrap the exports once they compile
  const compile = module.Module.prototype._compile;
  module.Module.prototype._compile = function (content, filename) {
    const result = compile.apply(this, arguments);
    try {
      if (CONFIG_FILE.test(filename)) {
        this.exports = this.exports && this.exports.__esModule
          ? { __esModule: true, default: wrapConfig(this.exports.default) }
          : wrapConfig(this.exports);
      }
    } catch {}
    return result;
  };
}

try {
  const script = process.argv[1] || '';
  if (process.env.INLINE_CONSOLE_AUTO !== '0' && !globalThis.__inlineConsoleAutoNext) {
    if (CLI.test(script)) {
      const command = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'dev';
      if (command === 'dev') {
        globalThis.__inlineConsoleAutoNext = true;
        // ponytail: the app is the working directory; `next dev <dir>` from elsewhere isn't hooked
        preloadIntoDevServer(process.cwd());
      }
    } else if (DEV_SERVER.test(script)) {
      globalThis.__inlineConsoleAutoNext = true;
      if (typeof require('module').register !== 'function') {
        throw new Error(`Node ${process.versions.node} can't hook module loading (needs 18.19+ or 20.6+)`);
      }
      hookConfigLoading();
    }
  }
} catch (e) {
  say(`auto-connect skipped (${e && e.message}); add withInlineConsole() to next.config instead. Next.js is unaffected.`);
}

exports.wrapConfig = wrapConfig;

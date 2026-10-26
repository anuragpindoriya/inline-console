// Vite plugin (dev server only). Browser console calls get their file:line added at transform
// time, travel over Vite's own HMR websocket to the dev server, and are forwarded to WebStorm.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { safeRewrite } = require('./rewrite.cjs');
const { originalLine } = require('./sourcemap.cjs');
const { send, probe, reportProblem } = require('./send.cjs');

// A broken install must not take the dev server down: without the client, nothing gets injected.
let CLIENT = '';
let clientProblem = null;
try {
  CLIENT = readFileSync(new URL('./client.browser.js', import.meta.url), 'utf8')
    .replace('/* @serialize */', () => readFileSync(new URL('./serialize.cjs', import.meta.url), 'utf8'));
} catch (e) {
  clientProblem = `couldn't read the browser client (${e && e.message}); browser values won't reach WebStorm`;
}
const VIRTUAL = 'virtual:inline-console';
const EVENT = 'inline-console:entries';
// ponytail: .vue/.svelte skipped — their templates aren't JS, so they need a per-block rewrite.
const SOURCE = /\.(m?[jt]sx?|cjs|cts)$/;

const langOf = (file) => (/\.tsx$/.test(file) ? 'tsx' : /\.[mc]?ts$/.test(file) ? 'ts' : /\.jsx$/.test(file) ? 'jsx' : 'js');

// The config can end up with two copies: one written in vite.config and one added by the zero-config
// hook (possibly from different installs). The first copy in each resolved config does the work.
const claims = (globalThis.__inlineConsoleClaims ??= new WeakMap());

// options.auto: added by the zero-config hook rather than written in vite.config
export default function inlineConsole(options = {}) {
  let server;
  let active = true;
  const graph = () => server.environments?.client?.moduleGraph ?? server.moduleGraph;
  // a problem inside Inline Console: shown in WebStorm's tab and, once, in this terminal
  const problem = (text) => {
    try {
      if (reportProblem('vite', text)) server?.config.logger.warn(`[inline-console] ${text}`, { timestamp: true });
    } catch {}
  };

  // uncaught browser errors only carry a stack into served code: map its first app frame back
  async function locate(entry) {
    if (entry.file || !entry.stack) return entry;
    for (const m of entry.stack.matchAll(/(https?:\/\/[^\s()]+?):(\d+):(\d+)/g)) {
      let url;
      try { url = new URL(m[1]); } catch { continue; }
      const mod = await Promise.resolve(graph().getModuleByUrl(url.pathname + url.search)).catch(() => null);
      if (!mod?.file || mod.file.includes('/node_modules/')) continue;
      const map = mod.transformResult?.map;
      const line = (map?.mappings && originalLine(map, Number(m[2]), Number(m[3]) - 1)) || Number(m[2]);
      return { ...entry, file: mod.file, line };
    }
    return entry;
  }

  const plugin = {
    name: 'inline-console',
    apply: 'serve',
    enforce: 'pre',

    configResolved(config) {
      try {
        if (!claims.has(config)) claims.set(config, plugin);
        active = claims.get(config) === plugin;
      } catch {}
    },

    configureServer(s) {
      if (!active) return;
      server = s;
      if (clientProblem) problem(clientProblem);
      try {
        const hot = s.environments?.client?.hot ?? s.ws;
        hot.on(EVENT, (entries) => {
          if (!Array.isArray(entries)) return;
          for (const entry of entries) locate(entry).then(send, () => send(entry));
        });
        // status line just under Vite's own "ready" banner
        const announce = () => probe(options.auto ? 'vite (auto)' : 'vite', (line) => s.config.logger.info(line));
        if (s.httpServer) s.httpServer.once('listening', () => setTimeout(announce, 150));
        else announce();
      } catch (e) {
        problem(`couldn't hook into this Vite dev server (${e && e.message}); browser values won't reach WebStorm`);
      }
    },

    resolveId(id) {
      if (id === VIRTUAL) return '\0' + VIRTUAL;
    },

    load(id) {
      if (id === '\0' + VIRTUAL) {
        return `if (import.meta.hot && window.__icConnect) window.__icConnect((e) => import.meta.hot.send(${JSON.stringify(EVENT)}, e));`;
      }
    },

    transformIndexHtml() {
      if (!active || !CLIENT) return undefined;
      return [
        { tag: 'script', children: CLIENT, injectTo: 'head-prepend' },
        { tag: 'script', attrs: { type: 'module', src: '/@id/' + VIRTUAL }, injectTo: 'head' },
      ];
    },

    // Whatever happens here, the file is served: worst case untouched, with the reason reported.
    transform(code, id, transformOptions) {
      try {
        if (!active || !CLIENT || transformOptions?.ssr || this.environment?.config?.consumer === 'server') return undefined;
        const file = id.split('?')[0];
        if (file.startsWith('\0') || file.includes('/node_modules/') || !SOURCE.test(file)) return undefined;
        const lang = langOf(file);
        const parse = typeof this.parse === 'function' ? (c) => this.parse(c, { lang, jsx: lang.endsWith('x') }) : null;
        const { code: out, problem: why } = safeRewrite(code,
          (line) => `...(globalThis.__icAt?.(${JSON.stringify(file)},${line})??[]),`, parse);
        if (why) problem(`${file}: ${why}. Left this file untouched, so its console values won't show inline`);
        // only columns move (nothing crosses a line), so the existing line mapping stays valid
        return out ? { code: out, map: null } : undefined;
      } catch (e) {
        problem(`${id}: ${e && e.message}. Left this file untouched`);
        return undefined;
      }
    },
  };
  return plugin;
}

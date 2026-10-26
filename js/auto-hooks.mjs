// Module loader hook, registered inside the dev server by auto.mjs (Vite) or auto-next.cjs (Next.js).
// When the tool imports its config (for Vite the bundled node_modules/.vite-temp/vite.config.*.timestamp-*.mjs,
// or vite.config.* itself with configLoader 'native'), serve a small module in its place: it imports the
// real config and hands it to wrapConfig. Every other module loads untouched.
let CONFIG = /\/vite\.config\.[^/]+\.timestamp-\d+-[0-9a-f]+\.mjs$|\/vite\.config\.[cm]?[jt]s$/;
let WRAP = new URL('./auto-config.mjs', import.meta.url).href;
const MARK = 'inline-console-original';

// Next.js passes its own config file pattern and wrapper module
export function initialize(data) {
  if (data && data.config) {
    CONFIG = new RegExp(data.config);
    WRAP = data.wrap;
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && !url.includes(MARK) && CONFIG.test(new URL(url).pathname)) {
    const original = url + (url.includes('?') ? '&' : '?') + MARK;
    return {
      format: 'module',
      shortCircuit: true,
      // if our wrapper can't load (plugin removed mid-run), the tool gets its config exactly as written
      source: `import * as config from ${JSON.stringify(original)};
let wrap = (c) => c;
try { ({ wrapConfig: wrap } = await import(${JSON.stringify(WRAP)})); } catch {}
export default wrap(config.default);
`,
    };
  }
  return nextLoad(url, context);
}

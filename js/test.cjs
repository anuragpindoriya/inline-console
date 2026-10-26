// Self-check: node test.cjs
// keep the checks away from a running WebStorm (nothing listens on port 9) and quiet
process.env.INLINE_CONSOLE_PORT = '9';
process.env.INLINE_CONSOLE_STATUS = 'offline';
const assert = require('assert');
const { rewriteConsoleCalls } = require('./rewrite.cjs');
const { originalLine } = require('./sourcemap.cjs');

const mark = (code) => rewriteConsoleCalls(code, (line) => `@${line},`);

assert.strictEqual(mark('console.log(a)'), 'console.log(@1,a)');
assert.strictEqual(mark('x;\n  console.warn( 1 )'), 'x;\n  console.warn(@2, 1 )');
assert.strictEqual(mark('console.error()'), 'console.error(@1,)');
assert.strictEqual(mark('"console.log(x)"'), null);
assert.strictEqual(mark("'a\\'console.log(x)'"), null);
assert.strictEqual(mark('// console.log(x)\nconsole.log(y)'), '// console.log(x)\nconsole.log(@2,y)');
assert.strictEqual(mark('/* a\nb */ console.info(1)'), '/* a\nb */ console.info(@2,1)');
assert.strictEqual(mark('`${console.log(1)}` + `\n${x}`; console.debug(2)'), '`${console.log(@1,1)}` + `\n${x}`; console.debug(@2,2)');
assert.strictEqual(mark('if (/console.log\\(/.test(s)) console.log(s)'), 'if (/console.log\\(/.test(s)) console.log(@1,s)');
assert.strictEqual(mark('return /[/]"/g;\nconsole.log(1)'), 'return /[/]"/g;\nconsole.log(@2,1)');
assert.strictEqual(mark('a / b; console.log(a / b)'), 'a / b; console.log(@1,a / b)');
assert.strictEqual(mark("<p>Don't</p>\nconsole.warn(1)"), "<p>Don't</p>\nconsole.warn(@2,1)");
assert.strictEqual(mark('myconsole.log(1); window.console.log(2); console.table(3)'), null);
assert.strictEqual(mark('const f = () => { console.log({ a: 1 }) }'), 'const f = () => { console.log(@1,{ a: 1 }) }');

// sourcemap: "AAAA;AACA" = gen line 1 -> src line 1, gen line 2 -> src line 2; ";;AAEA" = gen line 3 -> src line 3
assert.strictEqual(originalLine({ mappings: 'AAAA;AACA' }, 2, 0), 2);
assert.strictEqual(originalLine({ mappings: 'AAAA;;AAEA' }, 3, 5), 3);
assert.strictEqual(originalLine({ mappings: 'AAAA' }, 9, 0), null);

// serialize: full, copyable values
const { fullValue } = require('./serialize.cjs');
assert.strictEqual(fullValue('plain'), 'plain');
assert.strictEqual(fullValue(42), '42');
assert.strictEqual(fullValue({ a: 1, b: [2] }), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
const loop = { name: 'x' };
loop.self = loop;
assert.deepStrictEqual(JSON.parse(fullValue(loop)), { name: 'x', self: '[Circular]' });
const shared = { id: 1 };
assert.deepStrictEqual(JSON.parse(fullValue({ a: shared, b: shared })), { a: { id: 1 }, b: { id: 1 } }); // repeats aren't cycles
assert.deepStrictEqual(JSON.parse(fullValue({ m: new Map([['k', 1]]), u: undefined })), { m: { '[Map]': [['k', 1]] }, u: '[undefined]' });
assert.strictEqual(JSON.parse(fullValue(new Error('boom'))).message, 'boom');
assert.strictEqual(JSON.parse(fullValue(Array.from({ length: 1005 }, (_, i) => i))).length, 1001);
assert.ok(fullValue('y'.repeat(200000)).endsWith('… (truncated)'));
assert.strictEqual(fullValue({ get g() { throw new Error('never run'); } }), '{\n  "g": "[Getter]"\n}');
let deep = {};
for (let i = 0; i < 30; i++) deep = { d: deep };
assert.match(fullValue(deep), /\{… deeper\}/);

// browser client, loaded both ways: Vite pastes serialize.cjs in; bundlers (Next) require it
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const clientSource = fs.readFileSync(path.join(__dirname, 'client.browser.js'), 'utf8');
for (const [how, code, extra] of [
  ['vite', clientSource.replace('/* @serialize */', () => fs.readFileSync(path.join(__dirname, 'serialize.cjs'), 'utf8')), {}],
  ['bundler', clientSource, { require: (p) => require(path.join(__dirname, p)) }],
]) {
  const sent = [];
  const browserWarnings = [];
  let appLogs = 0;
  // no console.debug here: a missing method must be skipped, not break the install
  const fakeConsole = { log() { appLogs++; }, info() {}, warn(m) { browserWarnings.push(m); }, error() {} };
  const win = { addEventListener() {} };
  // timers fire at once; returning 0 lets the client schedule the next flush like a real browser would
  vm.runInNewContext(code, { window: win, console: fakeConsole, setTimeout: (f) => (f(), 0), ...extra });
  win.__icConnect((entries) => sent.push(...entries));
  win.__icAt('C:/a.js', 3);
  fakeConsole.log('order', { id: 9 });
  assert.strictEqual(sent[0].line, 3, how);
  assert.strictEqual(sent[0].values[1], '{\n  "id": 9\n}', how);
  assert.strictEqual(fakeConsole.debug, undefined, how);
  // the function rewritten code calls is total: odd input never throws, always returns []
  assert.deepStrictEqual(Array.from(win.__icAt(Symbol('x'), {})), [], how);
  // our capture blowing up must not swallow the app's own log; the reason goes to the browser console and WebStorm
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('hostile value'); } });
  fakeConsole.log(hostile);
  assert.strictEqual(appLogs, 2, how);
  assert.ok(sent.some((e) => e.kind === 'problem' && /hostile value/.test(e.text)), how);
  assert.ok(browserWarnings.some((m) => /^\[inline-console\] .*hostile value.*Your app is unaffected/.test(m)), how);
  // logging an object never runs its getters (app code, maybe with side effects)
  let getterRuns = 0;
  win.__icAt('C:/a.js', 7);
  fakeConsole.log({ get lazy() { getterRuns++; return 1; } });
  assert.strictEqual(getterRuns, 0, how);
  assert.match(sent[sent.length - 1].text, /\{lazy: \[Getter\]\}/, how);
  // a toJSON() that logs while we serialize must not loop back into our capture
  win.__icAt('C:/a.js', 8);
  fakeConsole.log({ toJSON() { fakeConsole.log('from toJSON'); return 'json'; } });
  assert.strictEqual(appLogs, 5, how); // hostile, getter object, toJSON object, and the log inside toJSON
  // a value with exponentially many paths (no cycles, shared refs) must not freeze the app's console.log
  let dag = { leaf: true };
  for (let i = 0; i < 40; i++) dag = { a: dag, b: dag, c: dag };
  const started = Date.now();
  fakeConsole.log(dag);
  assert.ok(Date.now() - started < 2000, `${how}: serializing took ${Date.now() - started}ms`);
}

// never connected (no HMR, no WebStorm): the queue stays bounded instead of growing forever
{
  const delivered = [];
  const fakeConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const win = { addEventListener() {} };
  vm.runInNewContext(clientSource.replace('/* @serialize */', () => fs.readFileSync(path.join(__dirname, 'serialize.cjs'), 'utf8')),
    { window: win, console: fakeConsole, setTimeout: () => 1 });
  for (let i = 0; i < 3000; i++) { win.__icAt('C:/a.js', 1); fakeConsole.log(i); }
  win.__icConnect((entries) => delivered.push(...entries));
  assert.ok(delivered.length > 0 && delivered.length <= 1000, `queue held ${delivered.length}`);
}

// a rewrite is never allowed to break the file it touches
const { safeRewrite } = require('./rewrite.cjs');
const jsParse = (c) => new vm.Script(c);
assert.strictEqual(safeRewrite('console.log(1)', (l) => `@${l},`, null).code, 'console.log(@1,1)');
const broken = safeRewrite('console.log(1)', () => '"unclosed,', jsParse);
assert.strictEqual(broken.code, null);
assert.match(broken.problem, /would break/);
// a parser that can't read the language at all (JSX here) doesn't block the rewrite
assert.ok(safeRewrite('const a = <b/>; console.log(a)', () => '...[],', jsParse).code.includes('console.log(...[],a)'));

// webpack/Turbopack loader, against a throwaway app that has the package installed
const os = require('os');
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-app-'));
fs.mkdirSync(path.join(app, 'node_modules'));
fs.symlinkSync(__dirname, path.join(app, 'node_modules', 'inline-console'), 'junction');
const loader = require('./webpack-loader.cjs');
const load = (code, file = 'C:\\app\\page.tsx', root = app) => loader.call({ resourcePath: file, rootContext: root }, code);
// an app that can't resolve the package gets its file back untouched, not a "Module not found" build error
const bareApp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bare-'));
assert.strictEqual(load('console.log(1)', 'C:\\app\\page.tsx', bareApp), 'console.log(1)');
assert.strictEqual(load('const x = 1;'), 'const x = 1;');
assert.strictEqual(load('console.log(1)', 'C:\\app\\node_modules\\x\\i.js'), 'console.log(1)');
assert.strictEqual(load('console.log(1)', path.join(__dirname, 'x.js')), 'console.log(1)'); // never rewrites itself
assert.strictEqual(load("'use client'\nconsole.log(a)"),
  "'use client';import \"inline-console/runtime\";\nconsole.log(...(globalThis.__icAt?.(\"C:/app/page.tsx\",2)??[]),a)");
assert.ok(load('module.exports = () => console.warn(1)').startsWith('require("inline-console/runtime");module.exports'));
assert.ok(load('// header\nimport x from "y";\nconsole.log(x)').startsWith('import "inline-console/runtime";// header\n'));
assert.strictEqual(load(null), null); // any failure hands the source back untouched instead of failing the build

// next.config wrapper
const withInlineConsole = require('./next.cjs');
(async () => {
  assert.deepStrictEqual(await withInlineConsole({ reactStrictMode: true })('phase-production-build', {}), { reactStrictMode: true });
  const dev = await withInlineConsole(() => ({ webpack: (c) => ({ ...c, touched: true }) }))('phase-development-server', {});
  const webpackConfig = dev.webpack({ module: { rules: [] } }, {});
  assert.ok(webpackConfig.touched, 'user webpack() still runs');
  assert.strictEqual(webpackConfig.module.rules[0].enforce, 'pre');
  assert.ok(dev.turbopack.rules['*.tsx'].loaders[0].endsWith('webpack-loader.cjs'));

  // vite transform: rewrites normally, but leaves a file untouched if the result wouldn't parse
  const { pathToFileURL } = require('url');
  const vitePlugin = (await import(pathToFileURL(path.join(__dirname, 'vite.mjs')).href)).default();
  const viaVite = (parse) => vitePlugin.transform.call({ parse }, 'console.log(1)', 'C:/app/src/a.js', {});
  assert.match(viaVite(jsParse).code, /__icAt\?\.\("C:\/app\/src\/a\.js",1\)/);
  assert.strictEqual(viaVite((c) => { if (c.includes('__icAt')) throw new Error('Unexpected token'); }), undefined);
  // anything unexpected inside the transform still serves the file instead of failing the build
  const exploding = { get environment() { throw new Error('boom'); } };
  assert.strictEqual(vitePlugin.transform.call(exploding, 'console.log(1)', 'C:/app/src/a.js', {}), undefined);

  // Node runtime in a real process: total __icAt, no loop through a logging getter, no freeze, app logs intact
  const nodeRun = await new Promise((resolve) => require('child_process').execFile(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(__dirname, 'register.cjs'))});
    const chatty = { toJSON() { console.log('from toJSON'); return 1; }, get lazy() { console.log('GETTER RAN'); return 1; } };
    console.log(...(globalThis.__icAt?.('C:/a.js', 1) ?? []), chatty);
    globalThis.__icAt(Symbol('odd'), {});
    let dag = { leaf: true };
    for (let i = 0; i < 40; i++) dag = { a: dag, b: dag, c: dag };
    const t = Date.now(); console.log(dag);
    console.log(Date.now() - t < 2000 ? 'fast' : 'SLOW');`],
    { env: { ...process.env, INLINE_CONSOLE_STATUS: 'offline' } }, (err, stdout) => resolve({ err, stdout })));
  assert.ifError(nodeRun.err);
  assert.match(nodeRun.stdout, /from toJSON/);
  assert.doesNotMatch(nodeRun.stdout, /GETTER RAN/);
  assert.match(nodeRun.stdout, /fast/);

  // terminal status lines: printed on changes only, and only Inline Console's 204 counts as connected
  // A child process probes a throwaway server three times: up, up again (no repeat line), then gone.
  const http = require('http');
  const { execFile } = require('child_process');
  const statusLines = (status) => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/close' ? 200 : status).end();
      if (req.url === '/close') server.close();
    }).listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      execFile(process.execPath, ['-e', `
        const { probe } = require(${JSON.stringify(path.join(__dirname, 'send.cjs'))});
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        (async () => {
          probe('test'); await wait(300); probe(); await wait(300);
          await fetch('http://127.0.0.1:${port}/close').catch(() => {}); await wait(300);
          probe(); await wait(300);
        })();`],
      { env: { ...process.env, INLINE_CONSOLE_PORT: String(port), INLINE_CONSOLE_STATUS: '', NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve(stderr.trim().split('\n')));
    });
  });
  const ours = await statusLines(204);
  assert.strictEqual(ours.length, 2, ours.join('\n'));
  assert.match(ours[0], /\[Inline Console\] ● connected to WebStorm on 127\.0\.0\.1:\d+ · test/);
  assert.match(ours[1], /lost WebStorm/);
  const someoneElse = await statusLines(404); // another program on the port isn't WebStorm
  assert.strictEqual(someoneElse.length, 1, someoneElse.join('\n'));
  assert.match(someoneElse[0], /WebStorm isn't listening/);

  // zero-config: the user's config (object, function or promise) comes back with inlineConsole() added
  const { wrapConfig } = await import(pathToFileURL(path.join(__dirname, 'auto-config.mjs')).href);
  const userPlugin = { name: 'user' };
  for (const config of [{ plugins: [userPlugin] }, () => ({ plugins: [userPlugin] }), Promise.resolve({ plugins: [userPlugin] })]) {
    const wrapped = await wrapConfig(config)({ command: 'serve', mode: 'development' });
    assert.strictEqual(wrapped.plugins[0].name, 'inline-console');
    assert.deepStrictEqual(wrapped.plugins[1], [userPlugin]);
  }
  assert.strictEqual(await wrapConfig(undefined)({}), undefined); // a broken config stays Vite's to report
  await assert.rejects(wrapConfig(() => { throw new Error('user bug'); })({}), /user bug/);
  // two copies in one resolved config (auto + vite.config): only the first does anything
  const [first, second] = [vitePlugin, (await import(pathToFileURL(path.join(__dirname, 'vite.mjs')).href)).default({ auto: true })];
  const resolvedConfig = {};
  first.configResolved(resolvedConfig);
  second.configResolved(resolvedConfig);
  assert.ok(first.transformIndexHtml());
  assert.strictEqual(second.transformIndexHtml(), undefined);
  // the loader hook swaps in a wrapper for Vite's bundled config, and nothing else
  const { load } = await import(pathToFileURL(path.join(__dirname, 'auto-hooks.mjs')).href);
  const next = (url) => ({ format: 'module', source: `/* untouched ${url} */` });
  const bundled = 'file:///C:/app/node_modules/.vite-temp/vite.config.ts.timestamp-1761456000000-1a2b3c4d5e.mjs';
  const swapped = await load(bundled, {}, next);
  assert.match(swapped.source, /inline-console-original/);
  assert.match(swapped.source, /export default wrap\(config\.default\)/);
  assert.match((await load(bundled + '?inline-console-original', {}, next)).source, /untouched/);
  assert.match((await load('file:///C:/app/src/main.js', {}, next)).source, /untouched/);

  // Next.js zero-config: the loader hook takes Next's pattern; a config is wrapped once even if wrapped twice
  const nextHooks = await import(pathToFileURL(path.join(__dirname, 'auto-hooks.mjs')).href + '?next');
  nextHooks.initialize({ config: String.raw`\/next\.config\.[cm]?[jt]s$`, wrap: 'file:///wrap.cjs' });
  assert.match((await nextHooks.load('file:///C:/app/next.config.mjs', {}, next)).source, /"file:\/\/\/wrap\.cjs"/);
  assert.match((await nextHooks.load(bundled, {}, next)).source, /untouched/);
  const { wrapConfig: wrapNext } = require('./auto-next.cjs'); // outside `next`, requiring it only defines exports
  const devPhase = 'phase-development-server';
  const once = await wrapNext(withInlineConsole({ reactStrictMode: true }))(devPhase, {});
  assert.strictEqual(once.webpack({ module: { rules: [] } }, {}).module.rules.length, 1, 'one loader rule, not two');
  const transpiled = { __esModule: true, default: () => ({ basePath: '/b' }) }; // next.config.ts through SWC
  assert.strictEqual((await wrapNext(transpiled)(devPhase, {})).basePath, '/b');
  assert.deepStrictEqual(await wrapNext({ basePath: '/b' })('phase-production-build', {}), { basePath: '/b' });

  // remove the throwaway apps: the junction itself first, so nothing ever walks into this package
  fs.rmdirSync(path.join(app, 'node_modules', 'inline-console'));
  fs.rmSync(app, { recursive: true });
  fs.rmSync(bareApp, { recursive: true });
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });

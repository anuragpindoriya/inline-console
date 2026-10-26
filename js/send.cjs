// Batches log entries and POSTs them as JSON to the Inline Console plugin running in WebStorm.
// If WebStorm isn't listening, entries are dropped silently: the app must never break because of us.
// The terminal gets one colored status line whenever the connection to WebStorm changes.
const http = require('http');

const PORT = Number(process.env.INLINE_CONSOLE_PORT) || 47321;
const queue = [];
let timer = null;

const color = 'FORCE_COLOR' in process.env
  ? process.env.FORCE_COLOR !== '0'
  : Boolean(process.stderr.isTTY) && !('NO_COLOR' in process.env);
const paint = (codes, text) => (color ? `\x1b[${codes}m${text}\x1b[0m` : text);
let print = (line) => process.stderr.write(line + '\n');
let label = '';
// inherited through the environment, so child processes (npm -> node) don't repeat the same line
let status = process.env.INLINE_CONSOLE_STATUS || null;

function setStatus(next) {
  if (next === status) return;
  const before = status;
  status = process.env.INLINE_CONSOLE_STATUS = next;
  const badge = color ? paint('1;97;45', ' Inline Console ') : '[Inline Console]';
  const where = `127.0.0.1:${PORT}`;
  const from = label ? paint('2', ` · ${label}`) : '';
  if (next === 'connected') {
    print(`  ${badge} ${paint('32', '●')} ${paint('1', 'connected to WebStorm')} on ${where}${from} — console values show inline`);
  } else if (before === 'connected') {
    print(`  ${badge} ${paint('33', '○')} lost WebStorm on ${where}${from} — values come back once it's running again`);
  } else {
    print(`  ${badge} ${paint('33', '○')} WebStorm isn't listening on ${where}${from} — open it with the Inline Console plugin to see values inline`);
  }
}

// Inline Console answers a batch with 204; anything else on the port doesn't count as connected.
function post(body) {
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: '/log', method: 'POST', agent: false,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, (res) => {
    res.resume();
    setStatus(res.statusCode === 204 ? 'connected' : 'offline');
  });
  req.on('error', () => setStatus('offline'));
  req.setTimeout(1000, () => req.destroy()); // never hold the process open on a stuck port
  req.end(body);
}

// Says hello to WebStorm right away (so its tab shows who connected) and prints the status line.
// name: what's connecting (vite, next.js, a script); logger: where to print instead of stderr.
// The first name wins and the hello goes once per process: Next.js loads its config twice and then the
// server runtime probes too, from a bundled second copy of this file (hence globalThis); later probes
// only re-check the connection.
const hello = (globalThis.__inlineConsoleHello ??= { name: '', sent: false });
function probe(name, logger) {
  if (name && !hello.name) hello.name = name;
  label = hello.name;
  if (logger) print = logger;
  const who = label || 'node';
  post(JSON.stringify(hello.sent ? [] : [{
    kind: 'hello', source: who, text: `${who} connected from ${process.cwd()} (pid ${process.pid})`, ts: Date.now(),
  }]));
  hello.sent = true;
}

function send(entry) {
  queue.push(entry);
  if (!timer) timer = setTimeout(flush, 30);
}

// A problem inside Inline Console itself, shown in WebStorm's Inline Console tab.
// Returns false for a message already reported, so callers can print it once too.
const reported = new Set();
function reportProblem(source, text) {
  if (reported.has(text) || reported.size > 50) return false;
  reported.add(text);
  send({ kind: 'problem', source, text, ts: Date.now() });
  return true;
}

function flush() {
  clearTimeout(timer);
  timer = null;
  if (queue.length) post(JSON.stringify(queue.splice(0)));
}

// For crash and process.exit() paths, where no more event-loop turns happen:
// hand the batch to a short-lived child node process that posts it synchronously for us.
function flushSync(extra) {
  if (extra) queue.push(extra);
  if (!queue.length) return;
  const script = `const r=require('http').request({host:'127.0.0.1',port:${PORT},path:'/log',method:'POST',agent:false},()=>{});`
    + `r.on('error',()=>{});r.end(require('fs').readFileSync(0))`;
  try {
    require('child_process').execFileSync(process.execPath, ['-e', script], {
      input: JSON.stringify(queue.splice(0)), timeout: 2000, stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  } catch {}
}

process.on('beforeExit', flush);
process.on('exit', () => flushSync());

module.exports = { send, flushSync, probe, reportProblem };

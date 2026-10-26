// One console argument -> its full, copyable text: strings as-is, objects/arrays as pretty JSON.
// Shared by the Node preload and the browser client (vite.mjs pastes this file into it), so it
// stays plain, dependency-free JavaScript.
// ponytail: fixed caps keep huge objects from slowing the app or bloating the IDE. The node budget
// matters most: depth x width can explode (a store, a React tree), and serializing runs inside the
// app's own console.log call, so it must stay cheap no matter what is logged.
const MAX_ITEMS = 1000;
const MAX_CHARS = 100000;
const MAX_DEPTH = 12;
const MAX_NODES = 20000;

// a property's value without running a getter: accessors show as [Getter] / [Setter]
function dataOf(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d) return undefined;
  if ('value' in d) return d.value;
  return d.get ? '[Getter]' : '[Setter]';
}

function fullValue(v) {
  if (typeof v === 'string') return v.length > MAX_CHARS ? v.slice(0, MAX_CHARS) + '\n… (truncated)' : v;
  if (typeof v === 'bigint') return v + 'n';
  if (typeof v === 'function') return 'ƒ ' + (v.name || 'anonymous') + '()';
  if (v === null || typeof v !== 'object') return String(v);
  // path from the root to the current value: each object as given, and the copy JSON.stringify walks
  const ancestors = [];
  let nodes = 0;
  let text;
  try {
    text = JSON.stringify(v, function (key, x) {
      if (typeof x === 'bigint') return x + 'n';
      if (typeof x === 'function') return 'ƒ ' + (x.name || 'anonymous') + '()';
      if (x === undefined) return key === '' ? x : '[undefined]';
      if (x === null || typeof x !== 'object') return x;
      if (typeof Element !== 'undefined' && x instanceof Element) return '<' + x.localName + (x.id ? '#' + x.id : '') + '>';
      if (typeof window !== 'undefined' && x === window) return '[Window]';
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(x)) return '<Buffer ' + x.length + ' bytes>';
      while (ancestors.length && ancestors[ancestors.length - 1].copy !== this) ancestors.pop();
      if (ancestors.some((a) => a.given === x)) return '[Circular]';
      if (ancestors.length >= MAX_DEPTH) return Array.isArray(x) ? '[… deeper]' : '{… deeper}';
      if (++nodes > MAX_NODES) return '… (too large, cut here)';
      let out = x;
      if (x instanceof Error) out = { name: x.name, message: x.message, stack: x.stack };
      else if (x instanceof Map) out = { '[Map]': Array.from(x).slice(0, MAX_ITEMS) };
      else if (x instanceof Set) out = { '[Set]': Array.from(x).slice(0, MAX_ITEMS) };
      else if (Array.isArray(x) && x.length > MAX_ITEMS) out = x.slice(0, MAX_ITEMS).concat('… ' + (x.length - MAX_ITEMS) + ' more');
      else if (!Array.isArray(x)) {
        // copy own data properties only: getters are app code with possible side effects (lazy
        // loading, state tracking), so logging an object must never run them
        const keys = Object.keys(x);
        out = {};
        for (const k of keys.slice(0, MAX_ITEMS)) out[k] = dataOf(x, k);
        if (keys.length > MAX_ITEMS) out['…'] = keys.length - MAX_ITEMS + ' more keys';
      }
      ancestors.push({ given: x, copy: out });
      return out;
    }, 2);
  } catch (e) {
    text = '[unserializable: ' + (e && e.message) + ']';
  }
  if (text === undefined) text = String(v);
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n… (truncated)' : text;
}

if (typeof module !== 'undefined') module.exports = { fullValue, dataOf };

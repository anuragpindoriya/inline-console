// Maps a generated (line, column) back to the original source line using a v3 source map.
// Used for uncaught browser errors, whose stack frames point at Vite-transformed code.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeSegment(segment) {
  const out = [];
  let value = 0, shift = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else { out.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
  }
  return out;
}

// line is 1-based, column 0-based; returns the 1-based original line or null.
function originalLine(map, line, column) {
  const lines = map.mappings.split(';');
  if (line < 1 || line > lines.length) return null;
  let srcLine = 0, best = null, first = null;
  for (let l = 0; l < line; l++) {
    let col = 0;
    for (const segment of lines[l].split(',')) {
      if (!segment) continue;
      const [dCol, , dLine] = decodeSegment(segment);
      col += dCol;
      if (dLine === undefined) continue;
      srcLine += dLine;
      if (l === line - 1) {
        first ??= srcLine + 1;
        if (col <= column) best = srcLine + 1;
      }
    }
  }
  return best ?? first;
}

module.exports = { originalLine };

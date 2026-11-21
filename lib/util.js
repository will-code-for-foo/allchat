'use strict';
// Small pure helpers shared by every edition of the bot. Written in ES2018 (CommonJS) so that Node 10.17 can run them:
// no ?. / ?? / replaceAll / .at() / flatMap here.

// `a ?? b`: only null/undefined fall through (0, '' and false are kept).
const dflt = (value, fallback) => (value == null ? fallback : value);
const coalesce = (...values) => {
  for (const v of values) if (v != null) return v;
  return undefined;
};

// Node 10 has only English ICU: toLocaleTimeString('pl-PL') would print "4:05:06 PM". Format by hand: 16:05:06.
const pad2 = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const plDateTime = (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}, ${clock(d)}`;

// V8 in Node 10 sorts arrays longer than 10 items unstably; modern Node is stable. Keep the modern behaviour everywhere.
const stableSort = (arr, cmp) => arr.map((v, i) => [v, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map((p) => p[0]);

// JSON.parse that never throws and never returns a non-object (an empty / HTML / "null" body becomes {}).
function parseJsonObject(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' ? v : {};
  } catch (_e) {
    return {};
  }
}

module.exports = { dflt, coalesce, pad2, clock, plDateTime, stableSort, parseJsonObject };

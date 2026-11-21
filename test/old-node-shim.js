'use strict';
// Preloaded into the BOT process (not the test runner) with `node -r old-node-shim.js bot.js`, on a NEW Node, to
// imitate Node 10.17 as far as that can be done without Node 10: everything Node 10 does not have is taken away,
// so a stray modern call fails here with a TypeError / "Cannot find module" instead of on the phone.
// It cannot check syntax (?. ?? ...): test/check-syntax.js does that. It does not replace a run on a real Node 10.
const Module = require('module');

// Node's own modules use newer array methods while they LOAD (node:http calls methods.toSorted()). Load the ones the
// bot needs first, while everything still exists; only the bot's own code runs after the removal below.
['http', 'https', 'fs', 'path', 'util', 'url', 'readline', 'os', 'events', 'stream', 'net', 'tls', 'zlib', 'crypto', 'dns',
  'string_decoder', 'buffer', 'child_process'].forEach((name) => require(name));

function drop(target, names) {
  names.forEach((name) => {
    try { delete target[name]; } catch (_e) { /* ignore */ }
    if (name in target) { try { Object.defineProperty(target, name, { value: undefined, configurable: true }); } catch (_e) { /* ignore */ } }
  });
}

// globals added after Node 10
drop(global, ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'AbortController', 'AbortSignal', 'structuredClone',
  'queueMicrotask', 'globalThis', 'BroadcastChannel', 'Blob', 'WebSocket', 'navigator']);
// language / library additions after Node 10 (V8 6.8): flat/flatMap (Node 11), fromEntries/matchAll (12),
// allSettled/replaceAll (15), any/at/hasOwn (16), findLast/toSorted/... (18-20), URLSearchParams#size (19)
drop(Array.prototype, ['flat', 'flatMap', 'at', 'findLast', 'findLastIndex', 'toSorted', 'toReversed', 'toSpliced', 'with']);
drop(String.prototype, ['replaceAll', 'at', 'matchAll', 'isWellFormed', 'toWellFormed']);
drop(Object, ['fromEntries', 'hasOwn', 'groupBy']);
drop(Promise, ['allSettled', 'any', 'withResolvers']);
drop(URLSearchParams.prototype, ['size']);
drop(process, ['loadEnvFile']);
drop(require('util'), ['parseEnv', 'styleText']);

// Node 10 has only the English ICU data: toLocaleTimeString('pl-PL') would print "4:05:06 PM". Fail loudly instead.
['toLocaleTimeString', 'toLocaleString', 'toLocaleDateString'].forEach((name) => {
  Date.prototype[name] = function () { throw new Error(`Date#${name}: Node 10 has no pl-PL locale data, format the date by hand`); };
});

// Node 10's V8 sorts arrays longer than 10 items UNSTABLY. Reversing first makes any code that silently relies on
// stable order (ties keeping their original order) produce a different result here, and so fail a test.
const nativeSort = Array.prototype.sort;
Array.prototype.sort = function sort(compare) {
  if (typeof compare === 'function' && this.length > 10) this.reverse();
  return nativeSort.call(this, compare);
};

// modules that do not exist in Node 10: the node: prefix (14.18/16), fs/promises (14), timers/promises (15), ...
const missing = /^(node:|fs\/promises$|timers\/promises$|readline\/promises$|stream\/promises$|dns\/promises$|util\/types$|path\/(posix|win32)$|stream\/web$|diagnostics_channel$|test$)/;
const nativeLoad = Module._load;
Module._load = function load(request) {
  if (missing.test(request)) {
    const err = new Error(`Cannot find module '${request}' (does not exist in Node 10)`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return nativeLoad.apply(this, arguments);
};

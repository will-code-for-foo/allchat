'use strict';
// Checks that the code Node 10 has to run (lib/*.js, node10/*.js) is written in the language level Node 10.17 (V8 6.8, ~ES2018) understands,
// and that it does not touch library APIs that came later. Needs the "acorn" parser (any version that knows
// ecmaVersion 2018, e.g. 6.x/7.x). Not a dependency of the bot, only of this check:
//   ACORN=/path/to/node_modules/acorn node test/check-syntax.js        (or: npm i --no-save acorn@7)
const fs = require('fs');
const path = require('path');

let acorn;
try { acorn = require(process.env.ACORN || 'acorn'); } catch (_e) {
  console.error('Brak parsera acorn. Podaj ścieżkę: ACORN=/sciezka/do/node_modules/acorn node test/check-syntax.js');
  process.exit(2);
}

// property names (after a dot) and globals that do not exist in Node 10.17
const PROPS = ['replaceAll', 'flat', 'flatMap', 'at', 'findLast', 'findLastIndex', 'fromEntries', 'matchAll', 'allSettled',
  'hasOwn', 'toSorted', 'toReversed', 'loadEnvFile', 'parseEnv', 'timeout'];
const GLOBALS = ['fetch', 'AbortSignal', 'AbortController', 'structuredClone', 'queueMicrotask', 'globalThis', 'Headers', 'Request', 'Response'];
const MODULE_RE = /^(node:|fs\/promises$|timers\/promises$|readline\/promises$|stream\/promises$|util\/types$)/;

// Everything Node 10 has to run: the shared code in lib/*.js and the entry points in node10/*.js. The modern entry
// points (bot.mjs, setup.mjs, lib/fetch-transport.mjs) use fetch and ?. on purpose and are not checked here.
const root = path.join(__dirname, '..');
const files = [];
['lib', 'node10'].forEach((dir) => {
  fs.readdirSync(path.join(root, dir)).filter((f) => /\.js$/.test(f)).sort().forEach((f) => files.push(`${dir}/${f}`));
});
let problems = 0;

files.forEach((file) => {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const opts = { ecmaVersion: 2018, sourceType: 'script', allowHashBang: true, locations: true };
  try {
    acorn.parse(src, opts); // ?. ?? ??= numeric separators, import/export, top-level await, ... fail right here
  } catch (e) {
    problems++;
    console.error(`✗ ${file}: składnia ponad ES2018 (${e.message})`);
    return;
  }
  let prev = null;
  let n = 0;
  for (const t of acorn.tokenizer(src, opts)) {
    const label = t.type.label;
    if (label === 'name') {
      const afterDot = prev && prev.type.label === '.';
      if ((afterDot && PROPS.indexOf(t.value) >= 0) || (!afterDot && GLOBALS.indexOf(t.value) >= 0)) {
        problems++;
        console.error(`✗ ${file}:${t.loc.start.line}: "${t.value}" nie istnieje w Node 10`);
      }
    } else if (label === 'string' && MODULE_RE.test(t.value)) {
      problems++;
      console.error(`✗ ${file}:${t.loc.start.line}: moduł "${t.value}" nie istnieje w Node 10`);
    }
    prev = t;
    n++;
  }
  console.log(`✓ ${file}: ${n} tokenów, składnia ES2018, brak późniejszych API`);
});

process.exit(problems ? 1 : 0);

'use strict';
// Node 10 has no process.loadEnvFile (Node 20.12+). Same rules: KEY=value lines, "#" comments, optional quotes,
// and a variable that is already set in the environment is NOT overridden. Throws if the file is missing.
// (Checked against util.parseEnv of Node 24 on quotes, comments, export, empty values and \n escapes.)
const fs = require('fs');

function loadEnvFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m) return;
    let value = m[2];
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'" || quote === '`') && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  });
}

module.exports = { loadEnvFile };

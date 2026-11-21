#!/usr/bin/env node
'use strict';
// Starts the Node 10 bot with the token kept encrypted with gpg: asks for the passphrase, keeps the token only in
// memory (no .env on the disk). Same arguments as node10/bot.js:
//   node run_allchat --dry-run --account=elisa
// The encrypted file is ../allchat-token/.env.gpg (next to this repo); another place: ALLCHAT_TOKEN_FILE=/path/.env.gpg
const path = require('path');
const { loadGpgEnv } = require('./lib/gpg-env');

try {
  loadGpgEnv(path.resolve(process.env.ALLCHAT_TOKEN_FILE || path.join(__dirname, '..', 'allchat-token', '.env.gpg')));
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
require('./node10/bot'); // runs the bot (reads process.argv like node10/bot.js does)

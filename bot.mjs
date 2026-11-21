#!/usr/bin/env node
// Instagram comment bot, edition for Node 20.12+ (the one to use on a normal computer).
//
//   node bot.mjs --list      show recent posts and their ids
//   node bot.mjs --dry-run   read comments, print what it WOULD do, send nothing
//   node bot.mjs             run for real (Ctrl+C to stop, progress is kept in state.json)
//   node bot.mjs --once      one pass and exit
//
// All the logic is in lib/bot-core.js and is shared with the Node 10 edition (node10/bot.js). This file only plugs in
// what modern Node has built in: fetch and process.loadEnvFile. Config, .env, state and logs are the same files.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchRequest } from './lib/fetch-transport.mjs';

const { createBot } = createRequire(import.meta.url)('./lib/bot-core.js');

createBot({
  root: path.dirname(fileURLToPath(import.meta.url)),
  loadEnv: (file) => process.loadEnvFile(file),
  request: fetchRequest,
}).run();

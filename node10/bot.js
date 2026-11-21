#!/usr/bin/env node
'use strict';
// Instagram comment bot, edition for Node 10.17+ (e.g. an old phone running Kali). Run from anywhere:
//
//   node node10/bot.js --list | --dry-run | --once | (no flag = run for real)
//
// All the logic is in lib/bot-core.js and is shared with the modern edition (bot.mjs). This file only plugs in what
// Node 10 lacks: https.request instead of fetch, lib/env.js instead of process.loadEnvFile. It uses the SAME .env,
// config*.json, recipe*.txt, state*.json and logs/ as bot.mjs, from the repository root.
const path = require('path');
const { createBot } = require('../lib/bot-core');
const { httpRequest } = require('../lib/transport');
const { loadEnvFile } = require('../lib/env');

createBot({ root: path.join(__dirname, '..'), loadEnv: loadEnvFile, request: httpRequest }).run();

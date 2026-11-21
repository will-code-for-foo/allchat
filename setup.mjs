#!/usr/bin/env node
// One-off helper (Node 20.12+): short-lived Graph API Explorer token -> long-lived PAGE token, written to .env.
// The flow is in lib/setup-core.js, shared with node10/setup.js.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchRequest } from './lib/fetch-transport.mjs';

const { runSetup } = createRequire(import.meta.url)('./lib/setup-core.js');

runSetup({ root: path.dirname(fileURLToPath(import.meta.url)), request: fetchRequest });

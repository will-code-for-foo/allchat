#!/usr/bin/env node
'use strict';
// One-off helper (Node 10.17+): short-lived Graph API Explorer token -> long-lived PAGE token, written to .env in the
// repository root. The flow is in lib/setup-core.js, shared with setup.mjs.
const path = require('path');
const { runSetup } = require('../lib/setup-core');
const { httpRequest } = require('../lib/transport');

runSetup({ root: path.join(__dirname, '..'), request: httpRequest });

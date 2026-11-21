'use strict';
// One-off helper shared by setup.mjs (Node 20.12+) and node10/setup.js (Node 10.17+): turns a short-lived Graph API
// Explorer token into a long-lived PAGE token (page tokens derived from a long-lived user token do not expire) and
// writes .env. Like the bot, it only needs `root` and `request` from the entry point (see lib/bot-core.js).
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { dflt, parseJsonObject } = require('./util');

const writeFile = promisify(fs.writeFile);

function runSetup({ root, request }) {
  const BASE = `https://graph.facebook.com/${dflt(process.env.API_VERSION, 'v27.0')}`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // the callback form of rl.question works on every Node (readline/promises is Node 17+)
  const ask = (q) => new Promise((resolve) => rl.question(q, (answer) => resolve(answer.trim())));

  async function get(p, params) {
    const url = new URL(`${BASE}/${p}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await request({ method: 'GET', url, headers: {}, body: null, timeoutMs: 30000 });
    const body = parseJsonObject(res.text);
    if (!res.ok || body.error) throw new Error(body.error && body.error.message != null ? body.error.message : `HTTP ${res.status}`);
    return body;
  }

  async function main() {
    console.log('Potrzebuję: ID aplikacji i klucz tajny aplikacji (Meta for Developers -> Ustawienia aplikacji -> Podstawowe)');
    console.log('oraz krótkotrwały token użytkownika z Graph API Explorer (README, krok 3).\n');
    const appId = await ask('App ID: ');
    const appSecret = await ask('App Secret: ');
    const shortToken = await ask('Token użytkownika z Explorera: ');

    const { access_token: longToken } = await get('oauth/access_token', {
      grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken,
    });
    const { data: pages } = await get('me/accounts', {
      access_token: longToken, fields: 'name,access_token,instagram_business_account{id,username}',
    });
    const withIg = pages.filter((p) => p.instagram_business_account);
    if (!withIg.length) throw new Error('Żadna Twoja strona na Facebooku nie ma podpiętego konta Instagram (zawodowego). Zobacz README, krok 1.');

    withIg.forEach((p, i) => console.log(`  ${i + 1}) strona "${p.name}"  ->  @${p.instagram_business_account.username}`));
    const pick = withIg.length === 1 ? withIg[0] : withIg[Number(await ask('Które konto? numer: ')) - 1];
    if (!pick) throw new Error('Nieprawidłowy wybór.');

    const envPath = path.join(root, '.env');
    if (fs.existsSync(envPath)) { fs.copyFileSync(envPath, `${envPath}.bak`); console.log('(stary .env zapisany jako .env.bak)'); }
    await writeFile(envPath, `PAGE_TOKEN=${pick.access_token}\nIG_USER_ID=${pick.instagram_business_account.id}\n`, { mode: 0o600 });
    console.log(`\n✓ Zapisano .env dla @${pick.instagram_business_account.username}. Dalej: npm run media`);
  }

  return main().catch((e) => {
    // fetch hides the reason one level down (e.cause.code), https.request has it on the error itself
    const code = (e.cause && e.cause.code) || e.code;
    const hint = /CERT|ISSUER|SELF_SIGNED|SSL/i.test(String(code))
      ? '\n  (Node nie ufa certyfikatowi serwera, np. stara lista CA. Spróbuj ustawić NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt)' : '';
    console.error(`\n✗ ${e.message}${hint}`);
    process.exitCode = 1;
  }).then(() => rl.close());
}

module.exports = { runSetup };

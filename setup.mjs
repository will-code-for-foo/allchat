#!/usr/bin/env node
// One-off helper: turns a short-lived Graph API Explorer token into a long-lived PAGE token
// (page tokens derived from a long-lived user token do not expire) and writes .env.
import { createInterface } from 'node:readline/promises';
import { writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = `https://graph.facebook.com/${process.env.API_VERSION ?? 'v27.0'}`;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim();

async function get(p, params) {
  const url = new URL(`${BASE}/${p}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body;
}

try {
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

  const envPath = path.join(ROOT, '.env');
  if (existsSync(envPath)) { await copyFile(envPath, `${envPath}.bak`); console.log('(stary .env zapisany jako .env.bak)'); }
  await writeFile(envPath, `PAGE_TOKEN=${pick.access_token}\nIG_USER_ID=${pick.instagram_business_account.id}\n`, { mode: 0o600 });
  console.log(`\n✓ Zapisano .env dla @${pick.instagram_business_account.username}. Dalej: npm run media`);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

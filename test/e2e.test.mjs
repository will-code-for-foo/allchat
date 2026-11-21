// End-to-end test against a fake Graph API: no network, no Instagram account needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bot.mjs');
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const H = 3600e3;

const pathOf = (req) => new URL(req.url, 'http://x').pathname.replace(/^\/v27\.0\//, '');

function startFakeGraph(behaviour = {}) {
  const calls = [];
  const gets = []; // read-only requests: 'count' = cheap comments_count check, 'page' = one page of the comment list
  let dropped = false;
  let countChecks = 0;
  let repliesPosted = 0; // Instagram counts replies in comments_count, so the bot's own replies raise it
  const reqTimes = [];   // arrival time of every request, to check pacing
  // Realistic big post: `bulk` comments, NEWEST FIRST like Instagram, 50 per page. After `newCommentAtCheck` count checks
  // one brand-new comment ('bnew') appears on top.
  const bulkList = () => {
    const list = Array.from({ length: behaviour.bulk }, (_, i) => (
      { id: `b${i}`, username: `user${i}`, text: '❤️', timestamp: ago((i + 1) * 60e3), like_count: 0 }));
    if (behaviour.newCommentAtCheck && countChecks >= behaviour.newCommentAtCheck) {
      list.unshift({ id: 'bnew', username: 'newbie', text: '❤️', timestamp: new Date().toISOString(), like_count: 0 });
    }
    return list;
  };
  const comments = [
    { id: 'c1', username: 'alice', text: '❤️', timestamp: ago(3 * H), like_count: 0 },
    { id: 'c2', username: 'me_baker', text: 'dzięki, przepis w DM!', timestamp: ago(2 * H), like_count: 0 }, // own comment
    { id: 'c3', username: 'bob', text: '❤️', timestamp: ago(1 * H), like_count: 2 },   // liked: answered by hand
    { id: 'c4', username: 'alice', text: '❤️❤️', timestamp: ago(0.5 * H), like_count: 0 }, // duplicate user
    { id: 'c5', username: 'carol', text: '❤️', timestamp: ago(8 * 24 * H), like_count: 0 }, // too old for a DM
  ].map((c) => {
    if (!behaviour.noLikeCount) return c;
    const { like_count, ...rest } = c; // simulate Instagram not returning the field
    return rest;
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const ct = req.headers['content-type'] ?? '';
    const body = ct.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    const reply = (code, obj) => {
      const headers = { 'content-type': 'application/json' };
      if (behaviour.usagePct) headers['x-app-usage'] = JSON.stringify({ call_count: behaviour.usagePct, total_cputime: 1, total_time: 1 });
      if (behaviour.usageSplit) {
        // like the real Meta (see the logs): only DMs carry the app-level meter; reads and public replies carry the
        // business-use-case one
        if (req.method === 'POST' && pathOf(req).endsWith('/messages')) headers['x-app-usage'] = JSON.stringify({ call_count: 95, total_cputime: 1, total_time: 1 });
        else headers['x-business-use-case-usage'] = JSON.stringify({ 123: [{ type: 'instagram', call_count: 1, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0 }] });
      }
      res.writeHead(code, headers); res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== 'Bearer tok') return reply(401, { error: { message: 'bad token', code: 190 } });

    const p = url.pathname.replace(/^\/v27\.0\//, '');
    reqTimes.push(Date.now());
    if (req.method === 'GET' && p === 'IG1') return reply(200, { username: 'me_baker', id: 'IG1' });
    // Instagram Login: /me, in the {data:[...]} shape shown in Meta's docs
    if (req.method === 'GET' && p === 'me') return reply(200, { data: [{ user_id: 'IG1', username: 'me_baker' }] });
    // Unified Login: system-user token, accounts found via /me/assigned_instagram_accounts
    if (req.method === 'GET' && p === 'me/assigned_instagram_accounts') {
      return reply(200, { data: behaviour.accounts ?? [{ id: 'IG1', username: 'me_baker' }] });
    }
    if (req.method === 'GET' && p === 'POST1') {
      countChecks++;
      gets.push('count');
      const bump = behaviour.bumpCountAtCheck && countChecks >= behaviour.bumpCountAtCheck ? 1 : 0; // a new comment arrives
      const total = behaviour.bulk ? bulkList().length : comments.length;
      return reply(200, { id: 'POST1', comments_count: total + repliesPosted + bump });
    }
    if (req.method === 'GET' && p === 'POST1/comments' && behaviour.bulk) {
      gets.push('page');
      const list = bulkList();
      const offset = Number(url.searchParams.get('after') ?? 0);
      const next = offset + 50 < list.length
        ? { next: `http://127.0.0.1:${server.address().port}/v27.0/POST1/comments?after=${offset + 50}` } : undefined;
      return reply(200, { data: list.slice(offset, offset + 50), paging: next });
    }
    if (req.method === 'GET' && p === 'POST1/comments') {
      // two pages, to exercise paging.next
      gets.push('page');
      const second = url.searchParams.get('after') === '1';
      return reply(200, second
        ? { data: comments.slice(2) }
        // the next-page URL carries an access_token on purpose: it must never reach the logs
        : { data: comments.slice(0, 2), paging: { next: `http://127.0.0.1:${server.address().port}/v27.0/POST1/comments?after=1&access_token=SECRETXYZ` } });
    }
    if (behaviour.dropFirstDm && p === 'IG1/messages' && !dropped) { dropped = true; req.socket.destroy(); return; } // connection dies mid-request
    calls.push({ method: req.method, path: p, body, t: Date.now() });
    if (behaviour.hangReply && p.endsWith('/replies')) return; // never answers: the request stays in flight
    const err = behaviour[p];
    if (err) return reply(400, { error: err });
    if (p === 'IG1/messages') return reply(200, { recipient_id: 'x', message_id: 'm' });
    if (p === 'IG1/likes') return reply(200, { success: true });
    if (p.endsWith('/replies')) { repliesPosted++; return reply(200, { id: 'r' }); }
    return reply(404, { error: { message: `unexpected ${req.method} ${p}`, code: 1 } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, gets, reqTimes, port: server.address().port })));
}

// envOverride: a null value removes the variable
function botEnv(port, dir, envOverride = {}) {
  const env = {
    PATH: process.env.PATH, GRAPH_BASE: `http://127.0.0.1:${port}`, PAGE_TOKEN: 'tok', IG_USER_ID: 'IG1',
    BOT_CONFIG: path.join(dir, 'config.json'), STATE_FILE: path.join(dir, 'state.json'),
    ENV_FILE: path.join(dir, 'no-such.env'), // never read the developer's real .env in tests
    LOG_DIR: path.join(dir, 'logs'),         // ...nor write into the real logs/ folder
    ...envOverride,
  };
  for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
  return env;
}

async function runBot({ port, dir, extraArgs = [], envOverride = {} }) {
  const child = spawn(process.execPath, [BOT, '--once', ...extraArgs], { env: botEnv(port, dir, envOverride) });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => child.on('close', r));
  return { code, out };
}

async function setupDir(recipe = 'Przepis: 500 g dyni, 3 jajka, 150 g mąki. Piec 45 min w 180°C 🎃') {
  const dir = await mkdtemp(path.join(tmpdir(), 'igbot-'));
  await writeFile(path.join(dir, 'recipe.txt'), recipe);
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({
    mediaId: 'POST1', delaySeconds: [0, 0], recipeFile: path.join(dir, 'recipe.txt'), replies: ['@{username} wysłane, sprawdź DM'],
  }));
  return dir;
}

test('replies, DMs and likes the right comments, once', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  try {
    const run1 = await runBot({ port, dir });
    assert.equal(run1.code, 0, run1.out);

    const dms = calls.filter((c) => c.path === 'IG1/messages');
    assert.deepEqual(dms.map((c) => c.body.recipient.comment_id), ['c1', 'c3'], 'DM only to alice (once) and bob');
    assert.match(dms[0].body.message.text, /500 g dyni/);

    const replies = calls.filter((c) => c.path.endsWith('/replies'));
    assert.deepEqual(replies.map((c) => c.path), ['c1/replies', 'c3/replies']);
    assert.equal(replies[0].body.message, '@alice wysłane, sprawdź DM');

    const likes = calls.filter((c) => c.path === 'IG1/likes');
    assert.deepEqual(likes.map((c) => c.body.comment_id).sort(), ['c1', 'c3', 'c4', 'c5'], 'likes all but own comment');

    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.match(state.comments.c4.dm, /skipped/);
    assert.match(state.comments.c5.dm, /skipped/);
    assert.equal(state.comments.c2, undefined, 'own comment untouched');

    // second pass must not send anything again
    const before = calls.length;
    const run2 = await runBot({ port, dir });
    assert.equal(run2.code, 0, run2.out);
    assert.equal(calls.length, before, 'idempotent: nothing re-sent');
  } finally { server.close(); }
});

test('a dropped connection does not crash the bot: it waits, retries and loses nothing', async () => {
  const { server, calls, port } = await startFakeGraph({ dropFirstDm: true });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], pollSeconds: 1, networkRetrySeconds: 0.2 });
  const child = spawn(process.execPath, [BOT], { env: botEnv(port, dir) }); // no --once: the real long-running loop
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  let exitCode = null; child.on('close', (c) => { exitCode = c; });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && exitCode === null && !calls.some((c) => c.path === 'c3/replies')) await sleep(100);
    assert.equal(exitCode, null, `the bot must keep running, but it exited with ${exitCode}:\n${out}`);
    assert.match(out, /brak połączenia z Instagramem/);
    assert.match(out, /połączenie wróciło/);
    // the dropped DM was retried: both people got exactly one DM and one public reply
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c1', 'c3']);
    assert.deepEqual(calls.filter((c) => c.path.endsWith('/replies')).map((c) => c.path), ['c1/replies', 'c3/replies']);
  } finally { child.kill('SIGTERM'); server.close(); }
});

test('idle polling is cheap: the comment list is read once, then only a count check; a new comment triggers one refresh', async () => {
  const { server, gets, port } = await startFakeGraph({ bumpCountAtCheck: 4 });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], pollSeconds: 0.3 });
  const child = spawn(process.execPath, [BOT], { env: botEnv(port, dir) });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  let exitCode = null; child.on('close', (c) => { exitCode = c; });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && exitCode === null && gets.filter((g) => g === 'count').length < 8) await sleep(100);
    assert.equal(exitCode, null, `the bot must keep running:\n${out}`);
    const counts = gets.filter((g) => g === 'count').length;
    const pages = gets.filter((g) => g === 'page').length;
    assert.ok(counts >= 8, `expected >= 8 cheap count checks, got ${counts}`);
    // 2 pages for the first read + 1 page (the routine refresh stops after the first page, where nothing is left to do)
    // when the count rose at check 4. The bot's own two replies (which also raise comments_count) and the 6+ other
    // polls must NOT cause a re-read: they cost 1 call each.
    assert.equal(pages, 3, `read ${pages} comment pages, expected 3 (2 for the first read + 1 for one routine refresh)`);
  } finally { child.kill('SIGTERM'); server.close(); }
});

test('routine polls on a big post read only the newest pages, and still catch a brand-new comment', async () => {
  const { server, calls, gets, port } = await startFakeGraph({ bulk: 230, newCommentAtCheck: 6 });
  const dir = await setupDir();
  // start from user100 -> 101 comments to handle in the first (complete) read of 5 pages
  await writeConfig(dir, { startFromUsername: 'user100', delaySeconds: [0, 0], pollSeconds: 0.3 });
  const child = spawn(process.execPath, [BOT], { env: botEnv(port, dir) });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  let exitCode = null; child.on('close', (c) => { exitCode = c; });
  try {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && exitCode === null
      && !(calls.some((c) => c.path === 'bnew/replies') && gets.filter((g) => g === 'count').length >= 12)) await sleep(100);
    assert.equal(exitCode, null, `the bot must keep running:\n${out}`);
    const dms = calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id);
    assert.equal(dms.length, 102, 'user0..user100 and the new comment each get exactly one DM');
    assert.equal(dms.at(-1), 'bnew', 'the brand-new comment was found and answered');
    assert.ok(dms.slice(0, 101).every((id, i) => id === `b${100 - i}`), 'older comments are handled first, oldest to newest');
    // first read: 5 pages (230 comments). The refresh after the new comment: page 1 has the new one, page 2 is all
    // settled -> stop. 2 pages instead of 5.
    const pages = gets.filter((g) => g === 'page').length;
    assert.equal(pages, 7, `read ${pages} comment pages, expected 7 (5 + 2), a full re-read would be 10`);
    assert.match(out, /przeczytane tylko najnowsze/);
  } finally { child.kill('SIGTERM'); server.close(); }
});

test('own call budget: never more than maxCallsPerHour calls in the window, waits instead', async () => {
  const { server, reqTimes, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], maxCallsPerHour: 5, callWindowSeconds: 1 });
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /własny limit 5 zapytań do API na godzinę - czekam/);
    // the work still gets done...
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c1', 'c3']);
    // ...but no 900 ms stretch contains more than 5 requests
    for (const t of reqTimes) {
      const inside = reqTimes.filter((u) => u >= t && u < t + 900).length;
      assert.ok(inside <= 5, `${inside} requests within 900 ms`);
    }
  } finally { server.close(); }
});

test('a real "#4 request limit" is remembered: the learned cap is saved and obeyed after a restart', async () => {
  const { server, calls, port } = await startFakeGraph({
    'IG1/messages': { code: 4, message: '(#4) Application request limit reached' },
  });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], callWindowSeconds: 3600 });
  try {
    const hit = await runBot({ port, dir });
    assert.notEqual(hit.code, 0);
    assert.match(hit.out, /zapamiętuję: limit zapytań aplikacji/);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.ok(state.learnedCap >= 10, `learnedCap = ${state.learnedCap}`);
    assert.ok(Array.isArray(state.calls) && state.calls.length > 0, 'recent calls are saved, so a restart remembers them');

    // restart with a tiny cap and calls "just made": the bot must wait before its first request, not rush in
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ comments: {}, sentTo: {}, learnedCap: 3, calls: [Date.now(), Date.now(), Date.now()] }));
    await writeConfig(dir, { delaySeconds: [0, 0], callWindowSeconds: 1 });
    const before = calls.length;
    const waited = await runBot({ port, dir, envOverride: {} });
    assert.match(waited.out, /własny limit 3 zapytań do API na godzinę - czekam/);
    assert.ok(calls.length >= before);
  } finally { server.close(); }
});

test('Meta reports a high usage of the hourly budget -> the bot slows down and says so, but keeps working', async () => {
  const { server, calls, port } = await startFakeGraph({ usagePct: 95 });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], pauseAtUsagePercent: 85, usagePauseSeconds: 0.2 });
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /zużycie limitu API: 95% - zwalniam/);
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c1', 'c3']);
  } finally { server.close(); }
});

test('usage is read from both Meta headers and the higher one wins', async () => {
  const { server, calls, port } = await startFakeGraph({ usageSplit: true });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], pauseAtUsagePercent: 85, usagePauseSeconds: 0.2 });
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /odczyty 1%/, 'business-use-case header (reads) is parsed');
    assert.match(run.out, /zużycie limitu API: 95% - zwalniam/, 'app header (sends) is parsed and triggers the slowdown');
    // the slowdown message shows the raw numbers and which call carried them, to tell which metric is the high one
    assert.match(run.out, /szczegóły: x-app-usage \{"call_count":95,"total_cputime":1,"total_time":1\} \(z: POST IG1\/messages\)/);
    assert.match(run.out, /✓ dm -> @alice  \[API: \d+\/h · Meta: app 95%, odczyty 1%\]/, 'every send line carries the usage');
    assert.equal(calls.filter((c) => c.path === 'IG1/messages').length, 2);
  } finally { server.close(); }
});

test('--debug explains every request, every page and every decision, and never prints a token', async () => {
  const { server, port } = await startFakeGraph({ usageSplit: true });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], usagePauseSeconds: 0.05 });
  try {
    const run = await runBot({ port, dir, extraArgs: ['--debug'] });
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /→ GET POST1\?fields=comments_count/);
    assert.match(run.out, /← 200 \d+ ms \| x-business-use-case-usage \{"123"/);
    assert.match(run.out, /→ POST IG1\/messages body: \{recipient, message\}/, 'body field NAMES only, never the DM text');
    assert.match(run.out, /← 200 \d+ ms \| x-app-usage \{"call_count":95/);
    assert.match(run.out, /strona 1: 2 komentarzy .*paging\.next: tak/);
    assert.match(run.out, /strona 2: 3 komentarzy .*paging\.next: NIE - to koniec listy/);
    assert.match(run.out, /odfiltrowane: własne 1, poza filtrem 0, już obsłużone 0/);
    assert.match(run.out, /@alice \(c1\), wiek \d+ min, stan: dm=null reply=null like=null/);
    assert.match(run.out, /przerwa \d+ s przed następną osobą/);
    assert.doesNotMatch(run.out, /SECRETXYZ/, 'an access_token inside a paging URL is stripped from the log');
    assert.doesNotMatch(run.out, /Bearer|Przepis: 500 g dyni/, 'no token, no message text');
  } finally { server.close(); }
});

test('the log is visually structured: a header per person, a thin line between DM and reply, a footer', async () => {
  const { server, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0] });
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    const at = (needle, from = 0) => { const i = run.out.indexOf(needle, from); assert.ok(i >= 0, `missing ${needle}\n${run.out}`); return i; };
    const header = at('══════ [2/4 w tej turze] @alice · komentarz sprzed');
    const dm = at('✓ dm -> @alice', header);
    const thin = at('┈┈┈┈┈┈┈┈', dm);
    const reply = at('✓ reply -> @alice', thin);
    const footer = at('└─ @alice: dm ok · reply ok', reply);
    const nextPerson = at('══════ [3/4 w tej turze] @bob', footer);
    assert.ok(header < dm && dm < thin && thin < reply && reply < footer && footer < nextPerson);
    assert.match(run.out, /⏳ przerwa \d+ s przed następną osobą/);
    assert.match(run.out, /└─ @carol: dm pominięto · reply pominięto/, 'a skipped person gets a header and a footer too');
    // pauses only after people who were actually sent something (alice, bob), never after the last person in the round
    assert.equal((run.out.match(/⏳ przerwa/g) ?? []).length, 2);
    assert.match(run.out, /══════ koniec tury: przejrzano 4\. Czuwam;/, 'the end of a round is announced');
  } finally { server.close(); }
});

test('the brake waits before the next DM, never between a DM and its reply; unknown usage is shown as "?", not 0%', async () => {
  const { server, port } = await startFakeGraph({ usageSplit: true });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], pauseAtUsagePercent: 85, usagePauseSeconds: 0.05 });
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    const out = run.out;
    const dmAlice = out.indexOf('✓ dm -> @alice'), replyAlice = out.indexOf('✓ reply -> @alice');
    const brake = out.indexOf('zwalniam'), dmBob = out.indexOf('✓ dm -> @bob');
    assert.ok(dmAlice >= 0 && replyAlice > dmAlice, 'alice gets her DM and then her reply');
    assert.ok(!out.slice(dmAlice, replyAlice).includes('zwalniam'), 'no pause between the DM and the reply');
    assert.ok(brake > replyAlice && brake < dmBob, 'the pause comes before the next person\'s DM');
    assert.match(out, /komentarzy: 5 .*Meta: app \?, odczyty 1%/, 'no app reading yet: "?" instead of a fake 0%');
    assert.match(out, /✓ dm -> @alice .*Meta: app 95%/);
  } finally { server.close(); }
});

test('a DM is saved the moment it is sent: killing the bot while the reply is still in flight loses nothing', async () => {
  const { server, calls, port } = await startFakeGraph({ hangReply: true });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0] });
  const child = spawn(process.execPath, [BOT], { env: botEnv(port, dir) });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !calls.some((c) => c.path === 'c1/replies')) await sleep(50);
    assert.ok(calls.some((c) => c.path === 'c1/replies'), 'the reply request is in flight');
    const closed = new Promise((r) => child.on('close', r));
    child.kill('SIGKILL'); // no chance to run any cleanup code
    await closed;
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.comments.c1.dm, 'ok', 'the DM that went out is on disk');
    assert.ok(state.sentTo.alice, 'and the person is remembered, so a restart will not send her a second one');
  } finally { child.kill('SIGKILL'); server.close(); }
});

test('without --debug the log stays readable but still shows usage and skip reasons', async () => {
  const { server, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0] });
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    assert.doesNotMatch(run.out, /→ GET|← 200|strona 1:/, 'debug lines are off by default');
    assert.match(run.out, /komentarzy: 5 \(2 str\.\), do obsłużenia: 4/);
    assert.match(run.out, /- pomijam dm -> @carol: komentarz starszy niż 7 dni/);
    assert.match(run.out, /- pomijam dm -> @alice: ta osoba już dostała przepis/);
  } finally { server.close(); }
});

test('every API call is written to logs/api.jsonl: path, status, duration, raw usage headers - no secrets', async () => {
  const { server, port } = await startFakeGraph({ usageSplit: true });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], usagePauseSeconds: 0.05 }); // the fake reports 95%: keep the slowdown short
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    const raw = await readFile(path.join(dir, 'logs', 'api.jsonl'), 'utf8');
    const rows = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.length >= 8, `expected a row per call, got ${rows.length}`);
    for (const r of rows) {
      assert.ok(r.t && r.m && r.p && typeof r.s === 'number' && typeof r.ms === 'number', `incomplete row ${JSON.stringify(r)}`);
    }
    const dm = rows.find((r) => r.m === 'POST' && r.p === 'IG1/messages');
    assert.equal(dm.s, 200);
    assert.equal(dm.app.call_count, 95, 'the raw x-app-usage of a send is stored as parsed JSON');
    const read = rows.find((r) => r.m === 'GET' && r.p === 'POST1');
    assert.equal(read.buc['123'][0].call_count, 1, 'the raw x-business-use-case-usage of a read is stored too');
    assert.doesNotMatch(raw, /SECRETXYZ|Bearer|"tok"|Przepis: 500 g dyni|alice|bob/, 'no tokens, message texts or usernames');
  } finally { server.close(); }
});

test('errors are logged with their code, and a network failure with its cause', async () => {
  const { server, port } = await startFakeGraph({ 'IG1/messages': { code: 4, message: '(#4) Application request limit reached' } });
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0] });
  try {
    await runBot({ port, dir });
    const rows = (await readFile(path.join(dir, 'logs', 'api.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const failed = rows.find((r) => r.p === 'IG1/messages');
    assert.equal(failed.s, 400);
    assert.equal(failed.code, 4);
    assert.match(failed.msg, /Application request limit reached/);
  } finally { server.close(); }
});

test('while idle the bot says it is still there', async () => {
  const { server, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [0, 0], pollSeconds: 0.2, heartbeatSeconds: 0.5 });
  const child = spawn(process.execPath, [BOT], { env: botEnv(port, dir) });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !/czuwam: /.test(out)) await sleep(100);
    assert.match(out, /czuwam: \d+ komentarzy \(oczekiwane \d+\), nic nowego  \[API: \d+\/h/);
  } finally { child.kill('SIGTERM'); server.close(); }
});

test('no internet at startup -> clear message, not a stack trace', async () => {
  const dir = await setupDir();
  const { server, port } = await startFakeGraph();
  await new Promise((resolve) => server.close(resolve)); // a port where nothing listens any more
  const run = await runBot({ port, dir });
  assert.notEqual(run.code, 0);
  assert.match(run.out, /Brak połączenia z Instagramem \(ECONNREFUSED\)/);
  assert.doesNotMatch(run.out, /at async|TypeError/);
});

test('a real run spaces comments out by delaySeconds; a dry run does not wait', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { delaySeconds: [1, 1] });
  try {
    const real = await runBot({ port, dir });
    assert.equal(real.code, 0, real.out);
    const dms = calls.filter((c) => c.path === 'IG1/messages'); // c1 and c3 get a DM
    assert.equal(dms.length, 2);
    assert.ok(dms[1].t - dms[0].t >= 900, `DMs were only ${dms[1].t - dms[0].t} ms apart, expected a ~1 s pause`);

    const dir2 = await setupDir();
    await writeConfig(dir2, { delaySeconds: [30, 30] }); // would take a minute if the dry run waited
    const t0 = Date.now();
    const dry = await runBot({ port, dir: dir2, extraArgs: ['--dry-run'] });
    assert.equal(dry.code, 0, dry.out);
    assert.ok(Date.now() - t0 < 10_000, 'dry run must not sleep between comments');
  } finally { server.close(); }
});

test('--dry-run sends nothing and writes no state', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  try {
    const run = await runBot({ port, dir, extraArgs: ['--dry-run'] });
    assert.equal(run.code, 0, run.out);
    assert.equal(calls.length, 0);
    assert.match(run.out, /\[dry-run\] dm -> @alice/);
    await assert.rejects(readFile(path.join(dir, 'state.json')));
  } finally { server.close(); }
});

test('a failing like never blocks the DM', async () => {
  const { server, calls, port } = await startFakeGraph({ 'IG1/likes': { message: '(#200) no permission', code: 200 } });
  const dir = await setupDir();
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    assert.equal(calls.filter((c) => c.path === 'IG1/messages').length, 2);
    assert.equal(calls.filter((c) => c.path === 'IG1/likes').length, 1, 'likes switched off after the permission error');
  } finally { server.close(); }
});

test('Instagram Login: only IG_TOKEN needed, id comes from /me, no likes even if enabled', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({
    mediaId: 'POST1', delaySeconds: [0, 0], recipeFile: path.join(dir, 'recipe.txt'),
    likeComments: true, replies: ['@{username} wysłane, sprawdź DM'],
  }));
  try {
    const run = await runBot({ port, dir, envOverride: { IG_TOKEN: 'tok', PAGE_TOKEN: null, IG_USER_ID: null } });
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c1', 'c3']);
    assert.equal(calls.filter((c) => c.path.endsWith('/replies')).length, 2);
    assert.equal(calls.filter((c) => c.path.endsWith('/likes')).length, 0, 'Instagram Login has no like endpoint');
    assert.match(run.out, /lajkowanie komentarzy wyłączone/);
  } finally { server.close(); }
});

test('Unified Login: META_TOKEN alone, Instagram account found via assigned_instagram_accounts', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  try {
    const run = await runBot({ port, dir, envOverride: { META_TOKEN: 'tok', PAGE_TOKEN: null, IG_USER_ID: null } });
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c1', 'c3']);
    assert.equal(calls.filter((c) => c.path.endsWith('/replies')).length, 2);
  } finally { server.close(); }
});

test('Unified Login: several accounts on the token -> asks for IG_USER_ID instead of guessing', async () => {
  const { server, calls, port } = await startFakeGraph({ accounts: [{ id: 'IG1', username: 'me_baker' }, { id: 'IG9', username: 'other' }] });
  const dir = await setupDir();
  try {
    const run = await runBot({ port, dir, envOverride: { META_TOKEN: 'tok', PAGE_TOKEN: null, IG_USER_ID: null } });
    assert.notEqual(run.code, 0);
    assert.match(run.out, /IG_USER_ID/);
    assert.equal(calls.length, 0, 'sent nothing');
  } finally { server.close(); }
});

test('DM access disabled in Instagram -> stops with the exact fix, sends nothing else, saves nothing', async () => {
  const { server, calls, port } = await startFakeGraph({
    'IG1/messages': { code: 200, message: '(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.' },
  });
  const dir = await setupDir();
  try {
    const run = await runBot({ port, dir });
    assert.notEqual(run.code, 0);
    assert.match(run.out, /Połączone narzędzia/);
    assert.equal(calls.filter((c) => c.path.endsWith('/replies')).length, 0, 'no public "check DM" reply when the DM failed');
    // c5 is older than 7 days (DM skipped, only liked) and is processed first; c1 hit the error and must stay unhandled
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.comments.c1, undefined, 'failed comment is not marked handled, so a rerun retries it');
  } finally { server.close(); }
});

test('--account=second uses META_TOKEN_SECOND / IG_USER_ID_SECOND, never the default account', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  try {
    const run = await runBot({
      port, dir, extraArgs: ['--account=second'],
      envOverride: { META_TOKEN: 'WRONG', IG_USER_ID: 'WRONG', META_TOKEN_SECOND: 'tok', IG_USER_ID_SECOND: 'IG1', PAGE_TOKEN: null },
    });
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c1', 'c3']);
    const noAccount = await runBot({
      port, dir: await setupDir(), envOverride: { META_TOKEN_SECOND: 'tok', PAGE_TOKEN: null, IG_USER_ID: null },
    });
    assert.notEqual(noAccount.code, 0, 'without --account the SECOND variables must not be picked up');
    assert.match(noAccount.out, /Brak tokena/);
  } finally { server.close(); }
});

async function writeConfig(dir, extra) {
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({
    mediaId: 'POST1', delaySeconds: [0, 0], recipeFile: path.join(dir, 'recipe.txt'),
    likeComments: false, replies: ['@{username} wysłane, sprawdź DM'], ...extra,
  }));
}

test('skipIfLikedAtLeast: comments the owner already liked (answered by hand) get nothing', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { skipIfLikedAtLeast: 1 });
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    // c3 (bob) has 2 likes -> skipped; alice gets exactly one DM
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c1']);
    assert.deepEqual(calls.filter((c) => c.path.endsWith('/replies')).map((c) => c.path), ['c1/replies']);
    assert.match(run.out, /pominięte jako polubione: 1/);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.comments.c3, undefined, 'skipped comment is not recorded as handled');
    assert.ok(state.baseline, 'first run records when the bot took over');
  } finally { server.close(); }
});

test('skipIfLikedAtLeast: comments newer than the bot start are never skipped for likes', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { skipIfLikedAtLeast: 1 });
  // the bot "took over" 2h ago: c1 (3h ago) is older, c3 (1h ago, 2 likes from strangers) is newer
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ comments: {}, sentTo: {}, baseline: ago(2 * H) }));
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c1', 'c3']);
  } finally { server.close(); }
});

test('startFromUsername: only that person\'s comment and everything after it is handled', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { startFromUsername: '@Bob' }); // leading @ and case are ignored
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    // c1 (alice) and c5 (carol) are older than bob's c3 -> untouched. c3 and c4 are handled.
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c3', 'c4']);
    assert.match(run.out, /sprzed startu pominięte: 2/);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.start.username, 'bob');
    assert.equal(state.comments.c1, undefined);
    assert.equal(state.comments.c5, undefined);
  } finally { server.close(); }
});

test('startFromUsername: unknown username -> stops and sends nothing', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { startFromUsername: 'nobody_here' });
  try {
    const run = await runBot({ port, dir });
    assert.notEqual(run.code, 0);
    assert.match(run.out, /Nie znalazłem komentarza od @nobody_here/);
    assert.equal(calls.length, 0);
  } finally { server.close(); }
});

test('startFromUsername: the start point is remembered even if that comment disappears', async () => {
  const { server, calls, port } = await startFakeGraph();
  const dir = await setupDir();
  await writeConfig(dir, { startFromUsername: 'ghost' }); // ghost has no comment in the fake any more
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ comments: {}, sentTo: {}, start: { username: 'ghost', timestamp: ago(0.75 * H) } }));
  try {
    const run = await runBot({ port, dir });
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(calls.filter((c) => c.path === 'IG1/messages').map((c) => c.body.recipient.comment_id), ['c4']);
  } finally { server.close(); }
});

test('skipIfLikedAtLeast: no like_count from Instagram -> stops instead of re-sending to everyone', async () => {
  const { server, calls, port } = await startFakeGraph({ noLikeCount: true });
  const dir = await setupDir();
  await writeConfig(dir, { skipIfLikedAtLeast: 1 });
  try {
    const run = await runBot({ port, dir });
    assert.notEqual(run.code, 0);
    assert.match(run.out, /like_count/);
    assert.equal(calls.length, 0, 'sent nothing');
  } finally { server.close(); }
});

test('refuses to run with a recipe over 1000 bytes or the placeholder', async () => {
  const { server, port } = await startFakeGraph();
  try {
    const long = await runBot({ port, dir: await setupDir('ż'.repeat(600)) });
    assert.notEqual(long.code, 0);
    assert.match(long.out, /1200 bajtów/);
    const placeholder = await runBot({ port, dir: await setupDir('TU WKLEJ PRZEPIS') });
    assert.notEqual(placeholder.code, 0);
  } finally { server.close(); }
});

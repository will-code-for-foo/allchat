#!/usr/bin/env node
// Instagram comment bot: for each new comment on one post it
//   1. sends a private reply (DM) with the recipe   (POST /{ig-id}/messages, recipient.comment_id)
//   2. replies publicly "sent, check DM"            (POST /{comment-id}/replies)
//   3. likes the comment                            (POST /{ig-id}/likes, comment_id)
// It POLLS the official Graph API, so it runs on localhost with no public URL / webhook.
//
//   node bot.mjs --list      show recent posts and their ids
//   node bot.mjs --dry-run   read comments, print what it WOULD do, send nothing
//   node bot.mjs             run for real (Ctrl+C to stop, progress is kept in state.json)
//   node bot.mjs --once      one pass and exit
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(process.env.ENV_FILE ?? path.join(ROOT, '.env')); } catch { /* .env is optional if vars are exported */ }

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const ONCE = args.has('--once');

const env = process.env;
// Several accounts in one .env: --account=second (or ACCOUNT=second) reads META_TOKEN_SECOND / IG_USER_ID_SECOND
// and uses config.second.json + state.second.json, so accounts never share settings or progress.
const ACCOUNT = ([...args].find((a) => a.startsWith('--account='))?.slice(10) ?? env.ACCOUNT ?? '').trim();
const SFX = ACCOUNT ? `_${ACCOUNT.toUpperCase()}` : '';
const TAG = ACCOUNT ? `.${ACCOUNT.toLowerCase()}` : '';
// The kind of token you have decides the API host (README explains where each comes from):
//   IG_TOKEN    "Instagram Login"                       -> graph.instagram.com, no comment likes
//   META_TOKEN  "Unified Login" / "Facebook Login"      -> graph.facebook.com (PAGE_TOKEN is the old name)
// With META_TOKEN, IG_USER_ID is optional: it is looked up via /me/assigned_instagram_accounts.
const IG_LOGIN = Boolean(env[`IG_TOKEN${SFX}`]);
const BASE = `${env.GRAPH_BASE ?? (IG_LOGIN ? 'https://graph.instagram.com' : 'https://graph.facebook.com')}/${env.API_VERSION ?? 'v27.0'}`;
const TOKEN = env[`IG_TOKEN${SFX}`] ?? env[`META_TOKEN${SFX}`] ?? env[`PAGE_TOKEN${SFX}`];
let IG_ID = env[`IG_USER_ID${SFX}`];
const STATE_FILE = env.STATE_FILE ?? path.join(ROOT, `state${TAG}.json`);

const cfgPath = env.BOT_CONFIG ?? path.join(ROOT, `config${TAG}.json`);
const cfg = {
  mediaId: '',
  pollSeconds: 60,
  debug: false,                // same as --debug: log every request, response, usage header and decision
  heartbeatSeconds: 300,       // while idle, say "still here" this often
  networkRetrySeconds: 15,     // first wait after the connection drops; doubles up to 5 min
  fullRefreshSeconds: 600,     // re-read the whole comment list at least this often (between: only a cheap count check)
  pauseAtUsagePercent: 85,     // when Meta says this much of the hourly call budget is used, wait
  usagePauseSeconds: 300,      // ...for this long
  maxCallsPerHour: 400,        // our own cap on API calls per hour; lowered automatically after a real "#4" limit
  callWindowSeconds: 3600,     // the window the cap is counted over (only tests change this)
  delaySeconds: [15, 40],      // random pause between comments, keeps us far from rate limits
  likeComments: true,
  publicReply: true,
  oneDmPerUser: true,          // a 2nd comment from the same person does not get a 2nd DM
  triggerRegex: '',            // empty = every comment qualifies; e.g. "❤|przepis"
  startFromUsername: '',       // handle only comments from this person's (oldest) comment onwards; earlier ones are left alone
  skipIfLikedAtLeast: 0,       // 1 = skip comments that already have a like (you liked what you answered by hand); 0 = off
  replies: ['@{username} wysłane, sprawdź DM 💌'],
  recipeFile: 'recipe.txt',
  ...(existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}),
};

const DM_WINDOW_MS = 7 * 24 * 3600e3 - 3600e3; // Meta: private reply allowed within 7 days of the comment
const MAX_TRIES = 3;
const RATE_LIMIT_PAUSE_MS = 30 * 60e3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString('pl-PL'), ...a);
const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const fill = (t, c) => t.replaceAll('{username}', c.username ?? '');

// --debug (or DEBUG=1, or "debug": true in config): also log every request and response, the raw usage headers
// and the reasons behind each decision. Never prints tokens (they travel in a header, and any access_token in a URL is stripped).
const DEBUG = args.has('--debug') || env.DEBUG === '1' || cfg.debug === true;
const dlog = (...a) => {
  if (!DEBUG) return;
  const d = new Date();
  console.log(`${d.toLocaleTimeString('pl-PL')}.${String(d.getMilliseconds()).padStart(3, '0')} ·`, ...a);
};

// Always on: one JSON line per API call in logs/api[.account].jsonl (time, method, path, status, duration, error, raw
// usage headers; never tokens, message texts or usernames). Lets us analyse the rate limit afterwards, e.g. how many
// percent each kind of call costs.
const LOG_DIR = env.LOG_DIR ?? path.join(ROOT, 'logs');
const API_LOG = path.join(LOG_DIR, `api${TAG}.jsonl`);
try {
  mkdirSync(LOG_DIR, { recursive: true });
  if (existsSync(API_LOG) && statSync(API_LOG).size > 5e6) renameSync(API_LOG, `${API_LOG}.1`); // simple rotation
} catch { /* logging must never stop the bot */ }
const apiLog = (rec) => { try { appendFileSync(API_LOG, `${JSON.stringify(rec)}\n`); } catch { /* ignore */ } };

class GraphError extends Error {
  constructor(err, status) {
    super(err.message ?? `HTTP ${status}`);
    this.code = err.code;
    this.status = status;
  }
  get isAuth() { return this.code === 190; }
  get isRateLimit() { return this.status === 429 || [4, 17, 32, 368, 613, 80002, 80006].includes(this.code); }
  get isPermission() { return this.code === 3 || this.code === 10 || (this.code >= 200 && this.code < 300); }
}

// The request never got a proper answer: no internet, DNS failure, connection reset, timeout. Not Instagram's
// fault and usually temporary (Wi-Fi blip, laptop woke from sleep), so the main loop waits and retries.
class NetworkError extends Error {
  constructor(cause) {
    const code = cause?.cause?.code ?? cause?.code ?? cause?.cause?.message ?? cause?.name ?? 'błąd sieci';
    super(String(code));
    this.code = code;
  }
}

// Meta reports how much of the hourly call budget is used (percent) in the x-app-usage and
// x-business-use-case-usage headers. We slow down before 100% instead of being blocked for a long time.
// The two headers come on different endpoints (e.g. reads vs. sends), so each keeps its own last value and the
// higher of the two counts. Otherwise a harmless "1%" from a read would hide a "95%" seen on the previous send.
// What we have learned from the logs: only SENDS (DMs) carry x-app-usage, and its `total_time` is the metric that
// matters (processing time on Meta's side, ~5 s per DM). Public replies and reads do not carry it. So:
//   - a value is `null` (shown as "?") when we have no reading yet or forgot it after a pause, never a fake 0%;
//   - each reading is shown with its age, because the "app" value only refreshes on the next DM;
//   - the brake (throttle) is applied before a DM only, not before a reply or a read.
const usageBySource = { app: null, buc: null };
const usageAt = { app: 0, buc: 0 };          // when each reading arrived
const usageRaw = { app: null, buc: null };   // the headers exactly as Meta sent them (parsed JSON)
const usageFrom = { app: '', buc: '' };      // which call carried them, e.g. "POST 1784…/messages"
let usagePct = 0;
const percentOf = (u) => Math.max(0, ...[u?.call_count, u?.total_cputime, u?.total_time].filter((n) => typeof n === 'number'));
function noteUsage(res, label) {
  try {
    const u = JSON.parse(res.headers.get('x-app-usage') ?? 'null');
    if (u) { usageBySource.app = percentOf(u); usageAt.app = Date.now(); usageRaw.app = u; usageFrom.app = label; }
  } catch { /* header is optional */ }
  try {
    const b = JSON.parse(res.headers.get('x-business-use-case-usage') ?? 'null');
    if (b) {
      usageBySource.buc = Math.max(0, ...Object.values(b).flatMap((list) => list.map(percentOf)));
      usageAt.buc = Date.now(); usageRaw.buc = b; usageFrom.buc = label;
    }
  } catch { /* header is optional */ }
  usagePct = Math.max(usageBySource.app ?? 0, usageBySource.buc ?? 0);
}
const ageLabel = (t) => { const s = (Date.now() - t) / 1000; return s >= 90 ? ` (sprzed ${Math.round(s / 60)} min)` : ''; };
const showPct = (v, at) => (v == null ? '?' : `${v}%${ageLabel(at)}`);
// "Meta: app 34% · odczyty 1%" and, in detail, the raw numbers behind the percentage (which metric is the high one?)
const usageSuffix = () => `[API: ${callsInWindow()}/h · Meta: app ${showPct(usageBySource.app, usageAt.app)}, odczyty ${showPct(usageBySource.buc, usageAt.buc)}]`;
const usageDetail = () => [
  usageRaw.app && `x-app-usage ${JSON.stringify(usageRaw.app)} (z: ${usageFrom.app})`,
  usageRaw.buc && `x-business-use-case-usage ${JSON.stringify(usageRaw.buc)} (z: ${usageFrom.buc})`,
].filter(Boolean).join('; ') || 'brak nagłówków zużycia';
async function throttle() {
  if (usagePct < cfg.pauseAtUsagePercent) return;
  log(`! zużycie limitu API: ${usagePct}% - zwalniam, czekam ${cfg.usagePauseSeconds} s (przed następnym DM)`);
  log(`  szczegóły: ${usageDetail()}; własny licznik: ${callsInWindow()} zapytań w ostatniej godzinie`);
  await sleep(cfg.usagePauseSeconds * 1000);
  usageBySource.app = usageBySource.buc = null; // unknown until the next DM reports it again
  usagePct = 0;
  usageRaw.app = usageRaw.buc = null;
}

// Our own count of API calls in the last hour. Meta's usage headers are not on every response, so this is the
// dependable guard: stay below maxCallsPerHour and, once a real "#4 Application request limit" happens, remember about
// how many calls that was (state.learnedCap) and stay below it. Saved in state.json, so a restart does not forget.
const callTimes = [];
const windowMs = () => cfg.callWindowSeconds * 1000;
function callsInWindow() {
  const cutoff = Date.now() - windowMs();
  while (callTimes.length && callTimes[0] < cutoff) callTimes.shift();
  return callTimes.length;
}
const callCap = () => Math.min(...[cfg.maxCallsPerHour, state.learnedCap].filter((n) => n > 0), Infinity);
async function waitForBudget() {
  while (callsInWindow() >= callCap()) {
    const waitMs = Math.max(callTimes[0] + windowMs() - Date.now() + 200, 200);
    log(`! własny limit ${callCap()} zapytań do API na godzinę - czekam ${Math.ceil(waitMs / 1000)} s`);
    await sleep(waitMs);
  }
}

async function graph(method, endpoint, params = {}, { json = false, throttled = false } = {}) {
  await waitForBudget();
  if (throttled) await throttle(); // only DMs are held back by Meta's usage meter
  callTimes.push(Date.now());
  const url = new URL(endpoint.startsWith('http') ? endpoint : `${BASE}/${endpoint}`);
  const init = { method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else if (json) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(params);
  } else {
    init.body = new URLSearchParams(params);
  }
  // what we log about the call: method, path and query keys/values with any access_token removed; for POSTs only the
  // names of the body fields (a DM text is personal data and long)
  const shownPath = url.pathname.replace(/^\/v[\d.]+\//, '');
  const shownQuery = new URLSearchParams(url.searchParams);
  shownQuery.delete('access_token');
  const label = `${method} ${shownPath}`;
  dlog(`→ ${label}${shownQuery.size ? `?${decodeURIComponent(shownQuery.toString())}` : ''}`
    + `${method !== 'GET' ? ` body: {${Object.keys(params).join(', ')}}` : ''}`);
  const t0 = Date.now();
  const rec = { t: new Date(t0).toISOString(), m: method, p: shownPath };
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    const ne = new NetworkError(e);
    apiLog({ ...rec, s: 0, ms: Date.now() - t0, net: ne.code });
    dlog(`← brak odpowiedzi po ${Date.now() - t0} ms: ${ne.code}`);
    throw ne;
  }
  noteUsage(res, label);
  const body = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;
  const hdr = (name) => { try { return JSON.parse(res.headers.get(name) ?? 'null'); } catch { return res.headers.get(name); } };
  apiLog({
    ...rec, s: res.status, ms,
    ...(body.error ? { code: body.error.code, sub: body.error.error_subcode, msg: body.error.message, trace: body.error.fbtrace_id } : {}),
    app: hdr('x-app-usage') ?? undefined, buc: hdr('x-business-use-case-usage') ?? undefined,
    retry: res.headers.get('retry-after') ?? undefined,
  });
  dlog(`← ${res.status} ${ms} ms${body.error ? ` BŁĄD (#${body.error.code}${body.error.error_subcode ? `/${body.error.error_subcode}` : ''}) ${body.error.message}` : ''}`
    + `${res.headers.get('x-app-usage') ? ` | x-app-usage ${res.headers.get('x-app-usage')}` : ''}`
    + `${res.headers.get('x-business-use-case-usage') ? ` | x-business-use-case-usage ${res.headers.get('x-business-use-case-usage')}` : ''}`
    + `${res.headers.get('retry-after') ? ` | retry-after ${res.headers.get('retry-after')}` : ''}`);
  if (!res.ok || body.error) throw new GraphError(body.error ?? {}, res.status);
  return body;
}

// ---------- state (so a restart never double-sends) ----------
let state = { comments: {}, sentTo: {}, calls: callTimes };
async function loadState() {
  if (!existsSync(STATE_FILE)) return;
  const saved = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  // keep the calls already made in this run (e.g. the startup lookup), add the ones remembered from before
  callTimes.push(...(saved.calls ?? []));
  callTimes.sort((a, b) => a - b);
  saved.calls = callTimes;
  state = saved;
}
async function saveState() {
  if (DRY) return;
  callsInWindow(); // drop calls older than the window before writing
  await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2));
  await rename(`${STATE_FILE}.tmp`, STATE_FILE);
}

// ---------- Graph calls ----------
// Instagram returns comments newest first (documented: "reverse chronological order by default"). With `isSettled`,
// reading stops after the first page on which nothing is left to do: everything after it is older, so also done.
// That is 1-2 calls instead of one per 50 comments (10 calls for ~460) on every poll with new activity.
async function fetchComments(isSettled = null) {
  const out = [];
  let next = `${cfg.mediaId}/comments`;
  let params = { fields: 'id,text,username,timestamp,like_count', limit: 50 };
  let partial = false;
  let pages = 0;
  for (let page = 0; next && page < 40; page++) {
    const res = await graph('GET', next, params);
    const data = res.data ?? [];
    out.push(...data);
    pages++;
    next = res.paging?.next ?? null;
    params = {};
    dlog(`strona ${pages}: ${data.length} komentarzy (${data[0]?.timestamp ?? '-'} … ${data.at(-1)?.timestamp ?? '-'}), `
      + `paging.next: ${next ? 'tak' : 'NIE - to koniec listy'}`);
    if (isSettled && next && data.length > 0 && data.every(isSettled)) {
      partial = true;
      dlog(`na stronie ${pages} nic już nie czeka (wszystko załatwione albo starsze od startu): przestaję czytać`);
      break;
    }
  }
  return { all: out, partial, pages };
}

const sendDm = (c, text) => graph('POST', `${IG_ID}/messages`,
  { recipient: { comment_id: c.id }, message: { text: fill(text, c) } }, { json: true, throttled: true });
const sendReply = (c) => graph('POST', `${c.id}/replies`,
  { message: fill(cfg.replies[Math.floor(Math.random() * cfg.replies.length)], c) });
const likeComment = (c) => graph('POST', `${IG_ID}/likes`, { comment_id: c.id }, { json: true });

// ---------- per-comment logic ----------
let likesDisabled = !cfg.likeComments || IG_LOGIN;
let likeFailStreak = 0;

// Runs one action for one comment. Terminal results are stored as st[name]; a transient error leaves
// it null so the next poll retries (up to MAX_TRIES). Rate limits / bad token abort the whole cycle.
async function step(c, st, name, fn) {
  if (DRY) { log(`[dry-run] ${name} -> @${c.username}`); st[name] = 'dry'; return; }
  try {
    await fn();
    st[name] = 'ok';
    if (name === 'dm') state.sentTo[c.username] = Date.now();
    await saveState(); // right away: if the process is killed before the next step, this DM must not be forgotten
    log(`✓ ${name} -> @${c.username}  ${usageSuffix()}`);
    if (name === 'like') likeFailStreak = 0;
    if (name === 'reply' && expectedCount !== null) expectedCount += 1; // our reply is itself a new comment
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    if (e.isAuth || e.isRateLimit) throw e;
    if (name === 'like') {
      // likes are a nice-to-have: never let them block the DM
      log(`! like nie wyszedł (@${c.username}): ${e.message}`);
      st.like = `failed: ${e.message}`;
      if (e.isPermission || ++likeFailStreak >= 3) {
        likesDisabled = true;
        log('! wyłączam lajkowanie na tę sesję (sprawdź uprawnienie instagram_manage_engagement)');
      }
      return;
    }
    if (e.isPermission) {
      const hint = /disabled access to Instagram Direct Messaging/i.test(e.message)
        ? 'W Instagramie włącz: Ustawienia → Wiadomości i odpowiedzi na relacje → Kontrola wiadomości → Połączone narzędzia → „Zezwalaj na dostęp do wiadomości".'
        : 'Sprawdź uprawnienia i konfigurację aplikacji w panelu Meta (README, krok 3).';
      die(`Nie udało się wykonać "${name}": ${e.message}\n${hint}`);
    }
    st[`${name}Tries`] = (st[`${name}Tries`] ?? 0) + 1;
    log(`! ${name} -> @${c.username} błąd (${st[`${name}Tries`]}/${MAX_TRIES}): ${e.message}`);
    if (st[`${name}Tries`] >= MAX_TRIES) st[name] = `failed: ${e.message}`;
  }
}

// Visual structure of the log: a heavy header per person, a thin line between the steps (DM / reply), a footer.
const THIN = `${' '.repeat(9)}${'┈'.repeat(46)}`;
const short = (v) => (!v ? 'brak' : v === 'ok' ? 'ok' : v === 'dry' ? 'próba' : String(v).startsWith('skipped') ? 'pominięto' : 'błąd');

// returns true if it called the API (so the caller should pause before the next comment)
async function handle(c, recipe, pos = '') {
  const st = (state.comments[c.id] ??= { dm: null, reply: null, like: null });
  const before = JSON.stringify(st);
  const age = Date.now() - Date.parse(c.timestamp);
  const t0 = Date.now();
  let acted = false;
  console.log('');
  log(`══════ ${pos ? `[${pos} w tej turze] ` : ''}@${c.username} · komentarz sprzed ${Math.round(age / 60000)} min ${'═'.repeat(14)}`);
  dlog(`@${c.username} (${c.id}), wiek ${Math.round(age / 60000)} min, stan: dm=${st.dm} reply=${st.reply} like=${st.like}`);

  try {
    if (!st.dm) {
      if (age > DM_WINDOW_MS) {
        st.dm = 'skipped: starszy niż 7 dni';
        log(`- pomijam dm -> @${c.username}: komentarz starszy niż 7 dni`);
      } else if (cfg.oneDmPerUser && state.sentTo[c.username]) {
        st.dm = 'skipped: ta osoba już dostała przepis';
        log(`- pomijam dm -> @${c.username}: ta osoba już dostała przepis`);
      } else {
        await step(c, st, 'dm', () => sendDm(c, recipe));
        if (st.dm === 'ok' || st.dm === 'dry') state.sentTo[c.username] = Date.now();
      }
    }
    if (!st.reply && st.dm) {
      const sent = st.dm === 'ok' || st.dm === 'dry';
      if (!cfg.publicReply || !sent) st.reply = 'skipped';
      else { console.log(THIN); await step(c, st, 'reply', () => sendReply(c)); }
    }
    if (!st.like && st.dm) {
      if (likesDisabled) st.like = 'skipped';
      else { console.log(THIN); await step(c, st, 'like', () => likeComment(c)); }
    }
  } finally {
    // Always persist what already happened, even if a later step threw (network drop, rate limit): a DM that went
    // out must never be forgotten, or a restart would try to send it again.
    acted = JSON.stringify(st) !== before;
    if (acted) await saveState();
    log(`└─ @${c.username}: dm ${short(st.dm)} · reply ${short(st.reply)} · ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  return acted && [st.dm, st.reply, st.like].some((v) => v === 'ok' || v === 'dry');
}

// Reading the whole comment list costs one call per 50 comments (8 calls for ~380), every poll: that alone can eat
// the app's hourly budget. So each poll first asks one cheap question - "how many comments?" - and only re-reads the
// list when the number changed, something is still unfinished, or fullRefreshSeconds passed.
// Instagram counts replies in comments_count, and our own public replies are replies. So every time we post one we
// raise `expectedCount` by one; otherwise each batch would trigger a pointless full re-read just to find our own
// replies. Only a count ABOVE what we expect means someone else commented.
let expectedCount = null;
let lastFullAt = 0;
let forceFull = true;
let lastBeatAt = Date.now();

async function cycle(recipe, ownName, trigger) {
  const mustRefresh = forceFull || Date.now() - lastFullAt > cfg.fullRefreshSeconds * 1000;
  const { comments_count: count } = await graph('GET', cfg.mediaId, { fields: 'comments_count' });
  dlog(`licznik komentarzy: ${count}, oczekiwany: ${expectedCount}, wymuszony pełny odczyt: ${mustRefresh}`
    + ` (niedokończone: ${forceFull}, od ostatniego pełnego odczytu: ${Math.round((Date.now() - lastFullAt) / 1000)} s)`);
  if (!mustRefresh && typeof count === 'number' && expectedCount !== null && count <= expectedCount) { // nothing new
    dlog('licznik się nie zwiększył: nie czytam listy');
    if (Date.now() - lastBeatAt > cfg.heartbeatSeconds * 1000) {
      lastBeatAt = Date.now();
      log(`czuwam: ${count} komentarzy (oczekiwane ${expectedCount}), nic nowego  ${usageSuffix()}`);
    }
    return;
  }

  // "Start from this person": everything older than their (oldest) comment was handled by hand and is left alone.
  // Resolved once and remembered in state, so deleting that comment later cannot change where we start.
  const wanted = cfg.startFromUsername.replace(/^@/, '').trim().toLowerCase();
  let startAt = wanted && state.start?.username === wanted ? Date.parse(state.start.timestamp) : null;
  const minLikes = cfg.skipIfLikedAtLeast;

  // Nothing left to do for a comment that is ours, off-topic, older than the start point, liked by hand before the bot
  // took over, or already fully handled. Lets a routine poll stop reading the list after the first such page.
  const isSettled = (c) => c.username === ownName
    || Boolean(trigger && !trigger.test(c.text ?? ''))
    || (startAt !== null && Date.parse(c.timestamp) < startAt)
    || (minLikes > 0 && Boolean(state.baseline) && Date.parse(c.timestamp) < Date.parse(state.baseline)
        && typeof c.like_count === 'number' && c.like_count >= minLikes)
    || Boolean(state.comments[c.id]?.dm && state.comments[c.id]?.reply && state.comments[c.id]?.like);
  // A complete read is needed when something is unfinished, now and then as a safety net, and until the start point
  // is known (finding it needs the whole list).
  const partialOk = !mustRefresh && (!wanted || startAt !== null);
  dlog(`czytam listę komentarzy: ${partialOk ? 'od najnowszych, do pierwszej strony bez zadań' : 'cała lista'}`);
  const { all, partial, pages } = await fetchComments(partialOk ? isSettled : null);
  expectedCount = typeof count === 'number' ? count : null;
  if (!partial) lastFullAt = Date.now();
  forceFull = true; // stays true if this cycle is cut short by an error; the end of the cycle decides below

  if (wanted && startAt === null) {
    const theirs = all.filter((c) => (c.username ?? '').toLowerCase() === wanted)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (theirs.length === 0) die(`Nie znalazłem komentarza od @${wanted} pod tym postem (mediaId ${cfg.mediaId}). Sprawdź pisownię nazwy w "startFromUsername". Nic nie wysłano.`);
    startAt = Date.parse(theirs[0].timestamp);
    state.start = { username: wanted, timestamp: theirs[0].timestamp };
    log(`start od komentarza @${wanted} z ${new Date(startAt).toLocaleString('pl-PL')}${theirs.length > 1 ? ` (ma ich ${theirs.length}, biorę najstarszy)` : ''}`);
    await saveState(); // in-memory only on --dry-run
  }

  const why = { własne: 0, 'poza filtrem': 0, 'już obsłużone': 0 };
  let todo = all
    .filter((c) => {
      if (c.username === ownName) { why.własne++; return false; }
      if (trigger && !trigger.test(c.text ?? '')) { why['poza filtrem']++; return false; }
      const s = state.comments[c.id];
      if (s && s.dm && s.reply && s.like) { why['już obsłużone']++; return false; }
      return true;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)); // oldest first

  let beforeStart = 0;
  if (startAt !== null) {
    const n = todo.length;
    todo = todo.filter((c) => Date.parse(c.timestamp) >= startAt);
    beforeStart = n - todo.length;
  }

  // The API cannot tell *who* liked a comment, only how many likes it has. A comment with 0 likes was surely
  // not answered by hand (the owner likes what she answered), so it is the safe set to send to.
  // This only applies to comments created BEFORE the bot first ran (state.baseline): from then on nobody answers
  // by hand, so a like from a stranger must not make us skip a new comment.
  let skippedLiked = 0;
  if (minLikes > 0) {
    if (!state.baseline) { state.baseline = new Date().toISOString(); await saveState(); } // in-memory only on --dry-run
    const cutoff = Date.parse(state.baseline);
    const handledByHand = (c) => Date.parse(c.timestamp) < cutoff;
    // If Instagram stops returning like_count we cannot tell answered from unanswered: better to stop than to
    // send the recipe a second time to hundreds of people.
    if (todo.some((c) => handledByHand(c) && typeof c.like_count !== 'number')) {
      die('Włączone jest "skipIfLikedAtLeast", ale Instagram nie zwrócił liczby polubień (like_count) dla części komentarzy, więc nie wiem, które są już obsłużone. Nic nie wysłano. Ustaw "skipIfLikedAtLeast": 0 albo daj znać.');
    }
    const before = todo.length;
    todo = todo.filter((c) => !handledByHand(c) || c.like_count < minLikes);
    skippedLiked = before - todo.length;
  }
  lastBeatAt = Date.now();
  log(`komentarzy: ${all.length}${partial ? ` (przeczytane tylko najnowsze, ${pages} str.)` : ` (${pages} str.)`}, do obsłużenia: ${todo.length}`
    + (startAt !== null && !partial ? `, sprzed startu pominięte: ${beforeStart}` : '')
    + (minLikes > 0 && !partial ? `, pominięte jako polubione: ${skippedLiked}` : '')
    + `  ${usageSuffix()}`);
  dlog(`odfiltrowane: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')}`
    + `${startAt !== null ? `, sprzed startu ${beforeStart}` : ''}${minLikes > 0 ? `, polubione ${skippedLiked}` : ''}`);
  if (todo.length) dlog(`do obsłużenia (od najstarszego): ${todo.slice(0, 5).map((c) => `@${c.username}`).join(', ')}${todo.length > 5 ? ` … i ${todo.length - 5} kolejnych` : ''}`);
  for (const [i, c] of todo.entries()) {
    if (await handle(c, recipe, `${i + 1}/${todo.length}`) && !DRY && i < todo.length - 1) { // a dry run sends nothing; no pause after the last one
      const [min, max] = cfg.delaySeconds;
      const wait = min + Math.random() * (max - min);
      log(`   ⏳ przerwa ${Math.round(wait)} s przed następną osobą`);
      await sleep(wait * 1000);
    }
  }
  if (todo.length) {
    console.log('');
    log(`══════ koniec tury: przejrzano ${todo.length}. Czuwam; komentarze, które przyszły w międzyczasie, wejdą do następnej tury ══════`);
  }
  // anything still unfinished (e.g. a step that failed and will be retried) -> read the list again next time
  forceFull = todo.some((c) => { const s = state.comments[c.id]; return !s?.dm || !s?.reply || !s?.like; });
}

async function listMedia() {
  const res = await graph('GET', `${IG_ID}/media`, { fields: 'id,media_type,timestamp,comments_count,permalink,caption', limit: 10 });
  for (const m of res.data ?? []) {
    console.log(`${m.id}  ${m.timestamp?.slice(0, 10)}  ${m.media_type}  komentarzy: ${m.comments_count}\n   ${(m.caption ?? '').slice(0, 70).replace(/\n/g, ' ')}\n   ${m.permalink}`);
  }
  console.log('\nSkopiuj id posta do config.json -> "mediaId".');
}

// A real "request limit reached" error: our own call count in the last hour is the best estimate of what the app is
// allowed. Remember 85% of it (never raising a lower value), so the next run stays safely under the wall.
async function learnCap() {
  const used = callsInWindow();
  const learned = Math.max(10, Math.floor(used * 0.85));
  if (state.learnedCap && learned >= state.learnedCap) return;
  state.learnedCap = learned;
  log(`zapamiętuję: limit zapytań aplikacji to ok. ${used} na godzinę, odtąd trzymam się ${learned}`);
  await saveState();
}

// Resolves our own username (so we never answer our own comments) and, on Instagram Login, our IG id.
async function whoAmI() {
  if (IG_LOGIN) {
    const res = await graph('GET', 'me', { fields: 'user_id,username' });
    const me = res.data?.[0] ?? res; // Meta's docs show a {data:[...]} wrapper; tolerate a flat object too
    IG_ID = me.user_id ?? me.id;
    return me.username;
  }
  if (IG_ID) return (await graph('GET', IG_ID, { fields: 'username' })).username;
  // A Unified Login token belongs to a system user, so /me is not our Instagram account
  const { data = [] } = await graph('GET', 'me/assigned_instagram_accounts', { fields: 'id,username' });
  if (data.length === 0) die('Ten token nie ma dostępu do żadnego konta Instagram. Sprawdź, czy konto jest zawodowe i dodane jako Instagram Tester (README, krok 4).');
  if (data.length > 1) die(`Token obejmuje kilka kont: ${data.map((a) => `@${a.username}=${a.id}`).join(', ')}. Wpisz id wybranego jako IG_USER_ID w .env.`);
  IG_ID = data[0].id;
  return data[0].username;
}

async function main() {
  if (!TOKEN) die(`Brak tokena. Wpisz META_TOKEN${SFX} (lub IG_TOKEN${SFX}) do pliku .env (README, krok 4).`);
  let ownName;
  try { ownName = await whoAmI(); } catch (e) {
    if (e instanceof GraphError) die(`Instagram odrzucił token: ${e.message}\nWygeneruj nowy w panelu aplikacji (README, krok 4).`);
    if (e instanceof NetworkError) die(`Brak połączenia z Instagramem (${e.message}). Sprawdź internet i uruchom bota ponownie.`);
    throw e;
  }
  if (args.has('--list')) return listMedia();
  if (!cfg.mediaId) die('Ustaw "mediaId" w config.json. Listę postów pokaże: npm run media');

  const recipe = (await readFile(path.resolve(ROOT, cfg.recipeFile), 'utf8')).trim();
  if (!recipe || recipe.includes('TU WKLEJ')) die(`Wpisz treść przepisu w ${cfg.recipeFile}.`);
  const bytes = Buffer.byteLength(recipe);
  if (bytes > 1000) die(`Przepis ma ${bytes} bajtów, a Instagram pozwala na max 1000 w jednej wiadomości (polskie znaki i emoji liczą się podwójnie/poczwórnie). Skróć go albo wstaw link do pełnego przepisu.`);
  const trigger = cfg.triggerRegex ? new RegExp(cfg.triggerRegex, 'iu') : null;

  await loadState();
  log(`konto: @${ownName}, post: ${cfg.mediaId}${DRY ? '  [TRYB PRÓBNY - nic nie wysyłam]' : ''}`);
  if (IG_LOGIN && cfg.likeComments) log('uwaga: lajkowanie komentarzy wyłączone (Instagram Login tego nie obsługuje)');

  let netFails = 0;
  for (;;) {
    try {
      await cycle(recipe, ownName, trigger);
      if (netFails) { log('połączenie wróciło'); netFails = 0; }
    } catch (e) {
      if (e instanceof NetworkError) {
        if (ONCE) die(`Brak połączenia z Instagramem (${e.message}).`);
        netFails++;
        // 15 s, 30 s, 60 s, 2 min, 4 min, then every 5 min until the connection is back
        const wait = Math.min(cfg.networkRetrySeconds * 2 ** (netFails - 1), Math.max(300, cfg.networkRetrySeconds));
        log(`! brak połączenia z Instagramem (${e.message}), próba ${netFails}. Postęp jest zapisany, ponawiam za ${wait} s`);
        await sleep(wait * 1000);
        continue;
      }
      if (!(e instanceof GraphError)) throw e;
      if (e.isAuth) die(`Token wygasł lub jest nieprawidłowy: ${e.message}`);
      if ([4, 17].includes(e.code)) await learnCap(); // app-level request limit: remember roughly where it is
      if (!e.isRateLimit) log(`! błąd API: ${e.message}`);
      else if (ONCE) die(`Limit Instagrama: ${e.message}`);
      else { log(`! limit Instagrama (${e.message}) - przerwa 30 min`); await sleep(RATE_LIMIT_PAUSE_MS); continue; }
    }
    if (ONCE) break;
    await sleep(cfg.pollSeconds * (usagePct >= 60 ? 3 : 1) * 1000); // poll less often when the budget is getting tight
  }
}

main().catch((e) => {
  if (e instanceof NetworkError) die(`Brak połączenia z Instagramem (${e.message}).`);
  console.error(e);
  process.exit(1);
});

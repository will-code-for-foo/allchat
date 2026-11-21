// HTTP transport for modern Node (20.12+): the built-in fetch behind the same small interface as lib/transport.js.
//
//   request({ method, url (URL object), headers, body (string|null), timeoutMs }) -> Promise<{ status, ok, headers, text }>
//
// Rejects only when no proper answer came (the error carries fetch's usual cause chain: err.cause.code = ECONNREFUSED ...).
// A body that gets cut after the status line arrived is not an error: the status decides (see lib/transport.js for why).
export async function fetchRequest({ method = 'GET', url, headers = {}, body = null, timeoutMs = 30000 }) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  let text = '';
  try { text = await res.text(); } catch { /* answered with a status, body lost: the status counts */ }
  return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), text };
}

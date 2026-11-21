'use strict';
const { dflt, coalesce } = require('./util');

class GraphError extends Error {
  constructor(err, status) {
    super(dflt(err.message, `HTTP ${status}`));
    this.code = err.code;
    this.status = status;
  }
  get isAuth() { return this.code === 190; }
  get isRateLimit() { return this.status === 429 || [4, 17, 32, 368, 613, 80002, 80006].includes(this.code); }
  get isPermission() { return this.code === 3 || this.code === 10 || (this.code >= 200 && this.code < 300); }
}

// The request never got a proper answer: no internet, DNS failure, connection reset, timeout. Not Instagram's
// fault and usually temporary (Wi-Fi blip, laptop woke from sleep), so the main loop waits and retries.
// Works with the error shapes of both transports: fetch (cause.cause.code, e.g. ECONNREFUSED) and https.request (code).
class NetworkError extends Error {
  constructor(cause) {
    const c = cause || {};
    const code = coalesce(c.cause && c.cause.code, c.code, c.cause && c.cause.message, c.name, 'błąd sieci');
    super(String(code));
    this.code = code;
  }
  // A certificate error is the one network failure that waiting will not fix (old Node 10 trusts only the CA list
  // built into it, from 2019, not the system's), so say what to do about it.
  get hint() {
    return /CERT|ISSUER|SELF_SIGNED|SSL/i.test(String(this.code))
      ? ' Node nie ufa certyfikatowi serwera (np. stara lista CA). Spróbuj ustawić NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt przed poleceniem uruchamiającym bota.'
      : '';
  }
}

module.exports = { GraphError, NetworkError };

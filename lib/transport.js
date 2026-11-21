'use strict';
// HTTP transport for Node 10 (no fetch there): https.request / http.request behind the same small interface that
// lib/fetch-transport.mjs offers modern Node:
//
//   request({ method, url (URL object), headers, body (string|null), timeoutMs }) -> Promise<{ status, ok, headers, text }>
//
// `headers` come back with lower-case names. The promise rejects only when NO proper answer came (DNS, refused, reset
// before the status line, TLS problem, timeout): the error then has a `code` (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, ...).
// Once the status line is in, the answer counts, even if the body is cut or the timeout hits while reading it: the
// body is then whatever arrived (usually unparseable -> treated as {}), and the status decides. That matters: a DM that
// Instagram accepted (200) must never turn into a "network error" that makes the bot send it again.
const http = require('http');
const https = require('https');

function httpRequest({ method = 'GET', url, headers = {}, body = null, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let req = null;
    let answer = null; // set when the status line + headers arrived: { status, headers, chunks }
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const resolveWithWhatArrived = () => finish(resolve, {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: answer.headers,
      text: Buffer.concat(answer.chunks).toString('utf8'),
    });
    const fail = (code, message) => {
      if (answer) { resolveWithWhatArrived(); if (req) req.abort(); return; } // answered already: the status counts
      const err = new Error(message);
      err.code = code;
      finish(reject, err);
      if (req) req.abort();
    };
    const lib = url.protocol === 'http:' ? http : https;
    const hdrs = Object.assign({}, headers);
    if (body != null) hdrs['Content-Length'] = Buffer.byteLength(body);
    req = lib.request(url, { method, headers: hdrs }, (res) => {
      answer = { status: res.statusCode, headers: res.headers, chunks: [] };
      res.on('data', (c) => answer.chunks.push(c));
      res.on('end', resolveWithWhatArrived);
      res.on('aborted', resolveWithWhatArrived);
      res.on('error', resolveWithWhatArrived);
    });
    req.on('error', (e) => (answer ? resolveWithWhatArrived() : finish(reject, e)));
    timer = setTimeout(() => fail('ETIMEDOUT', 'timeout'), timeoutMs);
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { httpRequest };

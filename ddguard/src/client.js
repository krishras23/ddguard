const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_BODY = 32 * 1024 * 1024;

function get(base, path, params, headers) {
  const url = new URL(path, base.endsWith('/') ? base : base + '/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const agent = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = agent.get(url, { headers, timeout: 15000 }, (res) => {
      let body = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        size += Buffer.byteLength(c);
        if (size > MAX_BODY) {
          reject(new Error(`${url.pathname} returned more than ${MAX_BODY} bytes`));
          return res.destroy();
        }
        body += c;
      });
      res.on('aborted', () => reject(new Error(`${url.host}: connection reset mid-response`)));
      res.on('error', (err) => reject(new Error(`${url.host}: ${err.code || err.message}`)));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} ${url.pathname}`));
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`non-JSON response from ${url.pathname}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => {
      const cause = err.code || err.message || (err.errors || []).map((e) => e.code).join(', ');
      reject(new Error(`${url.host}: ${cause}`));
    });
  });
}

function once(fn) {
  let pending;
  return () => (pending = pending || fn());
}

function createClient({ apiUrl, apiKey, appKey, slackAccount }) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['DD-API-KEY'] = apiKey;
  if (appKey) headers['DD-APPLICATION-KEY'] = appKey;
  const call = (path, params) => get(apiUrl, path, params || {}, headers);

  // Datadog's v1 spec exposes channels only under an explicit account name; there is
  // no documented endpoint that lists accounts, so we require one rather than guess.
  const slackChannels = once(async () => {
    if (!slackAccount) throw new Error('DD_SLACK_ACCOUNT not set');
    const path = `api/v1/integration/slack/configuration/accounts/${encodeURIComponent(slackAccount)}/channels`;
    return call(path);
  });

  const pagerdutyServices = once(() =>
    call('api/v1/integration/pagerduty').then((r) => r.services || (Array.isArray(r) ? r : [])));

  return {
    apiUrl,
    query: (dataQuery, fromSec, toSec) =>
      call('api/v1/query', { from: Math.floor(fromSec), to: Math.floor(toSec), query: dataQuery }),
    searchMetrics: (q) => call('api/v1/search', { q: `metrics:${q}` }),
    slackChannels,
    pagerdutyServices,
  };
}

module.exports = { createClient };

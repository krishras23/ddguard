const http = require('http');
const https = require('https');
const { URL } = require('url');

function get(base, path, params, headers) {
  const url = new URL(path, base.endsWith('/') ? base : base + '/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const agent = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = agent.get(url, { headers, timeout: 15000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
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

function createClient({ apiUrl, apiKey, appKey }) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['DD-API-KEY'] = apiKey;
  if (appKey) headers['DD-APPLICATION-KEY'] = appKey;
  const call = (path, params) => get(apiUrl, path, params || {}, headers);

  return {
    apiUrl,
    query: (dataQuery, fromSec, toSec) =>
      call('api/v1/query', { from: Math.floor(fromSec), to: Math.floor(toSec), query: dataQuery }),
    searchMetrics: (q) => call('api/v1/search', { q: `metrics:${q}` }),
    slackChannels: () =>
      call('api/v1/integration/slack/channels').then((r) => r.channels || (Array.isArray(r) ? r : [])),
    pagerdutyServices: () =>
      call('api/v1/integration/pagerduty').then((r) => r.services || (Array.isArray(r) ? r : [])),
  };
}

module.exports = { createClient };

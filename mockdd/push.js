#!/usr/bin/env node
// Push the tail of the fixture series into a real Datadog account, so the fixture plan
// can be run against the real API. Datadog's intake only accepts points up to ~1h old,
// so this re-anchors the last MINUTES of each series to end at "now".
//
//   DD_API_KEY=... node mockdd/push.js [--minutes=55] [--site=datadoghq.com]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const MINUTES = Number(args.minutes || 55);
const SITE = args.site || process.env.DD_SITE || 'datadoghq.com';
const KEY = process.env.DD_API_KEY;
if (!KEY) {
  console.error('DD_API_KEY is required');
  process.exit(2);
}

const FILE = path.join(__dirname, '..', 'data', 'fixture', 'metrics.json.gz');
const { interval, count, series } = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)));

// counts (.as_count() in the fixture queries) vs gauges
const COUNT = new Set(['scheduler.runs.queued', 'worker.runs.processed', 'nginx.requests']);
const TYPE = { count: 1, gauge: 3 };

const now = Math.floor(Date.now() / 1000);
const n = Math.min(count, Math.floor((MINUTES * 60) / interval));
const first = count - n;

const payload = series.map((s) => ({
  metric: s.metric,
  type: COUNT.has(s.metric) ? TYPE.count : TYPE.gauge,
  interval: COUNT.has(s.metric) ? interval : undefined,
  tags: Object.entries(s.tags).map(([k, v]) => `${k}:${v}`),
  points: s.values.slice(first).map((v, i) => ({ timestamp: now - (n - i) * interval, value: v })),
}));

const body = JSON.stringify({ series: payload });
const req = https.request({
  hostname: `api.${SITE}`,
  path: '/api/v2/series',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'DD-API-KEY': KEY, 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  let out = '';
  res.on('data', (c) => (out += c));
  res.on('end', () => {
    console.log(`${res.statusCode} ${out.trim()}`);
    console.log(`pushed ${payload.length} series x ${n} points (last ${MINUTES}m @ ${interval}s) to ${SITE}`);
    process.exit(res.statusCode >= 300 ? 1 : 0);
  });
});
req.on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});
req.end(body);

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || process.env.MOCKDD_PORT) || 8126;
const FIXTURE = path.join(__dirname, '..', 'data', 'fixture', 'metrics.json.gz');

if (!fs.existsSync(FIXTURE)) {
  console.error(`no fixture at ${FIXTURE} — run: node mockdd/seed.js`);
  process.exit(1);
}

const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)));
const { interval, count, series } = fixture;
const start = Math.floor(Date.now() / 1000) - (count - 1) * interval;

const PAGERDUTY_SERVICES = [
  { service_name: 'worker-oncall' },
  { service_name: 'nginx-oncall' },
  { service_name: 'scheduler-oncall' }
];

const QUERY = /^(sum|avg|min|max):([a-zA-Z0-9._]+)\{([^}]*)\}(?:\s*by\s*\{([^}]*)\})?((?:\.[a-z_]+\([^)]*\))*)$/;

function parseQuery(q) {
  const m = QUERY.exec(q.trim());
  if (!m) return null;
  const scope = {};
  for (const term of m[3].split(',').map((s) => s.trim()).filter(Boolean)) {
    if (term === '*') continue;
    const i = term.indexOf(':');
    if (i < 1) return null;
    scope[term.slice(0, i)] = term.slice(i + 1);
  }
  return {
    spaceAggregator: m[1],
    metric: m[2],
    scope,
    groupBy: m[4] ? m[4].split(',').map((s) => s.trim()).filter(Boolean) : []
  };
}

const REDUCE = {
  sum: (vs) => vs.reduce((a, b) => a + b, 0),
  avg: (vs) => vs.reduce((a, b) => a + b, 0) / vs.length,
  min: (vs) => Math.min(...vs),
  max: (vs) => Math.max(...vs)
};

function evaluate(rawQuery, from, to) {
  const q = parseQuery(rawQuery);
  if (!q) return [];

  const matched = series.filter(
    (s) =>
      s.metric === q.metric &&
      Object.entries(q.scope).every(([k, v]) => s.tags[k] === v) &&
      q.groupBy.every((t) => s.tags[t] !== undefined)
  );
  if (!matched.length) return [];

  const scopeString = Object.entries(q.scope).map(([k, v]) => `${k}:${v}`).join(',') || '*';
  const groups = new Map();
  for (const s of matched) {
    const key = q.groupBy.length ? q.groupBy.map((t) => `${t}:${s.tags[t]}`).join(',') : scopeString;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const first = Math.max(0, Math.ceil((from - start) / interval));
  const last = Math.min(count - 1, Math.floor((to - start) / interval));
  if (last < first) return [];

  const reduce = REDUCE[q.spaceAggregator];
  return [...groups].map(([scope, members]) => {
    const pointlist = [];
    for (let i = first; i <= last; i++) {
      pointlist.push([(start + i * interval) * 1000, reduce(members.map((s) => s.values[i]))]);
    }
    return { metric: q.metric, scope, pointlist };
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/v1/query') {
    const query = url.searchParams.get('query');
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    if (!query || !Number.isFinite(from) || !Number.isFinite(to)) {
      return send(res, 400, { status: 'error', errors: ['query, from and to are required'] });
    }
    return send(res, 200, { status: 'ok', query, from_date: from * 1000, to_date: to * 1000, series: evaluate(query, from, to) });
  }

  if (p === '/api/v1/search') {
    const q = url.searchParams.get('q') || '';
    const term = q.startsWith('metrics:') ? q.slice(8) : q;
    const names = [...new Set(series.map((s) => s.metric))].filter((n) => n.includes(term)).sort();
    return send(res, 200, { results: { metrics: term ? names : [] } });
  }

  if (p === '/api/v1/integration/pagerduty') return send(res, 200, { services: PAGERDUTY_SERVICES });
  if (p === '/health') return send(res, 200, { status: 'ok' });

  send(res, 404, { errors: [`404 Not Found: ${p}`] });
});

server.listen(PORT, () => {
  console.log(`mockdd listening on http://localhost:${PORT} — ${series.length} series, ${count} points @ ${interval}s`);
  console.log('time-shifted fixture data; newest point = now');
});

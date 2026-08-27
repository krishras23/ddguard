const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const INTERVAL = 30;
const DAYS = 30;
const POINTS = (DAYS * 86400) / INTERVAL;
const START = Date.UTC(2025, 0, 1) / 1000;
const OUT = path.join(__dirname, '..', 'data', 'fixture', 'metrics.json.gz');

let state = 0x9e3779b9;
function rand() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function gauss() {
  const u = 1 - rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + gauss() * Math.sqrt(lambda)));
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l);
  return k - 1;
}

// 1x overnight floor, 3x at midday
function season(hour) {
  return 1 + 2 * Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI));
}

const deadLetterPulses = [[5, 14.0, 14.4], [5, 15.3, 15.6], [5, 16.6, 17.4]];
function deadLetterRate(day, hour) {
  for (const [d, a, b] of deadLetterPulses) {
    if (day === d && hour >= a && hour < b) return 4;
  }
  return 0;
}

// deploy at day 12, 02:00 UTC — median 30ms -> 55ms, never recovers
function latencyMedian(day, hour) {
  const t = day + hour / 24;
  const ramp = Math.min(1, Math.max(0, (t - 12.0833) * 144));
  return 30 + 25 * ramp;
}
const LAT_SIGMA = 1.4;

const series = [];
function track(metric, tags) {
  const s = { metric, tags: Object.assign({ env: 'demo' }, tags), values: new Array(POINTS) };
  series.push(s);
  return s.values;
}

const queuedInterval = track('scheduler.runs.queued', { service: 'scheduler', trigger: 'interval', job: 'write-heartbeat' });
const queuedManual = track('scheduler.runs.queued', { service: 'scheduler', trigger: 'manual', job: 'write-heartbeat' });
const queuedStartup = track('scheduler.runs.queued', { service: 'scheduler', trigger: 'startup', job: 'write-heartbeat' });
const success = track('worker.runs.processed', { service: 'worker', status: 'success', job: 'write-heartbeat' });
const retried = track('worker.runs.processed', { service: 'worker', status: 'retry-queued', job: 'write-heartbeat' });
const dead = track('worker.runs.processed', { service: 'worker', status: 'dead-lettered', job: 'write-heartbeat' });
const latency = track('worker.queue.latency', { service: 'worker' });
const depth = track('worker.queue.depth', { service: 'worker' });

const nginx = {};
for (const target of ['web_primary', 'web_canary']) {
  nginx[target] = {};
  for (const cls of ['2xx', '4xx', '5xx']) {
    nginx[target][cls] = track('nginx.requests', { service: 'nginx', status_class: cls, target });
  }
}

const mix = {
  web_primary: { share: 0.9, '4xx': 0.021, '5xx': 0.004 },
  web_canary: { share: 0.1, '4xx': 0.026, '5xx': 0.055 }
};

let backlog = 0;
for (let i = 0; i < POINTS; i++) {
  const secOfDay = (i * INTERVAL) % 86400;
  const day = Math.floor((i * INTERVAL) / 86400);
  const hour = secOfDay / 3600;
  const s = season(hour);

  const qi = poisson(26 * s);
  const qm = poisson(1.2 * s);
  const qs = secOfDay < 60 && rand() < 0.15 ? 1 : 0;
  queuedInterval[i] = qi;
  queuedManual[i] = qm;
  queuedStartup[i] = qs;

  backlog += qi + qm + qs;
  const drained = Math.min(backlog, poisson(27 * s + 4));
  backlog -= drained;
  const d = Math.min(drained, poisson(deadLetterRate(day, hour)));
  const r = Math.min(drained - d, poisson(0.03 * drained));
  success[i] = drained - d - r;
  retried[i] = r;
  dead[i] = d;
  depth[i] = backlog;

  latency[i] = Math.round(latencyMedian(day, hour) * Math.exp(LAT_SIGMA * gauss()) * 10) / 10;

  const total = poisson(70 * s);
  for (const target of ['web_primary', 'web_canary']) {
    const m = mix[target];
    const hits = poisson(total * m.share);
    const e5 = poisson(hits * m['5xx']);
    const e4 = poisson(hits * m['4xx']);
    nginx[target]['5xx'][i] = e5;
    nginx[target]['4xx'][i] = e4;
    nginx[target]['2xx'][i] = Math.max(0, hits - e5 - e4);
  }
}

const payload = { start: START, interval: INTERVAL, count: POINTS, series };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));

const bytes = fs.statSync(OUT).size;
console.log(`wrote ${series.length} series x ${POINTS} points (${DAYS}d @ ${INTERVAL}s) -> ${OUT} (${(bytes / 1024).toFixed(0)} KB)`);

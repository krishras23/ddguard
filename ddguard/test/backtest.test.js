const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { URL } = require('node:url');
const backtest = require('../src/checks/backtest');
const { createClient } = require('../src/client');
const { parse } = require('../src/query');

const WINDOW = 300;
const START = 1_700_000_000_000;

const monitor = (thresholds, over = {}) => ({
  address: 'datadog_monitor.synthetic',
  name: 'synthetic',
  thresholds: { critical: null, critical_recovery: null, warning: null, warning_recovery: null, ...thresholds },
  ...over,
});

function clientFor(...seriesValues) {
  return {
    query: async () => ({
      status: 'ok',
      series: seriesValues.map((values, i) => ({
        metric: 'synthetic.metric',
        scope: `group:g${i}`,
        pointlist: values.map((v, j) => [START + j * WINDOW * 1000, v]),
      })),
    }),
  };
}

// Datadog rolls a range up to ~300 points per response and never returns finer than the
// metric's raw interval. This is the behaviour mockdd does not have.
function rollupServer({ rawInterval, valueAt }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    requests.push(to - from);
    const step = Math.max(rawInterval, Math.ceil((to - from) / 300 / rawInterval) * rawInterval);
    const pointlist = [];
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) pointlist.push([t * 1000, valueAt(t)]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', series: [{ metric: 'm', scope: 'env:test', pointlist }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const client = createClient({ apiUrl: `http://127.0.0.1:${server.address().port}` });
      resolve({ client, requests, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

function aligned(pointlist, windowSeconds, reduce) {
  const buckets = new Map();
  for (const [ms, v] of pointlist) {
    const key = Math.floor(ms / 1000 / windowSeconds);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, vs]) => reduce(vs));
}

test('resolution is the median gap, nulls included', () => {
  const points = [[0, 1], [30_000, null], [60_000, 3], [90_000, 4]];
  assert.strictEqual(backtest.resolutionOf(points), 30);
  assert.strictEqual(backtest.resolutionOf([[0, 1]]), null);
});

test('roll aggregates the trailing window at the evaluation cadence', () => {
  const points = [[0, 1], [60_000, 2], [120_000, 3], [180_000, 4]];
  assert.deepStrictEqual(backtest.roll(points, 300, 60, 'sum'), [1, 3, 6, 10]);
  assert.deepStrictEqual(backtest.roll(points, 120, 60, 'max'), [1, 2, 3, 4]);
  assert.deepStrictEqual(backtest.roll(points, 180, 60, 'count'), [1, 2, 3, 3]);
});

test('roll skips null points', () => {
  assert.deepStrictEqual(backtest.roll([[0, null], [60_000, 4]], 60, 60, 'avg'), [4]);
});

test('a spike stays alerting for the length of the window, not one bucket', () => {
  // one 60s spike, 5m window: Datadog holds the alert for five evaluations and then resolves
  const points = Array.from({ length: 12 }, (_, i) => [i * 60_000, i === 0 ? 9 : 1]);
  const rolled = backtest.roll(points, 300, 60, 'max');
  assert.deepStrictEqual(backtest.replay([rolled], '>', 5, 5), { transitions: 1, flaps: 0 });

  const max = (vs) => Math.max(...vs);
  assert.deepStrictEqual(
    backtest.replay([aligned(points, 300, max)], '>', 5, 5),
    { transitions: 1, flaps: 1 },
    'aligned bucketing calls a five-minute alert a single-bucket flap'
  );
});

test('two excursions inside one aligned bucket pair are two rolling transitions', () => {
  // spikes 6m apart: aligned bucketing lands them in adjacent buckets and merges them
  const points = Array.from({ length: 14 }, (_, i) => [i * 60_000, i === 0 || i === 6 ? 9 : 1]);
  const max = (vs) => Math.max(...vs);
  assert.strictEqual(backtest.replay([aligned(points, 300, max)], '>', 5, 5).transitions, 1);
  assert.strictEqual(backtest.replay([backtest.roll(points, 300, 60, 'max')], '>', 5, 5).transitions, 2);
});

test('sustained excursion is one transition, no flap', () => {
  const values = [1, 1, 9, 9, 9, 1, 1];
  assert.deepStrictEqual(backtest.replay([values], '>', 5, 5), { transitions: 1, flaps: 0 });
});

test('alternating values are all single-evaluation flaps', () => {
  const values = Array.from({ length: 20 }, (_, i) => (i % 2 ? 9 : 1));
  assert.deepStrictEqual(backtest.replay([values], '>', 5, 5), { transitions: 10, flaps: 10 });
});

test('hysteresis collapses flaps into one transition', () => {
  const values = [1, 9, 6, 9, 6, 9, 1];
  assert.deepStrictEqual(backtest.replay([values], '>', 8, 8), { transitions: 3, flaps: 3 });
  assert.deepStrictEqual(backtest.replay([values], '>', 8, 5), { transitions: 1, flaps: 0 });
});

test('transitions sum across groups', () => {
  const a = [1, 9, 1];
  const b = [9, 1, 9];
  assert.deepStrictEqual(backtest.replay([a, b], '>', 5, 5), { transitions: 3, flaps: 3 });
});

test('an alert still open at the end of the window counts once', () => {
  assert.deepStrictEqual(backtest.replay([[1, 9]], '>', 5, 5), { transitions: 1, flaps: 1 });
  assert.deepStrictEqual(backtest.replay([[1, 9, 9]], '>', 5, 5), { transitions: 1, flaps: 0 });
});

test('less-than operators replay', () => {
  assert.deepStrictEqual(backtest.replay([[9, 1, 1, 9]], '<', 5, 5), { transitions: 1, flaps: 0 });
});

test('never fires', async () => {
  const parsed = parse('max(last_5m):max:worker.queue.depth{env:demo} > 999999');
  const values = Array.from({ length: 200 }, (_, i) => 10 + (i % 7));
  const [f] = await backtest.run(monitor({ critical: 999999 }), parsed, clientFor(values), { days: 30 });
  assert.strictEqual(f.code, 'BACKTEST_NEVER_FIRES');
  assert.strictEqual(f.level, 'warn');
  assert.match(f.detail, /observed range 10\.\.16/);
  assert.match(f.detail, /reconstructed from 300s points/);
});

test('quiet monitor passes', async () => {
  const parsed = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 500');
  const values = Array.from({ length: 300 }, (_, i) => (i % 100 === 0 ? 900 : 40));
  const [f] = await backtest.run(monitor({ critical: 500 }), parsed, clientFor(values), { days: 30 });
  assert.strictEqual(f.level, 'pass');
  assert.strictEqual(f.detail, '3 transitions in 30d');
});

test('noisy monitor warns and searches for a threshold that lands in the quiet band', async () => {
  const parsed = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 50');
  // baseline straddles 50 on every evaluation; five genuine spikes sit far above it
  const values = Array.from({ length: 300 }, (_, i) => (i % 60 === 0 ? 1000 : i % 2 ? 55 : 45));
  const [f] = await backtest.run(monitor({ critical: 50 }), parsed, clientFor(values), { days: 30 });
  assert.strictEqual(f.code, 'BACKTEST_TOO_NOISY');
  assert.match(f.message, /30-day backtest: \d+ transitions \(\d+ single-evaluation flaps\) ≈ \d+ pages\/week/);
  assert.match(f.suggestion, /at critical=\d+(\.\d+)? \(p\d+(\.\d+)?\) this would have fired 5 times instead of \d+/);
});

test('no threshold suggestion when none lands in the quiet band', async () => {
  const parsed = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 5');
  const values = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? 1200 : i % 2 ? 40 : 2));
  const [f] = await backtest.run(monitor({ critical: 5 }), parsed, clientFor(values), { days: 30 });
  assert.strictEqual(f.code, 'BACKTEST_TOO_NOISY');
  assert.doesNotMatch(f.suggestion || '', /at critical=/);
});

test('a set critical_recovery suppresses the hysteresis suggestion', async () => {
  const parsed = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 5');
  const values = Array.from({ length: 300 }, (_, i) => (i % 2 ? 40 : 2));
  const [f] = await backtest.run(monitor({ critical: 5, critical_recovery: 1 }), parsed, clientFor(values), { days: 30 });
  assert.doesNotMatch(f.suggestion || '', /critical_recovery/);
});

test('network failure is a warn, not a throw', async () => {
  const parsed = parse('avg(last_5m):avg:a.b{*} > 1');
  const client = { query: async () => { throw new Error('ECONNREFUSED 127.0.0.1:8126'); } };
  const [f] = await backtest.run(monitor({ critical: 1 }), parsed, client, { days: 30 });
  assert.strictEqual(f.level, 'warn');
  assert.strictEqual(f.code, 'CHECK_UNAVAILABLE');
  assert.match(f.detail, /ECONNREFUSED/);
});

test('a threshold that lives only in the query is still backtested', async () => {
  const parsed = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 999999');
  const values = Array.from({ length: 200 }, () => 10);
  const [f] = await backtest.run(monitor({}), parsed, clientFor(values), { days: 30 });
  assert.strictEqual(f.code, 'BACKTEST_NEVER_FIRES');
  assert.match(f.detail, /critical > 999999/);
});

test('a threshold that disagrees with the query is a warn of its own', async () => {
  const parsed = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 80');
  const values = Array.from({ length: 200 }, () => 10);
  const [f] = await backtest.run(monitor({ critical: 100 }), parsed, clientFor(values), { days: 30 });
  assert.strictEqual(f.code, 'THRESHOLD_MISMATCH');
  assert.strictEqual(f.level, 'warn');
  assert.match(f.message, /monitor_thresholds\.critical is 100 but the query compares against 80/);
});

test('no parsed query is a no-op', async () => {
  assert.deepStrictEqual(await backtest.run(monitor({ critical: 1 }), null, clientFor([1]), {}), []);
});

test('resolution coarser than the window is unavailable, not a verdict', async () => {
  const dd = await rollupServer({ rawInterval: 600, valueAt: (t) => (t % 86400 < 600 ? 900 : 10) });
  try {
    const parsed = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 100');
    const [f] = await backtest.run(monitor({ critical: 100 }), parsed, dd.client, { days: 30 });
    assert.strictEqual(f.level, 'warn');
    assert.strictEqual(f.code, 'CHECK_UNAVAILABLE');
    assert.match(f.message, /returned 600s resolution for a 300s evaluation window/);
    assert.match(f.message, /cannot be reconstructed at this window/);
  } finally {
    await dd.close();
  }
});

test('chunked requests keep the resolution inside the window that one request would not', async () => {
  const dd = await rollupServer({ rawInterval: 60, valueAt: (t) => (t % 86400 < 1800 ? 900 : 10) });
  try {
    const to = Math.floor(Date.now() / 1000);
    const oneShot = await dd.client.query('avg:m{*}', to - 30 * 86400, to);
    assert.strictEqual(backtest.resolutionOf(oneShot.series[0].pointlist), 8640);

    dd.requests.length = 0;
    const parsed = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 100');
    const [f] = await backtest.run(monitor({ critical: 100, critical_recovery: 50 }), parsed, dd.client, { days: 30 });
    assert.ok(dd.requests.length > 1, 'range was sliced');
    assert.ok(Math.max(...dd.requests) <= 300 * 300, 'each slice stays inside the rollup budget');
    assert.notStrictEqual(f.code, 'CHECK_UNAVAILABLE');
    assert.match(f.message, /^30-day backtest: 30 transitions/);
    assert.match(f.detail, /reconstructed from 300s points, not Datadog's own evaluation history/);
  } finally {
    await dd.close();
  }
});

test('a capped request budget reports the window it actually used', async () => {
  const dd = await rollupServer({ rawInterval: 30, valueAt: () => 10 });
  try {
    const parsed = parse('avg(last_30s):avg:worker.queue.latency{env:demo} > 100');
    const [f] = await backtest.run(monitor({ critical: 100 }), parsed, dd.client, { days: 30 });
    assert.strictEqual(dd.requests.length, 32);
    assert.match(f.message, /^3\.3-day backtest/);
    assert.match(f.detail, /asked for 30d, used 3\.3d/);
  } finally {
    await dd.close();
  }
});

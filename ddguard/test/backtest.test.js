const test = require('node:test');
const assert = require('node:assert');
const backtest = require('../src/checks/backtest');
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

test('bucket reduces multiple points per window with the time aggregator', () => {
  const points = [[0, 1], [60_000, 2], [120_000, 3], [300_000, 10], [360_000, 20]];
  assert.deepStrictEqual(backtest.bucket(points, WINDOW, 'sum'), [6, 30]);
  assert.deepStrictEqual(backtest.bucket(points, WINDOW, 'avg'), [2, 15]);
  assert.deepStrictEqual(backtest.bucket(points, WINDOW, 'max'), [3, 20]);
  assert.deepStrictEqual(backtest.bucket(points, WINDOW, 'count'), [3, 2]);
});

test('bucket skips null points', () => {
  assert.deepStrictEqual(backtest.bucket([[0, null], [60_000, 4]], WINDOW, 'avg'), [4]);
});

test('sustained excursion is one transition, no flap', () => {
  const values = [1, 1, 9, 9, 9, 1, 1];
  assert.deepStrictEqual(backtest.replay([values], '>', 5, 5), { transitions: 1, flaps: 0 });
});

test('alternating values are all single-bucket flaps', () => {
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
  // baseline straddles 50 on every bucket; five genuine spikes sit far above it
  const values = Array.from({ length: 300 }, (_, i) => (i % 60 === 0 ? 1000 : i % 2 ? 55 : 45));
  const [f] = await backtest.run(monitor({ critical: 50 }), parsed, clientFor(values), { days: 30 });
  assert.strictEqual(f.code, 'BACKTEST_TOO_NOISY');
  assert.match(f.message, /30-day backtest: \d+ transitions \(\d+ single-bucket flaps\) ≈ \d+ pages\/week/);
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

test('no parsed query and no threshold are both no-ops', async () => {
  assert.deepStrictEqual(await backtest.run(monitor({ critical: 1 }), null, clientFor([1]), {}), []);
  const parsed = parse('avg(last_5m):avg:a.b{*} > 1');
  assert.deepStrictEqual(await backtest.run(monitor({}), parsed, clientFor([1]), {}), []);
});

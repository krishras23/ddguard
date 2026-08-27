const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../src/query');

const FIXTURES = [
  'sum(last_10m):sum:worker.runs.processed{env:demo,status:dead-lettered} by {job}.as_count() >= 1',
  'sum(last_15m):sum:worker.runs.procesed{env:demo}.as_count() < 10',
  'avg(last_5m):sum:scheduler.runs.queued{env:prod}.as_rate() < 0.1',
  'avg(last_5m):sum:nginx.requests{env:demo,status_class:5xx}.as_rate() / sum:nginx.requests{env:demo}.as_rate() * 100 > 5',
  'avg(last_5m):avg:worker.queue.latency{env:demo} > 5',
  'sum(last_10m):sum:nginx.requests{env:demo,target:web_canary,status_class:5xx}.as_count() > 20',
  'max(last_30m):max:worker.queue.depth{env:demo} > 999999',
  'sum(last_30m):sum:scheduler.runs.queued{env:demo} by {trigger}.as_count() < 1',
];

test('every fixture query shape parses', () => {
  for (const raw of FIXTURES) {
    const p = parse(raw);
    assert.ok(p, raw);
    assert.ok(p.windowSeconds > 0);
    assert.ok(p.metric.includes('.'));
    assert.ok(!p.dataQuery.includes(p.operator + ' '), 'threshold not stripped');
    assert.ok(!/^\w+\(last_/.test(p.dataQuery), 'time aggregator not stripped');
  }
});

test('grouped query with modifiers', () => {
  assert.deepStrictEqual(parse(FIXTURES[0]), {
    raw: FIXTURES[0],
    timeAggregator: 'sum',
    windowSeconds: 600,
    spaceAggregator: 'sum',
    metric: 'worker.runs.processed',
    scope: { env: 'demo', status: 'dead-lettered' },
    groupBy: ['job'],
    modifiers: ['as_count'],
    operator: '>=',
    threshold: 1,
    dataQuery: 'sum:worker.runs.processed{env:demo,status:dead-lettered} by {job}.as_count()',
  });
});

test('ratio query keeps whole expression as dataQuery', () => {
  const p = parse(FIXTURES[3]);
  assert.strictEqual(p.metric, 'nginx.requests');
  assert.strictEqual(p.threshold, 5);
  assert.deepStrictEqual(p.modifiers, ['as_rate']);
  assert.strictEqual(p.dataQuery, FIXTURES[3].replace(/^avg\(last_5m\):/, '').replace(/ > 5$/, ''));
});

test('window units', () => {
  assert.strictEqual(parse('avg(last_30s):avg:a.b{*} > 1').windowSeconds, 30);
  assert.strictEqual(parse('avg(last_4h):avg:a.b{*} > 1').windowSeconds, 14400);
  assert.strictEqual(parse('avg(last_1d):avg:a.b{*} > 1').windowSeconds, 86400);
  assert.strictEqual(parse('avg(last_1w):avg:a.b{*} > 1').windowSeconds, 604800);
});

test('wildcard scope is empty', () => {
  assert.deepStrictEqual(parse('avg(last_5m):avg:a.b{*} > 1').scope, {});
});

test('unparseable input returns null instead of throwing', () => {
  for (const bad of ['', 'not a query', 'avg(last_5m):nonsense > 1', 'events("x").rollup(count) > 1', null]) {
    assert.strictEqual(parse(bad), null, String(bad));
  }
});

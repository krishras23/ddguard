const test = require('node:test');
const assert = require('node:assert');
const liveness = require('../src/checks/liveness');
const { parse } = require('../src/query');

const MONITOR = { address: 'datadog_monitor.queue_latency', thresholds: { critical: 5, critical_recovery: null } };
const PARSED = parse('avg(last_5m):avg:worker.queue.latency{env:demo} > 5');

const clientReturning = (series) => ({
  query: async () => ({ series }),
  searchMetrics: async () => ({ results: { metrics: [] } }),
});

const at = (minutesAgo, value) => [Date.now() - minutesAgo * 60000, value];

test('a series carrying nothing but nulls is not live', async () => {
  const client = clientReturning([{ pointlist: [at(15, null), at(10, null), at(5, null)] }]);
  const [finding] = await liveness.run(MONITOR, PARSED, client);

  assert.strictEqual(finding.level, 'fail');
  assert.strictEqual(finding.code, 'NO_POINTS');
});

test('a single numeric point is enough, including zero', async () => {
  const client = clientReturning([{ pointlist: [at(10, null), at(5, 0)] }]);
  const [finding] = await liveness.run(MONITOR, PARSED, client);

  assert.strictEqual(finding.level, 'pass');
  assert.strictEqual(finding.code, 'HAS_SERIES');
});

test('points older than the 24h window do not count as live', async () => {
  const client = clientReturning([{ pointlist: [at(2000, 42), at(5, null)] }]);
  const [finding] = await liveness.run(MONITOR, PARSED, client);

  assert.strictEqual(finding.code, 'NO_POINTS');
});

const emptyWithKnown = (metrics) => ({
  query: async () => ({ series: [] }),
  searchMetrics: async () => ({ results: { metrics } }),
});

test('a quiet counter that alerts on a rise is a warning, not a dead monitor', async () => {
  const parsed = parse('sum(last_5m):sum:app.errors{env:prod}.as_count() > 0');
  const [finding] = await liveness.run(MONITOR, parsed, emptyWithKnown(['app.errors']));

  assert.strictEqual(finding.level, 'warn');
  assert.strictEqual(finding.code, 'NO_RECENT_DATA');
});

test('no data on a monitor that alerts on a drop still fails', async () => {
  const parsed = parse('sum(last_5m):sum:app.requests{env:prod}.as_count() < 5');
  const [finding] = await liveness.run(MONITOR, parsed, emptyWithKnown(['app.requests']));

  assert.strictEqual(finding.level, 'fail');
  assert.strictEqual(finding.code, 'NO_SERIES');
});

test('a metric that does not exist fails whatever the operator', async () => {
  const parsed = parse('sum(last_5m):sum:app.erors{env:prod}.as_count() > 0');
  const [finding] = await liveness.run(MONITOR, parsed, emptyWithKnown(['app.errors']));

  assert.strictEqual(finding.level, 'fail');
  assert.strictEqual(finding.suggestion, 'Did you mean app.errors?');
});

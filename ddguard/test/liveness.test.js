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

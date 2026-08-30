const test = require('node:test');
const assert = require('node:assert');
const { isMetricMonitor } = require('../src/plan');

test('accepts Terraform metric monitor type names', () => {
  assert.strictEqual(isMetricMonitor({ type: 'metric alert' }), true);
  assert.strictEqual(isMetricMonitor({ type: 'query alert' }), true);
});

test('rejects unsupported monitor types', () => {
  assert.strictEqual(isMetricMonitor({ type: 'log alert' }), false);
  assert.strictEqual(isMetricMonitor({ type: 'composite' }), false);
});

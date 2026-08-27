const test = require('node:test');
const assert = require('node:assert');
const { render, verify, exitCode } = require('../src/report');

const MONITORS = [
  { address: 'datadog_monitor.a', name: 'A' },
  { address: 'datadog_monitor.b', name: 'B' },
];

const unavailable = (monitor, check, detail) => ({
  monitor, check, level: 'warn', code: 'CHECK_UNAVAILABLE', message: 'Could not reach the API.', detail,
});
const ok = (monitor, check) => ({ monitor, check, level: 'pass', code: 'OK', message: 'fine' });

test('partial unavailability is a warning, not a tool error', () => {
  const findings = [
    unavailable('datadog_monitor.a', 'liveness', 'ECONNREFUSED'),
    ok('datadog_monitor.a', 'handles'),
    ok('datadog_monitor.b', 'liveness'),
  ];
  const v = verify(MONITORS, findings);

  assert.strictEqual(v.blocked, null);
  assert.strictEqual(v.verified, 2);
  assert.strictEqual(exitCode(MONITORS, findings), 0);
});

test('nothing verified anywhere is exit 2, not a clean run', () => {
  const findings = MONITORS.flatMap((m) => [
    unavailable(m.address, 'liveness', 'ECONNREFUSED'),
    unavailable(m.address, 'handles', 'ECONNREFUSED'),
  ]);
  const notes = [];

  assert.strictEqual(exitCode(MONITORS, findings, (s) => notes.push(s)), 2);
  assert.strictEqual(verify(MONITORS, findings).verified, 0);
  assert.match(notes[0], /not one of 2 monitors could be verified/);
});

test('rejected credentials are exit 2 even if something else got through', () => {
  const findings = [
    unavailable('datadog_monitor.a', 'liveness', '403 /api/v1/query'),
    ok('datadog_monitor.b', 'handles'),
  ];
  const notes = [];

  assert.strictEqual(exitCode(MONITORS, findings, (s) => notes.push(s)), 2);
  assert.match(notes[0], /DD_API_KEY/);
});

test('findings still outrank a fully verified run', () => {
  const findings = [{ monitor: 'datadog_monitor.a', check: 'handles', level: 'fail', code: 'HANDLE_UNRESOLVED', message: 'x' }];
  assert.strictEqual(exitCode(MONITORS.slice(0, 1), findings), 1);
});

test('the header states how many monitors went unverified', () => {
  const findings = [unavailable('datadog_monitor.a', 'liveness', 'ECONNREFUSED'), ok('datadog_monitor.b', 'liveness')];

  assert.match(render(MONITORS, findings, 'terminal'), /1 unverified/);
  assert.match(render(MONITORS, findings, 'markdown'), /1 unverified/);
  assert.doesNotMatch(render(MONITORS, [ok('datadog_monitor.a', 'liveness'), ok('datadog_monitor.b', 'liveness')], 'terminal'), /unverified/);
});

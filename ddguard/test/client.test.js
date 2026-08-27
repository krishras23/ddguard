const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createClient } = require('../src/client');
const handles = require('../src/checks/handles');

async function serve(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const ACCOUNTS = { main: ['#worker-alerts', '#nginx-alerts'], platform: ['#platform-oncall', '#nginx-alerts'] };

function pagerdutyRoutes(req, res) {
  json(res, { services: [{ service_name: 'nginx-oncall' }, { service_name: 'worker-oncall' }] });
}

test('integration lookups hit the network at most once', async (t) => {
  const { url, requests } = await serve(t, pagerdutyRoutes);
  const client = createClient({ apiUrl: url });

  await Promise.all([client.pagerdutyServices(), client.pagerdutyServices()]);
  await client.pagerdutyServices();

  assert.strictEqual(requests.filter((r) => r.endsWith('/pagerduty')).length, 1);
});

test('a reset after headers rejects instead of hanging', async (t) => {
  const { url } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
    res.write('{"services":');
    res.socket.destroy();
  });
  const client = createClient({ apiUrl: url });

  await assert.rejects(client.pagerdutyServices(), /connection reset|ECONNRESET/);
});

test('an oversized response is rejected, not buffered', async (t) => {
  const { url } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.alloc(33 * 1024 * 1024, 'a'));
  });
  const client = createClient({ apiUrl: url });

  await assert.rejects(client.pagerdutyServices(), /returned more than 33554432 bytes/);
});

test('non-PagerDuty handles are counted but not verified', async (t) => {
  const { url } = await serve(t, pagerdutyRoutes);
  const client = createClient({ apiUrl: url });

  const findings = await handles.run(
    { address: 'datadog_monitor.x', message: 'page @pagerduty-nginx-oncall cc @slack-nginx-alerts' },
    client
  );

  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].level, 'pass');
  assert.match(findings[0].message, /1 non-PagerDuty handle\(s\) not verified/);
});

test('a pagerduty outage leaves handles unverified without failing', async (t) => {
  const { url } = await serve(t, (req, res) => json(res, { errors: ['upstream'] }, 503));
  const client = createClient({ apiUrl: url });

  const findings = await handles.run(
    { address: 'datadog_monitor.x', message: '@pagerduty-nginx-onclal' },
    client
  );

  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].code, 'CHECK_UNAVAILABLE');
});

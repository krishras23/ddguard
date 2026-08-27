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

function slackRoutes(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const m = /^\/api\/v1\/integration\/slack\/configuration\/accounts\/([^/]+)\/channels$/.exec(p);
  if (m) return json(res, ACCOUNTS[m[1]].map((name) => ({ name, display: { message: true } })));
  if (p === '/api/v1/integration/slack/configuration/accounts') {
    return json(res, Object.keys(ACCOUNTS).map((account_name) => ({ account_name })));
  }
  if (p === '/api/v1/integration/pagerduty') return json(res, { services: [{ service_name: 'nginx-oncall' }] });
  json(res, { errors: ['not found'] }, 404);
}

test('slack verification requires an explicit account', async (t) => {
  const { url, requests } = await serve(t, slackRoutes);
  const client = createClient({ apiUrl: url });

  // Datadog documents no endpoint that lists Slack accounts, so we refuse rather than guess one
  await assert.rejects(client.slackChannels(), /DD_SLACK_ACCOUNT not set/);
  assert.deepStrictEqual(requests, []);
});

test('DD_SLACK_ACCOUNT pins one account and skips discovery', async (t) => {
  const { url, requests } = await serve(t, slackRoutes);
  const client = createClient({ apiUrl: url, slackAccount: 'platform' });

  const names = (await client.slackChannels()).map((c) => c.name);
  assert.deepStrictEqual(names, ['#platform-oncall', '#nginx-alerts']);
  assert.deepStrictEqual(requests, ['/api/v1/integration/slack/configuration/accounts/platform/channels']);
});

test('integration lookups hit the network at most once', async (t) => {
  const { url, requests } = await serve(t, slackRoutes);
  const client = createClient({ apiUrl: url, slackAccount: 'platform' });

  await Promise.all([client.slackChannels(), client.pagerdutyServices(), client.slackChannels()]);
  await client.pagerdutyServices();

  assert.strictEqual(requests.filter((r) => r.endsWith('/channels')).length, 1);
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

test('a slack outage still verifies pagerduty handles', async (t) => {
  const { url } = await serve(t, (req, res) => {
    if (req.url.includes('/slack/')) return json(res, { errors: ['upstream'] }, 503);
    slackRoutes(req, res);
  });
  const client = createClient({ apiUrl: url });

  const monitor = {
    address: 'datadog_monitor.nginx_5xx_rate',
    message: 'page @pagerduty-nginx-onclal cc @slack-nginx-alerts',
  };
  const findings = await handles.run(monitor, client);

  const unresolved = findings.filter((f) => f.code === 'HANDLE_UNRESOLVED');
  assert.strictEqual(unresolved.length, 1);
  assert.match(unresolved[0].suggestion, /@pagerduty-nginx-oncall/);

  const unavailable = findings.filter((f) => f.code === 'CHECK_UNAVAILABLE');
  assert.strictEqual(unavailable.length, 1);
  assert.match(unavailable[0].message, /Slack integration API — @slack-nginx-alerts unverified/);
});

test('both providers down yields one finding each', async (t) => {
  const { url } = await serve(t, (req, res) => json(res, { errors: ['down'] }, 503));
  const client = createClient({ apiUrl: url });

  const findings = await handles.run(
    { address: 'datadog_monitor.x', message: '@slack-a @slack-b @pagerduty-c' },
    client
  );
  const codes = findings.map((f) => f.code);
  assert.deepStrictEqual(codes, ['CHECK_UNAVAILABLE', 'CHECK_UNAVAILABLE']);
  assert.match(findings[0].message, /@slack-a, @slack-b/);
  assert.match(findings[1].message, /PagerDuty.*@pagerduty-c/);
});

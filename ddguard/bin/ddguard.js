#!/usr/bin/env node
const plan = require('../src/plan');
const query = require('../src/query');
const report = require('../src/report');
const { createClient } = require('../src/client');

const checks = {
  config: require('../src/checks/config'),
  liveness: require('../src/checks/liveness'),
  handles: require('../src/checks/handles'),
  backtest: require('../src/checks/backtest'),
};

const USAGE = `usage: ddguard [plan.json] [--format=terminal|markdown|json] [--no-backtest] [--days=N]

  DD_API_URL   metrics API base (default http://localhost:8126)
  DD_API_KEY   required by real Datadog, ignored by mockdd
  DD_APP_KEY   required by real Datadog, ignored by mockdd`;

const FORMATS = ['terminal', 'markdown', 'json'];

function parseArgs(argv) {
  const opts = { path: 'fixtures/tfplan.json', format: 'terminal', backtest: true, days: 30 };
  for (const arg of argv) applyArg(opts, arg);
  reject(opts);
  return opts;
}

function applyArg(opts, arg) {
  if (arg === '--help' || arg === '-h') opts.help = true;
  else if (arg === '--no-backtest') opts.backtest = false;
  else if (arg.startsWith('--format=')) opts.format = arg.slice(9);
  else if (arg.startsWith('--days=')) opts.days = Number(arg.slice(7));
  else if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`);
  else opts.path = arg;
}

function reject(opts) {
  if (!FORMATS.includes(opts.format)) throw new Error(`unknown format ${opts.format}`);
  if (!Number.isInteger(opts.days) || opts.days < 1) throw new Error('--days must be a positive integer');
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function inspect(monitor, client, opts) {
  const parsed = query.parse(monitor.query);
  const findings = parsed
    ? []
    : [{
        monitor: monitor.address,
        check: 'query',
        level: 'warn',
        code: 'QUERY_UNPARSEABLE',
        message: 'ddguard could not parse this query — only config checks ran.',
        detail: monitor.query,
      }];

  const results = await Promise.all([
    checks.config.run(monitor, parsed),
    checks.liveness.run(monitor, parsed, client),
    checks.handles.run(monitor, client),
    opts.backtest ? checks.backtest.run(monitor, parsed, client, { days: opts.days }) : [],
  ]);
  return findings.concat(...results);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(USAGE), 0;

  const monitors = plan.load(opts.path).filter(plan.isMetricMonitor);
  if (!monitors.length) throw new Error(`no datadog_monitor metric alerts in ${opts.path}`);

  const client = createClient({
    apiUrl: process.env.DD_API_URL || 'http://localhost:8126',
    apiKey: process.env.DD_API_KEY,
    appKey: process.env.DD_APP_KEY,
  });

  const findings = (await pool(monitors, 4, (m) => inspect(m, client, opts))).flat();
  const color = (process.stdout.isTTY || process.env.FORCE_COLOR) && !process.env.NO_COLOR;
  console.log(report.render(monitors, findings, opts.format, { color }));

  return report.exitCode(monitors, findings, (msg) => console.error(`ddguard: ${msg}`));
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`ddguard: ${err.message}`);
    process.exit(2);
  }
);

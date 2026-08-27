# ddguard

Catches Datadog monitors that will never fire, before they merge.

Datadog's Terraform provider validates monitor queries during `plan`. It checks **syntax only**.
This applies cleanly, shows up green in the monitor list, and pages nobody, forever:

```hcl
query = "avg(last_5m):avg:this.metric.does.not.exist{env:prod} > 90"
```

Green does not mean healthy. Green means *"no evaluation produced a value above the threshold"* —
which is also exactly what *"no evaluation has ever happened"* looks like. You find out during the
outage.

`ddguard` reads a Terraform plan and answers three questions Datadog cannot answer at plan time:
**will this monitor ever fire, how often would it have fired last month, and will anyone hear it.**

![ddguard catching three monitors that would never have paged anyone](demo/ddguard.gif)

## Try it

No Datadog account, no API keys, no `terraform` binary:

```bash
make demo
```

```
ddguard  ·  8 monitors  ·  3 failed  ·  4 warnings

FAIL  datadog_monitor.worker_processed_drop
      [P1][worker] Jobs processed drop
      liveness  NO_SERIES
      Query returned 0 series over the last 24h — this monitor can never fire.
      metric: worker.runs.procesed
      → Did you mean worker.runs.processed?

FAIL  datadog_monitor.scheduler_queue_rate
      [P2][scheduler] Queue rate below floor
      liveness  NO_SERIES
      Query returned 0 series over the last 24h — this monitor can never fire.
      metric: scheduler.runs.queued
      → scheduler.runs.queued exists but reports nothing for {env:prod, service:scheduler} — check the scope tags.

FAIL  datadog_monitor.nginx_5xx_rate
      [P1][nginx] 5xx rate high
      handles  HANDLE_UNRESOLVED
      @pagerduty-nginx-onclal does not resolve to a configured integration — notifications are silently dropped.
      known: worker-oncall, nginx-oncall, scheduler-oncall
      → Did you mean @pagerduty-nginx-oncall?

WARN  datadog_monitor.worker_queue_latency
      [P2][worker] Queue latency high
      backtest  BACKTEST_TOO_NOISY
      30-day backtest: 712 transitions (170 single-bucket flaps) ≈ 166 pages/week
      → at critical=676 (p99.8) this would have fired 20 times instead of 712

PASS  datadog_monitor.worker_dead_letters
      [P1][worker] Dead-lettered jobs (demo)
      config ✓  liveness ✓ (1 series)  handles ✓  backtest ✓ (1 transition in 30d)
```

Eight fixture monitors: one deliberately correct, seven carrying one real defect each.

## What it checks

| Check | Catches |
|---|---|
| `liveness` | Query returns zero series — typo'd metric, wrong scope tag, group-by that matches nothing |
| `handles` | `@pagerduty-paymnets` — Datadog drops unresolvable handles silently, at every layer |
| `config` | Missing `critical_recovery`, `no_data_timeframe` under 2× the window, grouped monitors with no `new_group_delay` |
| `backtest` | Replays 30 days through the state machine: monitors that never fire, and monitors that fire 700 times |

## The backtest

The part that isn't a linter. It replays the monitor's own query, window, threshold and recovery
against 30 days of history, runs the state machine, and counts real `OK → ALERT` transitions:

```
30-day backtest: 712 transitions (170 single-bucket flaps) ≈ 166 pages/week
→ at critical=676 (p99.8) this would have fired 20 times instead of 712
```

That suggested threshold is **searched, not sampled from a percentile ladder** — which matters more
than it sounds. p99 of N buckets leaves N/100 buckets above the line by construction, so on a 30-day
5-minute series a p99 threshold yields ~86 crossings *regardless of the metric*. The thresholds that
actually quiet a monitor live around p99.8. A fixed p90/p95/p99 ladder can never reach them.

A candidate that fires zero times is never suggested. Recommending a monitor that never fires is the
thing this tool exists to prevent.

## Against real Datadog

Same code path, one environment variable:

```bash
export DD_API_URL=https://api.datadoghq.com
export DD_API_KEY=... DD_APP_KEY=...

terraform plan -out=tfplan
terraform show -json tfplan > plan.json
node ddguard/bin/ddguard.js plan.json
```

Exit `0` clean · `1` findings · `2` tool error. `--format=markdown` for a PR comment,
`--format=json` to pipe, `--no-backtest` to skip the slow check, `--days=N` to widen it.

`.github/workflows/ddguard.yml` runs it on pull requests and writes the table to the job summary.

## mockdd is a demo shim

`mockdd/` is a small server that speaks Datadog's API shapes over 30 days of generated fixture data,
so `make demo` works on a clean checkout with no signup. **It is not a metrics database and does not
pretend to be one.** It exists so the tool can be seen working in one command.

The workload it models is real: an nginx edge with a canary split, three web instances, and a
scheduler publishing to RabbitMQ with a worker doing retry and dead-letter handling.
See [docs/demo-stack.md](docs/demo-stack.md).

## Layout

```
ddguard/       the CLI — plan parser, query parser, four checks, reporters
mockdd/        Datadog-shaped API + fixture generator
fixtures/      monitors.tf and the tfplan.json ddguard reads
apps/ infra/   the demo workload
docs/          demo stack notes, metrics primer
IMPLEMENTATION.md   design decisions and contracts
```

Node, CommonJS, no runtime dependencies. `npm test` — 21 tests.

## Limitations

- `query alert` monitors only. Log, APM, composite and SLO monitors are skipped silently.
- `fixtures/tfplan.json` is maintained by hand alongside `monitors.tf`; there is no `terraform`
  binary in this repo to regenerate it.
- The backtest reads whatever retention your metric actually has. A 30-day window against a metric
  Datadog rolled up will replay the rolled-up values, not raw.
- `make demo` reports ddguard's exit code rather than propagating it, so the recipe reads cleanly.
  `make check` propagates, and is what CI uses.

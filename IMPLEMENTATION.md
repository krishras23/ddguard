# ddguard — MVP Implementation Spec

**What it is.** A CLI that reads a Terraform plan and tells you, *before merge*, whether each
Datadog monitor will ever actually fire, how often it would have fired last month, and whether
anyone would hear it.

**Why it exists.** Datadog's `POST /api/v1/monitor/validate` — which the Terraform provider calls
during `plan` — checks **syntax only**. This applies cleanly and is green forever:

```hcl
query = "avg(last_5m):avg:this.metric.does.not.exist{env:prod} > 90"
```

Green does not mean healthy. Green means *"no evaluation has produced a value above the
threshold"* — which is also exactly what *"no evaluations have ever happened"* looks like.
Nothing in the ecosystem catches this. `datadog-ci` has no monitor command; the only third-party
tool (`persona-id/datadog-query-linter`) is another syntax checker.

---

## 1. MVP scope

### In
| # | Check | Network? | Output |
|---|---|---|---|
| 1 | **Liveness** — does the query return >0 series over the last 24h? | yes | FAIL |
| 2 | **Group count** — does `by {…}` produce 0 groups (never fires) or >1000 (page storm)? | yes | FAIL / WARN |
| 3 | **Handles** — does every `@handle` in `message` resolve to a configured integration? | yes | FAIL |
| 4 | **Config sanity** — hysteresis, `no_data_timeframe`, `new_group_delay`, tags, runbook | no | WARN |
| 5 | **Backtest** — replay 30d through the state machine; count transitions; suggest a threshold | yes | WARN |

### Out (explicitly, for MVP)
- `--fix` / autoremediation
- HCL parsing — we consume `terraform show -json` output only
- Non-`query alert` monitor types (log, APM, composite, SLO)
- Dashboards, SLOs, downtimes
- A published GitHub Action (we ship the workflow YAML, not a marketplace action)
- Real Datadog account required — see §2

### Non-goals
Not a mini-Datadog. We store nothing and evaluate nothing at runtime. We are a **pre-merge
linter** that reads a plan and asks a metrics backend some questions.

---

## 2. The zero-credentials decision

**Problem.** A demo that requires a Datadog trial signup gets closed. A demo that requires
credentials can't run in CI on a fork.

**Decision.** Ship `mockdd`, a small server that speaks Datadog's API shapes, backed by the
scheduler/worker stack's own run history. `ddguard` points at it via `DD_API_URL`.

```
DD_API_URL=http://localhost:8126   → mockdd      (demo, no signup)
DD_API_URL=https://api.datadoghq.com → real Datadog (same code path)
```

This is the single most important product decision in the MVP: **`make demo` works on a clean
checkout with no account, no keys, and no `terraform` binary.** Same reason we commit
`fixtures/tfplan.json` — `terraform` is not installed on most machines and the plan JSON is a
stable, inspectable artifact.

`mockdd` is a **demo shim, and the README says so plainly.** It is not a metrics database, it is
not claimed to be one, and it exists so a reviewer can see the tool work in one command.

---

## 3. Language

**Node, CommonJS, zero runtime dependencies.**

The fixture stack is already Node with `node_modules` present, `http` and `fs` cover everything,
and the MVP's job is to validate the idea, not to be installable. Go would make a better
*artifact* — single binary, `go install`, matches Datadog's own stack — and that is the v1 path
if this gets any traction. Keeping every check a pure function over plain objects makes that
port mechanical rather than a rewrite.

Recorded here as a deliberate, reversible call rather than an accident.

---

## 4. Layout

```
ddguard/
  bin/ddguard.js           CLI entry, arg parsing, exit codes
  src/types.js             JSDoc typedefs — the contract between modules
  src/plan.js              terraform show -json  →  Monitor[]
  src/query.js             monitor query string  →  ParsedQuery
  src/client.js            Datadog API client (mockdd or real)
  src/report.js            terminal + markdown renderers
  src/checks/config.js     pure, no network
  src/checks/liveness.js   checks 1 + 2
  src/checks/handles.js    check 3
  src/checks/backtest.js   check 5
mockdd/
  server.js                Datadog-shaped HTTP API
  seed.js                  fixture data generator (30d, injected failures)
fixtures/
  monitors.tf              human-readable source of truth
  tfplan.json              committed; what ddguard actually eats
.github/workflows/ci.yml
Makefile
```

---

## 5. Contracts

These are pinned. Do not change a field name without changing it here first.

### `Monitor` (from `plan.js`)
```js
{
  address:  "datadog_monitor.worker_dead_letters",  // TF address
  name:     "[P1][worker] Dead-lettered jobs (demo)",
  type:     "query alert",
  query:    "sum(last_10m):sum:worker.runs.processed{...}.as_count() >= 1",
  message:  "...@pagerduty-worker-oncall...",
  tags:     ["team:platform", "service:worker", ...],
  priority: 1,                    // may be null
  thresholds: { critical: 1, critical_recovery: null, warning: null, warning_recovery: null },
  notify_no_data: false,
  no_data_timeframe: 10,          // minutes, may be null
  new_group_delay: null,          // seconds, may be null
  evaluation_delay: null,         // seconds, may be null
  require_full_window: true,
  on_missing_data: "resolve",     // may be null
  action: "create"                // create | update
}
```

### `ParsedQuery` (from `query.js`)
```js
{
  raw:             "sum(last_10m):sum:worker.runs.processed{env:demo} by {status}.as_count() >= 1",
  timeAggregator:  "sum",         // sum | avg | min | max | count
  windowSeconds:   600,           // last_10m → 600
  spaceAggregator: "sum",
  metric:          "worker.runs.processed",
  scope:           { env: "demo" },
  groupBy:         ["status"],    // [] if ungrouped
  modifiers:       ["as_count"],
  operator:        ">=",
  threshold:       1,
  dataQuery:       "sum:worker.runs.processed{env:demo} by {status}.as_count()"  // threshold stripped
}
```

`dataQuery` is what gets sent to `/api/v1/query`. Strip the leading `<timeAgg>(<window>):` and
the trailing ` <op> <number>`.

If the query cannot be parsed, return `null` and emit a `warn` finding `QUERY_UNPARSEABLE`.
Never throw — one weird monitor must not abort the run.

### `Finding` (every check returns `Finding[]`)
```js
{
  monitor:    "datadog_monitor.worker_dead_letters",
  check:      "liveness",
  level:      "fail",             // fail | warn | pass
  code:       "NO_SERIES",        // stable, greppable
  message:    "Query returned 0 series over the last 24h — this monitor can never fire.",
  detail:     "metric: worker.runs.procesed",     // optional
  suggestion: "Did you mean worker.runs.processed?" // optional
}
```

### Check module signatures
```js
// checks/config.js
run(monitor, parsed) => Finding[]                        // sync, pure

// checks/liveness.js
async run(monitor, parsed, client) => Finding[]

// checks/handles.js
async run(monitor, client) => Finding[]

// checks/backtest.js
async run(monitor, parsed, client, { days = 30 }) => Finding[]
```

### `client.js`
```js
createClient({ apiUrl, apiKey, appKey })
  .query(dataQuery, fromSec, toSec)  => { status, series: [{ metric, scope, pointlist: [[ms, val]] }] }
  .searchMetrics(q)                  => { results: { metrics: string[] } }
  .slackChannels()                   => [{ name: "#worker-alerts" }]
  .pagerdutyServices()               => [{ service_name: "worker-oncall" }]
```
Real Datadog needs `DD-API-KEY` / `DD-APPLICATION-KEY` headers; `mockdd` ignores them.
On network error, surface a `warn` finding `CHECK_UNAVAILABLE` — never a hard fail. A flaky
API must not block a merge.

---

## 6. Backtest algorithm

The differentiating feature. Everything else is table stakes.

### Threshold source

Terraform accepts the critical threshold in the query string alone, with no `monitor_thresholds`
block, in which case `plan.js` reports `thresholds.critical: null`. The backtest uses
`monitor.thresholds.critical ?? parsed.threshold`, so those monitors are still replayed. When both
are present and disagree, that is a real config bug — Datadog evaluates the query — so emit a warn
`THRESHOLD_MISMATCH` alongside the backtest, which runs at the `monitor_thresholds` value.

### Resolution is the whole problem

`/api/v1/query` rolls a range up to roughly 300 points per series. One 30-day request comes back
at ~2h spacing; bucketing those rollups into 5-minute evaluation windows aggregates the aggregates and
produces a number that looks like a verdict and is not one. `mockdd` serves raw 30s points at any
range and so hides this entirely.

```
chunk    = min(days*86400, 300 * windowSeconds)      // the largest slice that still comes back
                                                     // at <= windowSeconds resolution
requests = min(ceil(days*86400 / chunk), 32)         // hard cap
covered  = min(days*86400, requests * chunk)
```

Slices are fetched in order and concatenated per `scope`, dropping any timestamp already seen at a
chunk boundary. If the cap truncates the range, the finding names the range actually used
(`asked for 30d, used 3.3d — a longer range comes back rolled up past the 30s window`) rather than
claiming 30 days. A short honest window beats a long dishonest one.

Then measure what actually came back: `resolution` = median gap between consecutive timestamps in
the longest returned series, nulls included (Datadog pads rolled-up series with nulls at the rollup
interval, so the padding carries the resolution).

If `resolution > windowSeconds` the replay cannot be reconstructed and there is nothing honest to
guess. Return warn `CHECK_UNAVAILABLE`:

```
The metrics API returned 600s resolution for a 300s evaluation window —
30 days cannot be reconstructed at this window.
```

### Rolling replay

Datadog does not evaluate Unix-aligned non-overlapping buckets. It aggregates the trailing
`windowSeconds` every evaluation, about once a minute, so consecutive evaluations overlap by
`window - cadence`.

```
cadence = min(windowSeconds, max(60, resolution))
for t = first timestamp (rounded up to cadence) .. last, step cadence:
    v = reduce(points in (t - windowSeconds, t], timeAggregator)   // sum | avg | min | max | count
    state = OK
    if state == OK    and compare(v, operator, critical)            -> state = ALERT; transitions++
    if state == ALERT and NOT compare(v, operator, recoveryOrCrit)  -> state = OK
  where recoveryOrCrit = critical_recovery ?? critical
flaps = transitions where the ALERT lasted exactly one evaluation
```

This changes the counts, and in the right direction. A single 60s spike under a 5m window is one
alert held open for five evaluations — not a one-bucket flap — and two spikes six minutes apart
are two transitions, not one, where aligned bucketing merged them into adjacent alerting buckets.

### Output

```
30-day backtest: 41 transitions (29 single-evaluation flaps) ≈ 10 pages/week
reconstructed from 30s points, not Datadog's own evaluation history
```

The second line is the honesty clause: this is a reconstruction from the metric, not a replay of
Datadog's evaluation history, which is not retrievable.

**Verdicts:**
| Transitions over the range used | Level | Message |
|---|---|---|
| 0 | warn `BACKTEST_NEVER_FIRES` | never would have fired — miscalibrated, or watching a dead metric |
| 1–20 | pass | reasonable |
| >20 | warn `BACKTEST_TOO_NOISY` | ~N pages/week — alert fatigue |

**Threshold suggestion** (only when `BACKTEST_TOO_NOISY`): binary-search the threshold that
lands ≤20 transitions, then report which percentile it turned out to be.

A fixed p90/p95/p99 ladder does **not** work, and this is worth stating because it is the
non-obvious part: p99 of N evaluations leaves N/100 above the line by construction, so on a
30-day series at a 1-minute cadence it yields hundreds of crossings *regardless of the metric*.
The thresholds that actually quiet a monitor live around p99.8, which no fixed ladder reaches.
Search, don't guess.

A candidate that fires **zero** times is not a suggestion — return nothing rather than recommend
a monitor that never fires, which is the thing this tool warns about elsewhere.

```
suggestion: at critical=766 (p99.8) this would have fired 20 times instead of 1272
```

If `critical_recovery` is unset, additionally report how many transitions are flaps that
hysteresis alone would have removed. This is the line that makes an SRE care.

---

## 7. Fixture monitors

Eight monitors: 1 clean, 3 hard fails, 4 warns. This spread *is* the demo — every check fires
at least once and the good one stays quiet.

| # | Terraform address | Defect | Expected |
|---|---|---|---|
| 1 | `worker_dead_letters` | none — correct monitor | all pass |
| 2 | `worker_processed_drop` | metric typo `worker.runs.procesed` | FAIL `NO_SERIES` |
| 3 | `scheduler_queue_rate` | `{env:prod}` but data is `env:demo` | FAIL `NO_SERIES` |
| 4 | `nginx_5xx_rate` | handle typo `@pagerduty-nginx-onclal` | FAIL `HANDLE_UNRESOLVED` |
| 5 | `worker_queue_latency` | threshold 5ms — absurdly low | WARN `BACKTEST_TOO_NOISY` + suggestion |
| 6 | `nginx_canary_errors` | no `critical_recovery` | WARN `NO_HYSTERESIS` |
| 7 | `worker_queue_depth` | threshold 999999 | WARN `BACKTEST_NEVER_FIRES` |
| 8 | `scheduler_runs_by_trigger` | grouped, no `new_group_delay`; `no_data_timeframe` 10 < 2×30m | WARN ×2 |

`fixtures/monitors.tf` is the readable source of truth. `fixtures/tfplan.json` is the committed
`terraform show -json` equivalent and **must stay in sync by hand** (no `terraform` binary here).

---

## 8. Metrics `mockdd` serves

All tagged `env:demo` — which is what makes fixture #3's `{env:prod}` correctly return zero series.

| Metric | Type | Tags |
|---|---|---|
| `scheduler.runs.queued` | COUNT | `service:scheduler`, `trigger:{interval,manual,startup}`, `job:write-heartbeat` |
| `worker.runs.processed` | COUNT | `service:worker`, `status:{success,retry-queued,dead-lettered}`, `job:write-heartbeat` |
| `worker.queue.latency` | GAUGE | `service:worker` (ms) |
| `worker.queue.depth` | GAUGE | `service:worker` |
| `nginx.requests` | COUNT | `service:nginx`, `status_class:{2xx,4xx,5xx}`, `target:{web_primary,web_canary}` |

### Seed generator (`mockdd/seed.js`)
The captured `data/*.ndjson` is 3 days of 100% success at a 10s cadence — nothing to backtest.
The generator produces **30 days at 30s cadence**, deterministic from a fixed PRNG seed, with:

- **daily seasonality** — business-hours traffic 3× the overnight floor
- **a dead-letter burst** on day 5 (the thing monitor #1 should catch)
- **a latency regression** starting day 12 that never recovers (a deploy)
- **canary 5xx** elevated relative to primary throughout
- **queue latency** log-normal, ~40ms median, p99 ~1200ms — so the p99 threshold suggestion
  in §6 produces a number that is visibly sane

Output is gitignored; `make demo` regenerates it. The original captured NDJSON stays in the repo
as the real sample it is.

### Time-shifting
Newest generated point maps to `now`, so a checkout works on any date. `mockdd` logs this on
startup: `time-shifted fixture data; newest point = now`.

---

## 9. Output

```
ddguard  ·  8 monitors  ·  3 failed  ·  5 warnings

FAIL  datadog_monitor.worker_processed_drop
      [P1][worker] Jobs processed drop
      liveness  NO_SERIES
      Query returned 0 series over the last 24h — this monitor can never fire.
      metric: worker.runs.procesed
      → Did you mean worker.runs.processed?

WARN  datadog_monitor.worker_queue_latency
      [P2][worker] Queue latency high
      backtest  BACKTEST_TOO_NOISY
      30-day backtest: 412 transitions (180 single-bucket flaps) ≈ 96 pages/week
      → at critical=1200 (p99) this would have fired 6 times instead of 412
      → 180 of 412 are flaps; setting critical_recovery would remove them

PASS  datadog_monitor.worker_dead_letters
      [P1][worker] Dead-lettered jobs (demo)
      liveness ✓  handles ✓  config ✓  backtest ✓ (3 transitions in 30d)
```

- `--format=markdown` → PR-comment table
- `--format=json` → machine-readable `Finding[]`
- `--no-backtest` → skip check 5 (the slow one)
- `--days=N` → backtest window

**Exit codes:** `0` no fails · `1` ≥1 fail · `2` tool error (bad plan, unreachable API).

---

## 10. Build order

Ship-blocking path is 1 → 2 → 3. Everything after is polish that makes it *sendable*.

1. `mockdd` + seed generator — nothing is testable without data
2. `ddguard` core — plan, query, client, report, CLI
3. Checks — config (pure) → liveness → handles → backtest
4. Fixtures — `monitors.tf`, `tfplan.json`, Makefile, compose wiring
5. README + `make demo` + asciinema recording

**After step 3 there is a demoable tool**, which matters: if the backtester stalls, the
liveness check alone still tells the story.

---

## 11. Definition of done

- [ ] `make demo` on a clean checkout: no account, no keys, no `terraform`
- [ ] Exits `1`, prints 3 FAIL and 5 WARN, and monitor #1 stays clean
- [ ] Every check has at least one fixture that trips it
- [ ] `DD_API_URL=https://api.datadoghq.com` runs the identical code path
- [ ] README leads with the green-monitor failure and an asciinema of it being caught
- [ ] README states plainly that `mockdd` is a demo shim

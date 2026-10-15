# Roadmap

ddguard catches Datadog monitors that will never fire, before they merge. The direction from here:
make it a gate teams can adopt incrementally (configuration, suppressions, baselines), report
findings where reviewers already look (SARIF, GitHub annotations, source lines), and widen what it
can prove about a monitor (message templates, plan diffs, more monitor and handle types).

Small, independently shippable increments, ordered so every item's dependencies come before it.
Format (one item per line, machine-readable):

`- [ ] DG-NNN | S/M | Title | Acceptance: ... | Checks: test | After: (none) or DG-xxx,DG-yyy`

Tier S ≈ an afternoon, M ≈ 1-2 days. "Checks: test" means the acceptance criteria are covered by
`npm test` (`node --test ddguard/test/*.test.js`), running offline against stubbed clients or
mockdd; no test talks to real Datadog.

## Backlog

- [ ] DG-001 | S | Load a .ddguard.json config file | Acceptance: --config=PATH (default ./.ddguard.json when present) is read and validated; it can disable checks by name, override the level of any finding code, and set required ownership tag keys; unknown keys or invalid levels exit 2 with a message naming the key; with no config file behaviour is unchanged | Checks: test | After: (none)
- [ ] DG-002 | S | Support per-monitor suppressions | Acceptance: a monitor tag ddguard:ignore:CODE or a message marker "ddguard-ignore: CODE[, CODE]" removes those findings for that monitor; suppressed findings are counted in the report header and listed in json output; suppressing an unknown code produces a warning | Checks: test | After: DG-001
- [ ] DG-003 | M | Gate only new findings against a baseline file | Acceptance: --write-baseline=PATH records current findings keyed by monitor address and code; --baseline=PATH drops findings already in the baseline from the exit code and marks them "baseline" in reports; findings fixed since the baseline are reported as resolved; baseline file round-trips through JSON | Checks: test | After: DG-001
- [ ] DG-004 | S | Add a GitHub Actions annotations output format | Acceptance: --format=github prints ::error/::warning workflow commands, one per fail/warn finding, with the monitor address and message escaped per the workflow-command rules; pass findings print nothing; exit codes match the terminal format | Checks: test | After: (none)
- [ ] DG-005 | M | Map findings to Terraform source locations | Acceptance: --tf-dir=DIR scans *.tf files for resource "datadog_monitor" blocks and attaches file and line to each finding; json, markdown and github formats include the location; resources not found in DIR keep working without a location; fixtures/monitors.tf resolves all eight fixture monitors | Checks: test | After: DG-004
- [ ] DG-006 | M | Add a SARIF output format | Acceptance: --format=sarif emits SARIF 2.1.0 with one rule per finding code and one result per fail/warn finding; levels map fail to error and warn to warning; results carry file and line when DG-005 locations exist; output validates against the required SARIF top-level shape in a test | Checks: test | After: DG-005
- [ ] DG-007 | S | Validate message template variables against the query's groups | Acceptance: a new templates check flags {{x.name}} variables whose tag x is not in the query's group-by (they render empty), and unbalanced {{#is_alert}}/{{/is_alert}} style blocks; a message using {{host.name}} on a monitor grouped by host passes | Checks: test | After: (none)
- [ ] DG-008 | S | Flag handles that only notify on warning or recovery | Acceptance: handles check parses {{#is_warning}}, {{#is_recovery}} and {{#is_alert}} blocks; a monitor whose only handles sit inside is_warning or is_recovery blocks gets an ALERT_UNROUTED warning; handles outside any block still count for alerts | Checks: test | After: (none)
- [ ] DG-009 | M | Backtest the warning threshold alongside critical | Acceptance: when warning is set, the backtest replays warning/warning_recovery and reports warning transitions separately; a warning threshold that never fires in the window yields WARNING_NEVER_FIRES; a warning on the wrong side of critical for the operator yields a config failure | Checks: test | After: (none)
- [ ] DG-010 | M | Report the backtest delta for updated monitors | Acceptance: for plan actions of update, the backtest also replays the before-state query and thresholds and reports "pages/week before → after"; an update that turns a firing monitor into one that never fires is a failure; create actions are unchanged | Checks: test | After: DG-009
- [ ] DG-011 | S | Warn when a plan deletes paging monitors | Acceptance: datadog_monitor resources with a delete action (and not replaced) are reported as MONITOR_DELETED warnings naming any @pagerduty handles they carried; delete-and-create replacements are not flagged; plans with only deletions no longer exit with "no datadog_monitor metric alerts" | Checks: test | After: (none)
- [ ] DG-012 | M | Parse arithmetic queries across multiple metrics | Acceptance: query parser accepts expressions such as a{..} / b{..} * 100 with shared time aggregator and returns every metric term; liveness checks each term and names the dead one; the backtest evaluates the expression point-wise with mockdd serving both series | Checks: test | After: (none)
- [ ] DG-013 | M | Check composite monitors reference real monitors | Acceptance: composite monitors in the plan have their referenced monitor IDs resolved against other plan resources and the monitors API (served by mockdd); a reference to a missing ID is a failure, a reference to a monitor that ddguard failed is a warning; mockdd gains a GET /api/v1/monitor/{id} route | Checks: test | After: (none)
- [ ] DG-014 | M | Verify webhook and Opsgenie handles | Acceptance: @webhook-NAME handles are checked against the webhooks integration endpoint and @opsgenie-NAME against the Opsgenie services endpoint, both served by mockdd with fixture entries; unknown names fail with a nearest-match suggestion; a 404 integration degrades like the PagerDuty path | Checks: test | After: (none)
- [ ] DG-015 | S | Flag time aggregation that does not fit the metric type | Acceptance: liveness reads metric metadata (type and unit) from the metrics metadata endpoint served by mockdd; avg() over a count metric without .as_count() or .as_rate() yields AGGREGATION_MISMATCH warning; gauge metrics are not flagged; metadata lookup failure degrades to CHECK_UNAVAILABLE | Checks: test | After: (none)

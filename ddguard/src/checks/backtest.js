const CHECK = 'backtest';
const NOISY_ABOVE = 20;
// Datadog re-evaluates a query alert about once a minute, over a window that slides with it.
const EVAL_CADENCE = 60;
// /api/v1/query rolls a range up to roughly this many points, whatever the raw interval is.
const POINTS_PER_RESPONSE = 300;
const MAX_REQUESTS = 32;

const REDUCERS = {
  sum: (vs) => vs.reduce((a, b) => a + b, 0),
  avg: (vs) => vs.reduce((a, b) => a + b, 0) / vs.length,
  min: (vs) => Math.min(...vs),
  max: (vs) => Math.max(...vs),
  count: (vs) => vs.length,
};

function compare(v, operator, threshold) {
  switch (operator) {
    case '>': return v > threshold;
    case '>=': return v >= threshold;
    case '<': return v < threshold;
    case '<=': return v <= threshold;
    case '!=': return v !== threshold;
    default: return v === threshold;
  }
}

// Median gap between consecutive timestamps, in seconds. Nulls count: Datadog pads a
// rolled-up series with them, and their spacing is the rollup interval.
function resolutionOf(pointlist) {
  const gaps = [];
  for (let i = 1; i < pointlist.length; i++) gaps.push((pointlist[i][0] - pointlist[i - 1][0]) / 1000);
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

// Datadog does not aggregate Unix-aligned buckets; it aggregates the last `windowSeconds`
// every `cadence` seconds, so consecutive evaluations overlap.
function roll(pointlist, windowSeconds, cadence, timeAggregator) {
  const reduce = REDUCERS[timeAggregator] || REDUCERS.avg;
  const points = pointlist.filter(([, v]) => v !== null && v !== undefined);
  if (!points.length) return [];

  const first = points[0][0] / 1000;
  const last = points[points.length - 1][0] / 1000;
  const values = [];
  let lo = 0;
  for (let t = Math.ceil(first / cadence) * cadence; t <= last; t += cadence) {
    while (lo < points.length && points[lo][0] / 1000 <= t - windowSeconds) lo++;
    const vs = [];
    for (let i = lo; i < points.length && points[i][0] / 1000 <= t; i++) vs.push(points[i][1]);
    if (vs.length) values.push(reduce(vs));
  }
  return values;
}

function replay(groups, operator, critical, recovery) {
  let transitions = 0;
  let flaps = 0;
  for (const values of groups) {
    let alerting = false;
    let length = 0;
    for (const v of values) {
      if (!alerting && compare(v, operator, critical)) {
        alerting = true;
        transitions++;
        length = 0;
      }
      if (alerting) {
        if (compare(v, operator, recovery)) length++;
        else {
          alerting = false;
          if (length === 1) flaps++;
        }
      }
    }
    if (alerting && length === 1) flaps++;
  }
  return { transitions, flaps };
}

function percentileOf(sorted, v) {
  let i = 0;
  while (i < sorted.length && sorted[i] <= v) i++;
  return (100 * i) / sorted.length;
}

function round(v) {
  return Math.abs(v) >= 100 ? Math.round(v) : Number(v.toPrecision(3));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// A fixed p90/p95/p99 ladder cannot work here: p99 of N evaluations leaves N/100 above the
// line, which on a 30-day series is hundreds of crossings no matter the metric.
// Search for the threshold that actually hits the target, then report where it landed.
function suggestThreshold(groups, all, parsed, critical, criticalRecovery) {
  const low = parsed.operator === '<' || parsed.operator === '<=';
  const sorted = [...all].sort((a, b) => a - b);
  const ratio = criticalRecovery === null ? 1 : criticalRecovery / critical;
  const transitionsAt = (t) => replay(groups, parsed.operator, t, t * ratio).transitions;

  let noisy = critical;
  let quiet = low ? sorted[0] : sorted[sorted.length - 1];
  if (transitionsAt(quiet) > NOISY_ABOVE) return null;

  for (let i = 0; i < 40; i++) {
    const mid = (noisy + quiet) / 2;
    if (transitionsAt(mid) > NOISY_ABOVE) noisy = mid;
    else quiet = mid;
  }

  const transitions = transitionsAt(quiet);
  const suggested = round(quiet);
  if (transitions === 0 || suggested === critical) return null;
  const p = percentileOf(sorted, suggested);
  return { critical: suggested, label: `p${p.toFixed(p >= 99.9 ? 2 : 1)}`, transitions };
}

// One 30-day request comes back rolled up to ~2h points. Slice the range so each request
// covers few enough points that Datadog hands back something near raw, then stitch.
async function fetchRange(client, dataQuery, from, to, chunkSeconds) {
  const byScope = new Map();
  for (let start = from; start < to; start += chunkSeconds) {
    const res = await client.query(dataQuery, start, Math.min(start + chunkSeconds, to));
    for (const s of res.series || []) {
      const key = s.scope || s.metric || '';
      const seen = byScope.get(key);
      if (!seen) {
        byScope.set(key, { ...s, pointlist: [...(s.pointlist || [])] });
        continue;
      }
      const lastMs = seen.pointlist.length ? seen.pointlist[seen.pointlist.length - 1][0] : -Infinity;
      for (const p of s.pointlist || []) if (p[0] > lastMs) seen.pointlist.push(p);
    }
  }
  return [...byScope.values()];
}

function daysLabel(seconds) {
  const d = seconds / 86400;
  return `${d >= 10 ? Math.round(d) : Number(d.toFixed(1))}-day`;
}

async function run(monitor, parsed, client, { days = 30 } = {}) {
  if (!parsed) return [];
  const declared = monitor.thresholds.critical;
  const critical = declared ?? parsed.threshold;
  if (critical === null || critical === undefined) return [];

  const finding = (level, code, message, extra) => ({
    monitor: monitor.address, check: CHECK, level, code, message, ...extra,
  });

  const findings = [];
  if (declared !== null && declared !== undefined && declared !== parsed.threshold) {
    findings.push(finding('warn', 'THRESHOLD_MISMATCH',
      `monitor_thresholds.critical is ${declared} but the query compares against ${parsed.threshold}.`, {
        detail: `backtested at ${critical}`,
        suggestion: 'Datadog evaluates the threshold in the query string — make the two match.',
      }));
  }

  const to = Math.floor(Date.now() / 1000);
  const requested = days * 86400;
  const chunkSeconds = Math.min(requested, POINTS_PER_RESPONSE * parsed.windowSeconds);
  const covered = Math.min(requested, Math.min(Math.ceil(requested / chunkSeconds), MAX_REQUESTS) * chunkSeconds);
  const from = to - covered;

  let series;
  try {
    series = await fetchRange(client, parsed.dataQuery, from, to, chunkSeconds);
  } catch (err) {
    return findings.concat(finding('warn', 'CHECK_UNAVAILABLE',
      `Could not reach the metrics API — ${days}-day backtest skipped.`, { detail: err.message }));
  }

  const longest = series.reduce((a, s) => ((s.pointlist || []).length > (a.pointlist || []).length ? s : a), { pointlist: [] });
  const resolution = resolutionOf(longest.pointlist || []);
  if (resolution === null) return findings;

  const label = daysLabel(covered);
  if (resolution > parsed.windowSeconds) {
    return findings.concat(finding('warn', 'CHECK_UNAVAILABLE',
      `The metrics API returned ${resolution}s resolution for a ${parsed.windowSeconds}s evaluation window — ${label.replace('-day', ' days')} cannot be reconstructed at this window.`, {
        detail: 'Datadog rolls long ranges up automatically; aggregating those rollups into 5-minute evaluations would invent a result.',
        suggestion: `Widen the monitor window past ${resolution}s, or re-run with a smaller --days.`,
      }));
  }

  const cadence = Math.min(parsed.windowSeconds, Math.max(EVAL_CADENCE, resolution));
  const groups = series.map((s) => roll(s.pointlist || [], parsed.windowSeconds, cadence, parsed.timeAggregator));
  const all = groups.flat();
  if (!all.length) return findings;

  const notes = [`reconstructed from ${resolution}s points, not Datadog's own evaluation history`];
  if (covered < requested) {
    notes.unshift(`asked for ${days}d, used ${label.replace('-day', 'd')} — a longer range comes back rolled up past the ${parsed.windowSeconds}s window`);
  }
  const detail = notes.join('\n');

  const criticalRecovery = monitor.thresholds.critical_recovery ?? null;
  const { transitions, flaps } = replay(groups, parsed.operator, critical, criticalRecovery ?? critical);
  const headline = `${label} backtest: ${plural(transitions, 'transition')} (${plural(flaps, 'single-evaluation flap')})`;

  if (transitions === 0) {
    return findings.concat(finding('warn', 'BACKTEST_NEVER_FIRES',
      `${label} backtest: 0 transitions — this monitor would never have fired.`, {
        detail: `critical ${parsed.operator} ${critical}; observed range ${round(Math.min(...all))}..${round(Math.max(...all))} over ${all.length} evaluations\n${detail}`,
        suggestion: 'Either the threshold is miscalibrated or the metric is dead. Both are worth knowing before merge.',
      }));
  }

  if (transitions > NOISY_ABOVE) {
    const perWeek = Math.round((transitions / (covered / 86400)) * 7);
    const lines = [];
    const better = suggestThreshold(groups, all, parsed, critical, criticalRecovery);
    if (better) {
      lines.push(`at critical=${better.critical} (${better.label}) this would have fired ${better.transitions} times instead of ${transitions}`);
    }
    if (criticalRecovery === null && flaps) {
      const half = replay(groups, parsed.operator, critical, critical / 2).transitions;
      if (half < transitions) {
        lines.push(`${flaps} of ${transitions} are single-evaluation flaps; critical_recovery=${round(critical / 2)} alone brings this to ${half}`);
      }
    }
    return findings.concat(finding('warn', 'BACKTEST_TOO_NOISY', `${headline} ≈ ${perWeek} pages/week`, {
      detail,
      suggestion: lines.join('\n') || undefined,
    }));
  }

  return findings.concat(finding('pass', 'BACKTEST_OK', headline, {
    detail: `${plural(transitions, 'transition')} in ${label.replace('-day', 'd')}`,
  }));
}

module.exports = { run, roll, replay, resolutionOf };

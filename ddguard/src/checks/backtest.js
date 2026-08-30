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
    for (const s of res.series || []) merge(byScope, s);
  }
  return [...byScope.values()];
}

// Chunks overlap at their edges and arrive in order, so a series already seen keeps only the
// points newer than its last one.
function merge(byScope, s) {
  const key = s.scope || s.metric || '';
  const seen = byScope.get(key);
  if (!seen) {
    byScope.set(key, { ...s, pointlist: [...pointsOf(s)] });
    return;
  }
  const lastMs = seen.pointlist.length ? seen.pointlist[seen.pointlist.length - 1][0] : -Infinity;
  for (const p of pointsOf(s)) if (p[0] > lastMs) seen.pointlist.push(p);
}

function daysLabel(seconds) {
  const d = seconds / 86400;
  return `${d >= 10 ? Math.round(d) : Number(d.toFixed(1))}-day`;
}

function findingFor(monitor) {
  return (level, code, message, extra) => ({
    monitor: monitor.address, check: CHECK, level, code, message, ...extra,
  });
}

// The threshold in the query string is the one Datadog evaluates; monitor_thresholds.critical
// is what the plan claims. Backtest the former and report the disagreement.
function thresholdMismatch(finding, declared, parsed, critical) {
  if (declared === null || declared === undefined || declared === parsed.threshold) return [];
  return [finding('warn', 'THRESHOLD_MISMATCH',
    `monitor_thresholds.critical is ${declared} but the query compares against ${parsed.threshold}.`, {
      detail: `backtested at ${critical}`,
      suggestion: 'Datadog evaluates the threshold in the query string — make the two match.',
    })];
}

// How much history can be asked for at this window before the API rolls it up past the point
// where evaluations can be reconstructed, and how to slice it.
function planRange(days, windowSeconds) {
  const to = Math.floor(Date.now() / 1000);
  const requested = days * 86400;
  const chunkSeconds = Math.min(requested, POINTS_PER_RESPONSE * windowSeconds);
  const covered = Math.min(requested, Math.min(Math.ceil(requested / chunkSeconds), MAX_REQUESTS) * chunkSeconds);
  return { from: to - covered, to, chunkSeconds, covered, requested };
}

function longestPointlist(series) {
  const longest = series.reduce((a, s) => (pointsOf(s).length > pointsOf(a).length ? s : a), { pointlist: [] });
  return pointsOf(longest);
}

function pointsOf(series) {
  return series.pointlist || [];
}

function reconstructionNotes(resolution, range, days, label, windowSeconds) {
  const notes = [`reconstructed from ${resolution}s points, not Datadog's own evaluation history`];
  if (range.covered < range.requested) {
    notes.unshift(`asked for ${days}d, used ${label.replace('-day', 'd')} — a longer range comes back rolled up past the ${windowSeconds}s window`);
  }
  return notes.join('\n');
}

function tooCoarse(finding, resolution, parsed, label) {
  return finding('warn', 'CHECK_UNAVAILABLE',
    `The metrics API returned ${resolution}s resolution for a ${parsed.windowSeconds}s evaluation window — ${label.replace('-day', ' days')} cannot be reconstructed at this window.`, {
      detail: 'Datadog rolls long ranges up automatically; aggregating those rollups into 5-minute evaluations would invent a result.',
      suggestion: `Widen the monitor window past ${resolution}s, or re-run with a smaller --days.`,
    });
}

// What to tell someone whose monitor pages 300 times a week: the threshold that would have
// quieted it, and whether hysteresis alone would have.
function quieterLines(ctx, counted) {
  const { groups, all, parsed, critical, criticalRecovery } = ctx;
  const lines = [];
  const better = suggestThreshold(groups, all, parsed, critical, criticalRecovery);
  if (better) {
    lines.push(`at critical=${better.critical} (${better.label}) this would have fired ${better.transitions} times instead of ${counted.transitions}`);
  }
  if (criticalRecovery === null && counted.flaps) {
    const half = replay(groups, parsed.operator, critical, critical / 2).transitions;
    if (half < counted.transitions) {
      lines.push(`${counted.flaps} of ${counted.transitions} are single-evaluation flaps; critical_recovery=${round(critical / 2)} alone brings this to ${half}`);
    }
  }
  return lines;
}

function neverFires(finding, ctx) {
  const { label, parsed, critical, all, detail } = ctx;
  return finding('warn', 'BACKTEST_NEVER_FIRES',
    `${label} backtest: 0 transitions — this monitor would never have fired.`, {
      detail: `critical ${parsed.operator} ${critical}; observed range ${round(Math.min(...all))}..${round(Math.max(...all))} over ${all.length} evaluations\n${detail}`,
      suggestion: 'Either the threshold is miscalibrated or the metric is dead. Both are worth knowing before merge.',
    });
}

function tooNoisy(finding, ctx, counted, headline) {
  const perWeek = Math.round((counted.transitions / (ctx.covered / 86400)) * 7);
  return finding('warn', 'BACKTEST_TOO_NOISY', `${headline} ≈ ${perWeek} pages/week`, {
    detail: ctx.detail,
    suggestion: quieterLines(ctx, counted).join('\n') || undefined,
  });
}

// The three things a replay can say: it never fires, it fires far too often, or it fires like
// a monitor someone would want to be paged by.
function verdict(finding, ctx, counted) {
  const headline = `${ctx.label} backtest: ${plural(counted.transitions, 'transition')} (${plural(counted.flaps, 'single-evaluation flap')})`;
  if (counted.transitions === 0) return neverFires(finding, ctx);
  if (counted.transitions > NOISY_ABOVE) return tooNoisy(finding, ctx, counted, headline);
  return finding('pass', 'BACKTEST_OK', headline, {
    detail: `${plural(counted.transitions, 'transition')} in ${ctx.label.replace('-day', 'd')}`,
  });
}

// The query string's threshold when the plan declares none; null when there is nothing to
// backtest against.
function criticalOf(monitor, parsed) {
  const critical = monitor.thresholds.critical ?? parsed.threshold;
  if (critical === null || critical === undefined) return null;
  return critical;
}

// Series in, verdict out. Returns nothing when there is nothing to judge — an empty or
// unreadable series is the liveness check's finding to make, not this one's.
function judge(finding, ctx) {
  const { monitor, parsed, critical, series, range, days } = ctx;
  const resolution = resolutionOf(longestPointlist(series));
  if (resolution === null) return [];

  const label = daysLabel(range.covered);
  if (resolution > parsed.windowSeconds) return tooCoarse(finding, resolution, parsed, label);

  const cadence = Math.min(parsed.windowSeconds, Math.max(EVAL_CADENCE, resolution));
  const groups = series.map((s) => roll(pointsOf(s), parsed.windowSeconds, cadence, parsed.timeAggregator));
  const all = groups.flat();
  if (!all.length) return [];

  const criticalRecovery = monitor.thresholds.critical_recovery ?? null;
  const counted = replay(groups, parsed.operator, critical, criticalRecovery ?? critical);
  return verdict(finding, {
    ...ctx, groups, all, label, criticalRecovery, covered: range.covered,
    detail: reconstructionNotes(resolution, range, days, label, parsed.windowSeconds),
  }, counted);
}

async function run(monitor, parsed, client, opts = {}) {
  if (!parsed) return [];
  const critical = criticalOf(monitor, parsed);
  if (critical === null) return [];

  const days = opts.days ?? 30;
  const finding = findingFor(monitor);
  const findings = thresholdMismatch(finding, monitor.thresholds.critical, parsed, critical);
  const range = planRange(days, parsed.windowSeconds);

  let series;
  try {
    series = await fetchRange(client, parsed.dataQuery, range.from, range.to, range.chunkSeconds);
  } catch (err) {
    return findings.concat(finding('warn', 'CHECK_UNAVAILABLE',
      `Could not reach the metrics API — ${days}-day backtest skipped.`, { detail: err.message }));
  }

  return findings.concat(judge(finding, { monitor, parsed, critical, series, range, days }));
}

module.exports = { run, roll, replay, resolutionOf };

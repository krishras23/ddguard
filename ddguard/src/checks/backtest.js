const CHECK = 'backtest';
const NOISY_ABOVE = 20;

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

function bucket(pointlist, windowSeconds, timeAggregator) {
  const reduce = REDUCERS[timeAggregator] || REDUCERS.avg;
  const buckets = new Map();
  for (const [ms, value] of pointlist) {
    if (value === null || value === undefined) continue;
    const key = Math.floor(ms / 1000 / windowSeconds);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(value);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, vs]) => reduce(vs));
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

// A fixed p90/p95/p99 ladder cannot work here: p99 of N buckets leaves N/100 buckets
// above the line, which on a 30-day 5m series is ~86 crossings no matter the metric.
// Search for the threshold that actually hits the target, then report where it landed.
function suggestThreshold(groups, all, parsed, monitor) {
  const low = parsed.operator === '<' || parsed.operator === '<=';
  const sorted = [...all].sort((a, b) => a - b);
  const { critical, critical_recovery } = monitor.thresholds;
  const ratio = critical_recovery === null ? 1 : critical_recovery / critical;
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

async function run(monitor, parsed, client, { days = 30 } = {}) {
  if (!parsed) return [];
  const critical = monitor.thresholds.critical;
  if (critical === null) return [];

  const finding = (level, code, message, extra) => ({
    monitor: monitor.address, check: CHECK, level, code, message, ...extra,
  });

  const to = Math.floor(Date.now() / 1000);
  let series;
  try {
    const res = await client.query(parsed.dataQuery, to - days * 86400, to);
    series = res.series || [];
  } catch (err) {
    return [finding('warn', 'CHECK_UNAVAILABLE', `Could not reach the metrics API — ${days}-day backtest skipped.`, { detail: err.message })];
  }

  const groups = series.map((s) => bucket(s.pointlist || [], parsed.windowSeconds, parsed.timeAggregator));
  const all = groups.flat();
  if (!all.length) return [];

  const recovery = monitor.thresholds.critical_recovery ?? critical;
  const { transitions, flaps } = replay(groups, parsed.operator, critical, recovery);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const headline = `${days}-day backtest: ${plural(transitions, 'transition')} (${plural(flaps, 'single-bucket flap')})`;

  if (transitions === 0) {
    return [finding('warn', 'BACKTEST_NEVER_FIRES', `${days}-day backtest: 0 transitions — this monitor would never have fired.`, {
      detail: `critical ${parsed.operator} ${critical}; observed range ${round(Math.min(...all))}..${round(Math.max(...all))} over ${all.length} buckets`,
      suggestion: 'Either the threshold is miscalibrated or the metric is dead. Both are worth knowing before merge.',
    })];
  }

  if (transitions > NOISY_ABOVE) {
    const perWeek = Math.round((transitions / days) * 7);
    const lines = [];
    const better = suggestThreshold(groups, all, parsed, monitor);
    if (better) {
      lines.push(`at critical=${better.critical} (${better.label}) this would have fired ${better.transitions} times instead of ${transitions}`);
    }
    if (monitor.thresholds.critical_recovery === null && flaps) {
      const half = replay(groups, parsed.operator, critical, critical / 2).transitions;
      if (half < transitions) {
        lines.push(`${flaps} of ${transitions} are single-bucket flaps; critical_recovery=${round(critical / 2)} alone brings this to ${half}`);
      }
    }
    return [finding('warn', 'BACKTEST_TOO_NOISY', `${headline} ≈ ${perWeek} pages/week`, {
      suggestion: lines.join('\n') || undefined,
    })];
  }

  return [finding('pass', 'BACKTEST_OK', headline, { detail: `${plural(transitions, 'transition')} in ${days}d` })];
}

module.exports = { run, bucket, replay };

const CHECK = 'liveness';
const MAX_GROUPS = 1000;

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

async function explainEmpty(parsed, client) {
  const namespace = parsed.metric.slice(0, parsed.metric.lastIndexOf('.') + 1) || parsed.metric;
  const known = await client.searchMetrics(namespace).then((r) => (r.results && r.results.metrics) || []);
  if (known.includes(parsed.metric)) {
    const scope = Object.entries(parsed.scope).map(([k, v]) => `${k}:${v}`).join(', ');
    return `${parsed.metric} exists but reports nothing for {${scope}} — check the scope tags.`;
  }
  const nearest = known
    .map((m) => [m, distance(m, parsed.metric)])
    .filter(([, d]) => d <= Math.max(2, Math.floor(parsed.metric.length / 5)))
    .sort((a, b) => a[1] - b[1])[0];
  return nearest ? `Did you mean ${nearest[0]}?` : `No metric named ${parsed.metric} has reported.`;
}

async function run(monitor, parsed, client) {
  if (!parsed) return [];
  const finding = (level, code, message, extra) => ({
    monitor: monitor.address, check: CHECK, level, code, message, ...extra,
  });

  const to = Math.floor(Date.now() / 1000);
  let series;
  try {
    const res = await client.query(parsed.dataQuery, to - 86400, to);
    series = res.series || [];
  } catch (err) {
    return [finding('warn', 'CHECK_UNAVAILABLE', `Could not reach the metrics API — liveness unverified.`, { detail: err.message })];
  }

  if (!series.length) {
    return [finding('fail', 'NO_SERIES', 'Query returned 0 series over the last 24h — this monitor can never fire.', {
      detail: `metric: ${parsed.metric}`,
      suggestion: await explainEmpty(parsed, client).catch(() => undefined),
    })];
  }

  if (parsed.groupBy.length && series.length > MAX_GROUPS) {
    return [finding('warn', 'TOO_MANY_GROUPS', `Query returns ${series.length} groups — every one is an independent alert, so a shared outage pages ${series.length} times.`, {
      detail: `by {${parsed.groupBy.join(', ')}}`,
      suggestion: 'Drop a grouping key, or aggregate and alert on the total.',
    })];
  }

  return [finding('pass', 'HAS_SERIES', `Returns ${series.length} series over the last 24h.`, {
    detail: `${series.length} series`,
  })];
}

module.exports = { run };

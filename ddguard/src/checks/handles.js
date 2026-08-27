const CHECK = 'handles';
const PREFIX = 'pagerduty-';
const HANDLE = /@([A-Za-z0-9][A-Za-z0-9._+-]*(?:@[A-Za-z0-9.-]+)?)/g;

function nearest(name, candidates) {
  const shared = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  return candidates
    .map((c) => [c, shared(c, name)])
    .filter(([, n]) => n >= Math.min(6, name.length))
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c)[0];
}

async function run(monitor, client) {
  const finding = (level, code, message, extra) => ({
    monitor: monitor.address, check: CHECK, level, code, message, ...extra,
  });

  const handles = [...new Set([...monitor.message.matchAll(HANDLE)].map((m) => m[1]))];
  if (!handles.length) {
    return [finding('warn', 'NO_HANDLE', 'No @handle in the message — this monitor alerts into the void.')];
  }

  let services;
  try {
    services = await client.pagerdutyServices();
  } catch (err) {
    return [finding('warn', 'CHECK_UNAVAILABLE', 'Could not reach the PagerDuty integration API — handles unverified.', { detail: err.message })];
  }

  const known = services.map((s) => s.service_name);
  const findings = [];
  let unverified = 0;

  for (const handle of handles) {
    if (!handle.startsWith(PREFIX)) {
      unverified++;
      continue;
    }
    const target = handle.slice(PREFIX.length);
    if (known.some((k) => target === k || target.endsWith(`-${k}`))) continue;

    const guess = nearest(target, known);
    findings.push(finding('fail', 'HANDLE_UNRESOLVED', `@${handle} does not resolve to a configured integration — notifications are silently dropped.`, {
      detail: `known: ${known.map((k) => `@${PREFIX}${k}`).join(', ') || '(none)'}`,
      suggestion: guess ? `Did you mean @${PREFIX}${guess}?` : undefined,
    }));
  }

  if (!findings.length) {
    const note = unverified ? `; ${unverified} non-PagerDuty handle(s) not verified` : '';
    findings.push(finding('pass', 'HANDLES_RESOLVE', `All ${handles.length} handle(s) resolve${note}.`));
  }
  return findings;
}

module.exports = { run };

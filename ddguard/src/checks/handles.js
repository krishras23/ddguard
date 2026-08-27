const CHECK = 'handles';
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

  const [slackRes, pagerdutyRes] = await Promise.allSettled([client.slackChannels(), client.pagerdutyServices()]);

  const providers = {
    Slack: {
      prefix: 'slack-',
      known: slackRes.status === 'fulfilled' ? slackRes.value.map((c) => c.name.replace(/^#/, '')) : null,
      error: slackRes.reason && slackRes.reason.message,
      unverified: [],
    },
    PagerDuty: {
      prefix: 'pagerduty-',
      known: pagerdutyRes.status === 'fulfilled' ? pagerdutyRes.value.map((s) => s.service_name) : null,
      error: pagerdutyRes.reason && pagerdutyRes.reason.message,
      unverified: [],
    },
  };
  const findings = [];

  for (const handle of handles) {
    if (handle.includes('@')) continue;

    const provider = Object.values(providers).find((p) => handle.startsWith(p.prefix));
    if (!provider) {
      findings.push(finding('warn', 'HANDLE_UNCHECKED', `@${handle} is not a Slack, PagerDuty or email handle — ddguard cannot verify it resolves.`));
      continue;
    }
    if (!provider.known) {
      provider.unverified.push(handle);
      continue;
    }

    const known = provider.known;
    const target = handle.slice(provider.prefix.length);
    if (known.some((k) => target === k || target.endsWith(`-${k}`))) continue;

    const guess = nearest(target, known);
    findings.push(finding('fail', 'HANDLE_UNRESOLVED', `@${handle} does not resolve to a configured integration — notifications are silently dropped.`, {
      detail: `known: ${known.join(', ') || '(none)'}`,
      suggestion: guess ? `Did you mean @${handle.slice(0, handle.length - target.length)}${guess}?` : undefined,
    }));
  }

  for (const [name, p] of Object.entries(providers)) {
    if (!p.unverified.length) continue;
    findings.push(finding('warn', 'CHECK_UNAVAILABLE', `Could not reach the ${name} integration API — ${p.unverified.map((h) => `@${h}`).join(', ')} unverified.`, { detail: p.error }));
  }

  if (!findings.length) {
    findings.push(finding('pass', 'HANDLES_RESOLVE', `All ${handles.length} handle(s) resolve.`));
  }
  return findings;
}

module.exports = { run };

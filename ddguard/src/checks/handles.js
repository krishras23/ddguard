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

  let channels, services;
  try {
    [channels, services] = await Promise.all([client.slackChannels(), client.pagerdutyServices()]);
  } catch (err) {
    return [finding('warn', 'CHECK_UNAVAILABLE', 'Could not reach the integrations API — handles unverified.', { detail: err.message })];
  }

  const slack = channels.map((c) => c.name.replace(/^#/, ''));
  const pagerduty = services.map((s) => s.service_name);
  const findings = [];

  for (const handle of handles) {
    if (handle.includes('@')) continue;

    let known, target;
    if (handle.startsWith('slack-')) [known, target] = [slack, handle.slice(6)];
    else if (handle.startsWith('pagerduty-')) [known, target] = [pagerduty, handle.slice(10)];
    else {
      findings.push(finding('warn', 'HANDLE_UNCHECKED', `@${handle} is not a Slack, PagerDuty or email handle — ddguard cannot verify it resolves.`));
      continue;
    }

    if (known.some((k) => target === k || target.endsWith(`-${k}`))) continue;

    const guess = nearest(target, known);
    findings.push(finding('fail', 'HANDLE_UNRESOLVED', `@${handle} does not resolve to a configured integration — notifications are silently dropped.`, {
      detail: `known: ${known.join(', ') || '(none)'}`,
      suggestion: guess ? `Did you mean @${handle.slice(0, handle.length - target.length)}${guess}?` : undefined,
    }));
  }

  if (!findings.length) {
    findings.push(finding('pass', 'HANDLES_RESOLVE', `All ${handles.length} handle(s) resolve.`));
  }
  return findings;
}

module.exports = { run };

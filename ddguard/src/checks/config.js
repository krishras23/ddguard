const CHECK = 'config';
const REQUIRED_TAG_KEYS = ['team', 'service'];

// Each rule reads one property of a monitor and returns a finding or nothing. They run in the
// order listed, which is the order they appear in a report.
const RULES = [noHysteresis, missingGroupDelay, noDataTooShort, missingOwnershipTags, noRunbook];

function noHysteresis({ thresholds }) {
  const { critical, critical_recovery } = thresholds;
  if (critical === null || critical_recovery !== null) return null;
  return {
    code: 'NO_HYSTERESIS',
    message: 'No critical_recovery — the monitor recovers the instant it drops below critical, so a value sitting on the threshold flaps.',
    detail: `critical: ${critical}`,
    suggestion: 'Set critical_recovery to a value the metric must clearly return to before resolving.',
  };
}

function missingGroupDelay(monitor, parsed) {
  if (!parsed || !parsed.groupBy.length || monitor.new_group_delay !== null) return null;
  return {
    code: 'MISSING_GROUP_DELAY',
    message: `Grouped by {${parsed.groupBy.join(', ')}} with no new_group_delay — every new group alerts before it has data.`,
    suggestion: 'Set new_group_delay to at least one evaluation window (300s is a common floor).',
  };
}

function noDataTooShort(monitor, parsed) {
  const timeframe = monitor.no_data_timeframe;
  if (!parsed || timeframe === null || timeframe * 60 >= 2 * parsed.windowSeconds) return null;
  return {
    code: 'NO_DATA_TOO_SHORT',
    message: `no_data_timeframe is ${timeframe}m but the evaluation window is ${parsed.windowSeconds / 60}m — no-data will fire on ordinary reporting gaps.`,
    suggestion: `Raise no_data_timeframe to at least ${Math.ceil((2 * parsed.windowSeconds) / 60)}m (2x the window).`,
  };
}

function missingOwnershipTags(monitor) {
  const keys = new Set(monitor.tags.map((t) => t.split(':')[0]));
  const missing = REQUIRED_TAG_KEYS.filter((k) => !keys.has(k));
  if (!missing.length) return null;
  return {
    code: 'MISSING_TAGS',
    message: `Missing ownership tags: ${missing.join(', ')} — nobody can route or filter this alert.`,
    detail: `tags: ${monitor.tags.join(', ') || '(none)'}`,
  };
}

function noRunbook(monitor) {
  if (/https?:\/\//.test(monitor.message)) return null;
  return {
    code: 'NO_RUNBOOK',
    message: 'No runbook link in the message — whoever gets paged at 3am has nothing to act on.',
  };
}

function run(monitor, parsed) {
  const findings = RULES
    .map((rule) => rule(monitor, parsed))
    .filter(Boolean)
    .map((f) => ({ monitor: monitor.address, check: CHECK, level: 'warn', ...f }));

  if (findings.length) return findings;
  return [{ monitor: monitor.address, check: CHECK, level: 'pass', code: 'CONFIG_OK', message: 'Config sane.' }];
}

module.exports = { run };

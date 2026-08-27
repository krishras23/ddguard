const CHECK = 'config';
const REQUIRED_TAG_KEYS = ['team', 'service'];

function run(monitor, parsed) {
  const findings = [];
  const warn = (code, message, extra) =>
    findings.push({ monitor: monitor.address, check: CHECK, level: 'warn', code, message, ...extra });

  const { critical, critical_recovery } = monitor.thresholds;

  if (critical !== null && critical_recovery === null) {
    warn('NO_HYSTERESIS', 'No critical_recovery — the monitor recovers the instant it drops below critical, so a value sitting on the threshold flaps.', {
      detail: `critical: ${critical}`,
      suggestion: 'Set critical_recovery to a value the metric must clearly return to before resolving.',
    });
  }

  if (parsed && parsed.groupBy.length && monitor.new_group_delay === null) {
    warn('MISSING_GROUP_DELAY', `Grouped by {${parsed.groupBy.join(', ')}} with no new_group_delay — every new group alerts before it has data.`, {
      suggestion: 'Set new_group_delay to at least one evaluation window (300s is a common floor).',
    });
  }

  if (parsed && monitor.no_data_timeframe !== null && monitor.no_data_timeframe * 60 < 2 * parsed.windowSeconds) {
    const min = Math.ceil((2 * parsed.windowSeconds) / 60);
    warn('NO_DATA_TOO_SHORT', `no_data_timeframe is ${monitor.no_data_timeframe}m but the evaluation window is ${parsed.windowSeconds / 60}m — no-data will fire on ordinary reporting gaps.`, {
      suggestion: `Raise no_data_timeframe to at least ${min}m (2x the window).`,
    });
  }

  const keys = new Set(monitor.tags.map((t) => t.split(':')[0]));
  const missing = REQUIRED_TAG_KEYS.filter((k) => !keys.has(k));
  if (missing.length) {
    warn('MISSING_TAGS', `Missing ownership tags: ${missing.join(', ')} — nobody can route or filter this alert.`, {
      detail: `tags: ${monitor.tags.join(', ') || '(none)'}`,
    });
  }

  if (!/https?:\/\//.test(monitor.message)) {
    warn('NO_RUNBOOK', 'No runbook link in the message — whoever gets paged at 3am has nothing to act on.');
  }

  if (!findings.length) {
    findings.push({ monitor: monitor.address, check: CHECK, level: 'pass', code: 'CONFIG_OK', message: 'Config sane.' });
  }
  return findings;
}

module.exports = { run };

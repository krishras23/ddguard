const fs = require('fs');

const METRIC_MONITOR_TYPES = new Set(['metric alert', 'query alert']);

function isMetricMonitor(monitor) {
  return METRIC_MONITOR_TYPES.has(monitor.type);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function thresholds(after) {
  const t = after.monitor_thresholds;
  const b = (Array.isArray(t) ? t[0] : t) || {};
  return {
    critical: num(b.critical),
    critical_recovery: num(b.critical_recovery),
    warning: num(b.warning),
    warning_recovery: num(b.warning_recovery),
  };
}

function toMonitor(change) {
  const after = change.change.after;
  return {
    address: change.address,
    name: after.name,
    type: after.type,
    query: after.query,
    message: after.message || '',
    tags: after.tags || [],
    priority: num(after.priority),
    thresholds: thresholds(after),
    notify_no_data: after.notify_no_data === true,
    no_data_timeframe: num(after.no_data_timeframe),
    new_group_delay: num(after.new_group_delay),
    evaluation_delay: num(after.evaluation_delay),
    require_full_window: after.require_full_window !== false,
    on_missing_data: after.on_missing_data || null,
    action: change.change.actions.includes('create') ? 'create' : 'update',
  };
}

function load(path) {
  const plan = JSON.parse(fs.readFileSync(path, 'utf8'));
  const changes = plan.resource_changes || [];
  return changes
    .filter(
      (c) =>
        c.type === 'datadog_monitor' &&
        c.change &&
        c.change.after &&
        (c.change.actions.includes('create') || c.change.actions.includes('update'))
    )
    .map(toMonitor);
}

module.exports = { isMetricMonitor, load };

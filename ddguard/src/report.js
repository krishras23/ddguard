const RANK = { fail: 0, warn: 1, pass: 2 };
const COLOR = { fail: '\x1b[31m', warn: '\x1b[33m', pass: '\x1b[32m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function group(monitors, findings) {
  return monitors
    .map((monitor) => {
      const own = findings.filter((f) => f.monitor === monitor.address);
      const level = own.some((f) => f.level === 'fail') ? 'fail' : own.some((f) => f.level === 'warn') ? 'warn' : 'pass';
      return { monitor, findings: own, level };
    })
    .sort((a, b) => RANK[a.level] - RANK[b.level]);
}

function counts(rows) {
  return {
    monitors: rows.length,
    failed: rows.filter((r) => r.level === 'fail').length,
    warnings: rows.filter((r) => r.level === 'warn').length,
  };
}

function terminal(monitors, findings, { color }) {
  const c = (level, s) => (color ? COLOR[level] + s + RESET : s);
  const dim = (s) => (color ? DIM + s + RESET : s);
  const rows = group(monitors, findings);
  const n = counts(rows);
  const out = [`ddguard  ·  ${plural(n.monitors, 'monitor')}  ·  ${n.failed} failed  ·  ${plural(n.warnings, 'warning')}`, ''];

  for (const row of rows) {
    out.push(`${c(row.level, row.level.toUpperCase().padEnd(4))}  ${row.monitor.address}`);
    out.push(`      ${dim(row.monitor.name)}`);

    if (row.level === 'pass') {
      out.push(
        '      ' +
          row.findings
            .map((f) => `${f.check} ${c('pass', '✓')}${f.detail ? ` (${f.detail})` : ''}`)
            .join('  ')
      );
    } else {
      for (const f of row.findings.filter((x) => x.level !== 'pass')) {
        out.push(`      ${f.check}  ${c(f.level, f.code)}`);
        out.push(`      ${f.message}`);
        if (f.detail) out.push(`      ${dim(f.detail)}`);
        for (const line of (f.suggestion || '').split('\n').filter(Boolean)) out.push(`      → ${line}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

function markdown(monitors, findings) {
  const rows = group(monitors, findings);
  const n = counts(rows);
  const icon = { fail: '❌', warn: '⚠️', pass: '✅' };
  const out = [
    `### ddguard — ${plural(n.monitors, 'monitor')}, ${n.failed} failed, ${plural(n.warnings, 'warning')}`,
    '',
    '| | Monitor | Check | Code | Detail |',
    '|---|---|---|---|---|',
  ];

  for (const row of rows) {
    const shown = row.level === 'pass' ? row.findings.slice(0, 1) : row.findings.filter((f) => f.level !== 'pass');
    for (const f of shown) {
      const check = row.level === 'pass' ? row.findings.map((x) => x.check).join(', ') : f.check;
      const body = [f.message, f.detail, ...(f.suggestion || '').split('\n').filter(Boolean).map((s) => `→ ${s}`)]
        .filter(Boolean)
        .join('<br>');
      out.push(`| ${icon[row.level]} | \`${row.monitor.address}\` | ${check} | \`${f.code}\` | ${body} |`);
    }
  }
  return out.join('\n');
}

function render(monitors, findings, format, { color = false } = {}) {
  if (format === 'json') return JSON.stringify(findings, null, 2);
  if (format === 'markdown') return markdown(monitors, findings);
  return terminal(monitors, findings, { color });
}

module.exports = { render };

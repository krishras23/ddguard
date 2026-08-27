const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

const SHAPE = /^(\w+)\(last_(\d+)([smhdw])\):(.+?)\s*(>=|<=|>|<|!=|==|=)\s*(-?\d+(?:\.\d+)?)$/;
const TERM = /(\w+):([A-Za-z0-9_.*\-]+)\{([^}]*)\}/;
const GROUP_BY = /\bby\s*\{([^}]*)\}/g;
const MODIFIER = /\.([a-z_]+)\(/g;

function parseScope(s) {
  const scope = {};
  for (const part of s.split(',')) {
    const t = part.trim();
    if (!t || t === '*') continue;
    const i = t.indexOf(':');
    if (i === -1) scope[t] = '';
    else scope[t.slice(0, i)] = t.slice(i + 1);
  }
  return scope;
}

function parse(raw) {
  if (typeof raw !== 'string') return null;
  const shape = SHAPE.exec(raw.trim());
  if (!shape) return null;

  const [, timeAggregator, count, unit, body, operator, threshold] = shape;
  const term = TERM.exec(body);
  if (!term) return null;

  const groups = [...body.matchAll(GROUP_BY)].pop();
  const modifiers = [...body.matchAll(MODIFIER)].map((m) => m[1]);

  return {
    raw: raw.trim(),
    timeAggregator,
    windowSeconds: Number(count) * UNIT_SECONDS[unit],
    spaceAggregator: term[1],
    metric: term[2],
    scope: parseScope(term[3]),
    groupBy: groups ? groups[1].split(',').map((g) => g.trim()).filter(Boolean) : [],
    modifiers: [...new Set(modifiers)],
    operator,
    threshold: Number(threshold),
    dataQuery: body.trim(),
  };
}

module.exports = { parse };

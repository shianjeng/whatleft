// Host patterns, shared by allowlists and the known-host table:
//   "example.com"      exactly that host
//   "*.example.com"    example.com and every subdomain of it
//   "a.*.example.com"  "*" inside a pattern stands for exactly one DNS label
//   "*"                every host

export function normalizeHost(host) {
  return String(host).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function normalizePatterns(values) {
  const out = new Set();
  for (const value of [values].flat(Infinity)) {
    if (value == null) continue;
    for (const part of String(value).split(/[\s,]+/)) {
      let pattern = part.trim().toLowerCase();
      if (!pattern) continue;
      pattern = pattern.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '');
      const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(pattern);
      pattern = bracketed ? bracketed[1] : pattern.replace(/:\d+$/, '');
      pattern = pattern.replace(/\.$/, '');
      if (pattern) out.add(pattern);
    }
  }
  return [...out];
}

export function matchPattern(host, pattern) {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.') && !pattern.slice(2).includes('*')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  if (!pattern.includes('*')) return host === pattern;
  const source = pattern
    .split('.')
    .map((label) => (label === '*' ? '[^.]+' : label.replace(/[\\^$.|?+()[\]{}-]/g, '\\$&')))
    .join('\\.');
  return new RegExp(`^${source}$`).test(host);
}

export function findPattern(host, patterns) {
  const normalized = normalizeHost(host);
  return patterns.find((pattern) => matchPattern(normalized, pattern)) ?? null;
}

export function makePolicy({ allow = [], enforce = false } = {}) {
  const patterns = normalizePatterns(allow);
  return {
    allow: patterns,
    enforce: Boolean(enforce),
    decide(host) {
      const rule = findPattern(host, patterns);
      return {
        decision: enforce && !rule ? 'block' : 'allow',
        listed: patterns.length ? rule !== null : null,
        rule,
      };
    },
  };
}

// NO_PROXY as most tools read it: comma/space separated suffixes, a leading
// "." or "*." is optional, "*" means everything. CIDR ranges are not handled.
export function noProxyMatcher(value) {
  const entries = String(value ?? '')
    .split(/[\s,]+/)
    .map((entry) => normalizeHost(entry.replace(/:\d+$/, '')))
    .filter(Boolean);
  return (host) => {
    const target = normalizeHost(host);
    return entries.some((entry) => {
      if (entry === '*') return true;
      const suffix = entry.replace(/^\*?\./, '');
      return target === suffix || target.endsWith(`.${suffix}`);
    });
  };
}

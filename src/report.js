import fs from 'node:fs';
import { formatBytes, formatDuration } from './format.js';
import { classify, KINDS } from './hosts.js';
import { BUCKET_MS } from './session.js';

const MiB = 1024 * 1024;
// Uploads smaller than this are never called out, however small the repo.
export const BURST_FLOOR = 8 * MiB;
// Threshold used when the session did not start inside a git repository.
export const BURST_WITHOUT_REPO = 32 * MiB;
// A 5-second bucket with at least this much upload keeps a burst going.
export const SUSTAINED_BUCKET = 256 * 1024;

const LEVEL_ORDER = { high: 0, warn: 1, info: 2 };

export function loadSession(file) {
  const session = { file, meta: null, conns: [], ticks: [], bypasses: [], notes: [], end: null };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a run that was killed can leave a torn last line
    }
    if (record.type === 'session') session.meta = record;
    else if (record.type === 'conn') session.conns.push(record);
    else if (record.type === 'bytes') session.ticks.push(record);
    else if (record.type === 'bypass') session.bypasses.push(record);
    else if (record.type === 'note') session.notes.push(record);
    else if (record.type === 'end') session.end = record;
  }
  if (!session.meta) throw new Error(`${file} is not a whatleft session log`);
  return session;
}

export function burstThreshold(repoBytes) {
  return repoBytes ? Math.max(BURST_FLOOR, repoBytes * 0.5) : BURST_WITHOUT_REPO;
}

// The largest run of consecutive buckets that each carried a sustained upload.
export function longestBurst(uploads) {
  let best = { bytes: 0, from: 0, to: 0 };
  let run = null;
  for (const index of [...uploads.keys()].sort((a, b) => a - b)) {
    const bytes = uploads.get(index);
    if (bytes < SUSTAINED_BUCKET) {
      run = null;
      continue;
    }
    if (run && index === run.last + 1) {
      run.bytes += bytes;
      run.last = index;
    } else {
      run = { bytes, first: index, last: index };
    }
    if (run.bytes > best.bytes) {
      best = { bytes: run.bytes, from: run.first * BUCKET_MS, to: (run.last + 1) * BUCKET_MS };
    }
  }
  return best;
}

export function bucketOf(t) {
  return Math.max(0, Math.floor(t / BUCKET_MS) - 1);
}

export function summarize(session) {
  const { meta, conns, ticks, bypasses, notes, end } = session;
  const durationMs = end?.t ?? Math.max(0, ...conns.map((c) => c.t1 ?? 0), ...ticks.map((t) => t.t));
  const repoBytes = meta.repo?.bytes || null;
  const threshold = burstThreshold(repoBytes);
  const hosts = new Map();

  const entry = (host) => {
    let h = hosts.get(host);
    if (!h) {
      const { kind, label } = classify(host);
      h = {
        host,
        kind,
        label,
        what: label ?? (kind ? KINDS[kind] : null),
        ports: new Set(),
        conns: 0,
        blocked: 0,
        errors: 0,
        errorCodes: new Set(),
        up: 0,
        down: 0,
        first: Infinity,
        last: 0,
        listed: null,
        viaSsh: false,
        series: new Map(),
      };
      hosts.set(host, h);
    }
    return h;
  };

  for (const c of conns) {
    const h = entry(c.host);
    h.ports.add(c.port);
    h.conns += 1;
    h.up += c.up || 0;
    h.down += c.down || 0;
    h.first = Math.min(h.first, c.t0 ?? 0);
    h.last = Math.max(h.last, c.t1 ?? 0);
    if (c.decision === 'block') h.blocked += 1;
    if (c.error) {
      h.errors += 1;
      h.errorCodes.add(c.error);
    }
    if (c.listed !== null && c.listed !== undefined) h.listed = c.listed;
    if (c.kind === 'ssh') h.viaSsh = true;
  }

  for (const tick of ticks) {
    const index = bucketOf(tick.t);
    for (const [host, [up, down]] of Object.entries(tick.d ?? {})) {
      const series = entry(host).series;
      const cell = series.get(index) ?? [0, 0];
      cell[0] += up;
      cell[1] += down;
      series.set(index, cell);
    }
  }

  const flags = [];
  for (const h of hosts.values()) {
    h.burst = longestBurst(new Map([...h.series].map(([i, [up]]) => [i, up])));
    if (h.burst.bytes >= threshold) {
      flags.push({
        level: h.kind === 'model' ? 'info' : 'high',
        code: 'burst',
        host: h.host,
        text:
          `sustained upload of ${formatBytes(h.burst.bytes)} over ${formatDuration(h.burst.to - h.burst.from)}` +
          (repoBytes ? ` (the repository is ${formatBytes(repoBytes)} packed)` : ''),
      });
    }
    if (h.listed === false && h.blocked < h.conns) {
      flags.push({ level: 'warn', code: 'unlisted', host: h.host, text: 'not on your allowlist' });
    }
    if (h.blocked) {
      flags.push({ level: 'info', code: 'blocked', host: h.host, text: `${h.blocked} connection(s) blocked` });
    }
    if (h.viaSsh && h.up > 0) {
      flags.push({ level: 'info', code: 'ssh', host: h.host, text: `git over SSH sent ${formatBytes(h.up)}` });
    }
    if (h.kind === 'telemetry' && h.up > 0) {
      flags.push({ level: 'info', code: 'telemetry', host: h.host, text: `telemetry / analytics (${h.label})` });
    }
  }

  const seenBypass = new Map();
  for (const b of bypasses) {
    const key = `${b.command}|${b.remote}|${b.proto}`;
    if (!seenBypass.has(key)) seenBypass.set(key, b);
  }
  for (const b of seenBypass.values()) {
    flags.push({
      level: 'high',
      code: 'bypass',
      host: b.remote,
      text: `${b.command} (pid ${b.pid}) opened a ${b.proto} connection that did not go through whatleft`,
    });
  }

  flags.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const list = [...hosts.values()].sort((a, b) => b.up - a.up || b.down - a.down || a.host.localeCompare(b.host));

  return {
    file: session.file,
    meta,
    end,
    durationMs,
    bucketMs: BUCKET_MS,
    buckets: Math.max(1, Math.ceil(durationMs / BUCKET_MS)),
    repoBytes,
    threshold,
    totals: {
      up: list.reduce((n, h) => n + h.up, 0),
      down: list.reduce((n, h) => n + h.down, 0),
      conns: conns.length,
      hosts: list.length,
      blocked: list.reduce((n, h) => n + h.blocked, 0),
    },
    hosts: list,
    flags,
    bypasses: [...seenBypass.values()],
    notes,
    conns,
  };
}

// Plain-JSON view of a summary (Sets and Maps flattened) for --json.
export function toJSON(summary) {
  return {
    ...summary,
    conns: undefined,
    hosts: summary.hosts.map((h) => ({
      ...h,
      ports: [...h.ports],
      errorCodes: [...h.errorCodes],
      first: Number.isFinite(h.first) ? h.first : null,
      series: [...h.series].sort((a, b) => a[0] - b[0]).map(([i, [up, down]]) => ({ t: i * BUCKET_MS, up, down })),
    })),
  };
}

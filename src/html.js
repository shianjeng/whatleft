import { formatBytes, formatDuration } from './format.js';
import { KINDS } from './hosts.js';
import { exitText } from './text.js';

const MAX_BARS = 72;
const MAX_LOG_ROWS = 1000;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function sparkline(host, buckets, peak) {
  const width = 160;
  const height = 26;
  const groups = Math.min(MAX_BARS, buckets);
  const per = buckets / groups;
  const values = new Array(groups).fill(0);
  for (const [index, [up]] of host.series) values[Math.min(groups - 1, Math.floor(index / per))] += up;
  const scale = Math.log1p(peak) || 1;
  const bar = width / groups;
  const rects = values
    .map((v, i) => {
      if (!v) return '';
      const h = Math.max(1.5, (Math.log1p(v) / scale) * height);
      return `<rect x="${(i * bar).toFixed(2)}" y="${(height - h).toFixed(2)}" width="${Math.max(1, bar - 0.6).toFixed(2)}" height="${h.toFixed(2)}"/>`;
    })
    .join('');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Upload over time">${rects}</svg>`;
}

function chip(h) {
  if (h.blocked && h.blocked === h.conns) return '<span class="chip blocked">Blocked</span>';
  if (!h.kind) return '<span class="chip">Unknown</span>';
  return `<span class="chip ${h.kind}" title="${esc(KINDS[h.kind])}">${esc(h.label ?? KINDS[h.kind])}</span>`;
}

export function renderHtml(summary) {
  const { meta, totals } = summary;
  const command = meta.command.join(' ');
  const started = new Date(meta.startedAt);
  const peak = Math.max(1, ...summary.hosts.flatMap((h) => [...h.series.values()].map(([up]) => up)));
  const perBucket = Math.max(1, summary.buckets / Math.min(MAX_BARS, summary.buckets));
  const groupedPeak = peak * Math.ceil(perBucket);

  const flags = summary.flags.length
    ? `<ul class="flags">${summary.flags
        .map((f) => `<li class="${f.level}"><span class="lvl">${f.level}</span><code>${esc(f.host)}</code> ${esc(f.text)}</li>`)
        .join('')}</ul>`
    : '<p class="ok">Nothing stood out: no large uploads, no connections around the proxy.</p>';

  const rows = summary.hosts
    .map((h) => {
      const hot = summary.flags.some((f) => f.host === h.host && f.level !== 'info');
      const errors = h.errors ? `<div class="sub">${h.errors} failed: ${esc([...h.errorCodes].join(', '))}</div>` : '';
      return `<tr class="${hot ? 'hot' : ''}">
  <td><code>${esc(h.host)}</code><div class="sub">port ${esc([...h.ports].join(', '))}${h.viaSsh ? ' · ssh' : ''}</div>${errors}</td>
  <td>${chip(h)}</td>
  <td class="num">${h.conns}</td>
  <td class="num strong">${formatBytes(h.up)}</td>
  <td class="num">${formatBytes(h.down)}</td>
  <td>${sparkline(h, summary.buckets, groupedPeak)}</td>
</tr>`;
    })
    .join('\n');

  const bypass = summary.bypasses.length
    ? `<section><h2>Connections that skipped the proxy</h2>
<p class="muted">Seen by polling the process tree with <code>lsof</code>. whatleft cannot count bytes for these.</p>
<table><thead><tr><th>Process</th><th>PID</th><th>Protocol</th><th>Remote</th><th class="num">Seen at</th></tr></thead><tbody>
${summary.bypasses
  .map((b) => `<tr><td><code>${esc(b.command)}</code></td><td>${esc(b.pid)}</td><td>${esc(b.proto)}</td><td><code>${esc(b.remote)}</code></td><td class="num">${formatDuration(b.t)}</td></tr>`)
  .join('\n')}
</tbody></table></section>`
    : '';

  const log = summary.conns
    .slice(-MAX_LOG_ROWS)
    .map(
      (c) => `<tr><td class="num">${formatDuration(c.t0)}</td><td>${esc(c.kind)}</td><td><code>${esc(c.host)}:${esc(c.port)}${c.path ? esc(c.path) : ''}</code></td><td class="num">${formatBytes(c.up)}</td><td class="num">${formatBytes(c.down)}</td><td class="num">${formatDuration((c.t1 ?? c.t0) - c.t0)}</td><td>${c.decision === 'block' ? 'blocked' : esc(c.error ?? c.status ?? 'ok')}</td></tr>`,
    )
    .join('\n');

  const notes = summary.notes.map((n) => `<li>${esc(n.text)}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whatleft · ${esc(meta.command[0])} · ${esc(started.toLocaleString())}</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1b1d21; --muted: #676b73; --line: #e3e3de;
  --accent: #2f6fdb; --bar: #2f6fdb; --high: #c8321e; --high-bg: #fdeeea; --warn: #9a6400; --warn-bg: #fdf4e1;
  --info: #676b73; --model: #e8f0fd; --telemetry: #fbe9f3; --registry: #eaf6ee; --code: #efeefe; --account: #eef3f3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131417; --panel: #1b1d21; --ink: #e8e8e6; --muted: #9a9ea6; --line: #2c2f35;
    --accent: #7aa7f5; --bar: #7aa7f5; --high: #ff7a66; --high-bg: #3a1d19; --warn: #e9b44c; --warn-bg: #3a2e15;
    --info: #9a9ea6; --model: #1d2a40; --telemetry: #3a1f30; --registry: #1b3324; --code: #27264a; --account: #22302f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 32px 0 12px; }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.muted, .sub { color: var(--muted); }
.sub { font-size: 12px; }
.meta { color: var(--muted); font-size: 13px; margin: 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 24px 0 8px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.stat b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
.flags { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.flags li { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
.flags li.high { background: var(--high-bg); border-color: transparent; }
.flags li.warn { background: var(--warn-bg); border-color: transparent; }
.lvl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin-right: 8px; color: var(--info); }
.high .lvl { color: var(--high); } .warn .lvl { color: var(--warn); }
.ok { color: var(--muted); }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.strong { font-weight: 600; }
tr.hot td:first-child { box-shadow: inset 3px 0 0 var(--high); }
.chip { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--line); white-space: nowrap; }
.chip.model { background: var(--model); } .chip.telemetry { background: var(--telemetry); }
.chip.registry { background: var(--registry); } .chip.code { background: var(--code); } .chip.account { background: var(--account); }
.chip.blocked { background: var(--high-bg); color: var(--high); }
.spark { width: 160px; height: 26px; display: block; fill: var(--bar); }
details { margin-top: 32px; }
summary { cursor: pointer; font-weight: 600; }
details table { font-size: 13px; }
footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>What left your machine</h1>
<p class="meta"><code>${esc(command)}</code> ${esc(exitText(summary.end))} after ${formatDuration(summary.durationMs)}</p>
<p class="meta">Started ${esc(started.toLocaleString())} in <code>${esc(meta.cwd)}</code>${
    summary.repoBytes ? ` · repository ${formatBytes(summary.repoBytes)} packed` : ''
  }${meta.upstream ? ` · via upstream proxy <code>${esc(meta.upstream)}</code>` : ''}${
    meta.enforce ? ' · allowlist enforced' : meta.allow?.length ? ' · allowlist in audit mode' : ''
  }</p>

<div class="stats">
  <div class="stat"><span>Sent</span><b>${formatBytes(totals.up)}</b></div>
  <div class="stat"><span>Received</span><b>${formatBytes(totals.down)}</b></div>
  <div class="stat"><span>Hosts</span><b>${totals.hosts}</b></div>
  <div class="stat"><span>Connections</span><b>${totals.conns}</b></div>
</div>

<h2>Findings</h2>
${flags}

<h2>Where it went</h2>
<div class="scroll"><table>
<thead><tr><th>Host</th><th>What</th><th class="num">Conns</th><th class="num">Sent</th><th class="num">Received</th><th>Upload over time</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6" class="muted">No network traffic went through whatleft.</td></tr>'}
</tbody></table></div>

${bypass}

<details>
<summary>Connection log (${summary.conns.length}${summary.conns.length > MAX_LOG_ROWS ? `, last ${MAX_LOG_ROWS} shown` : ''})</summary>
<div class="scroll"><table>
<thead><tr><th class="num">At</th><th>Kind</th><th>Destination</th><th class="num">Sent</th><th class="num">Received</th><th class="num">Open</th><th>Result</th></tr></thead>
<tbody>
${log}
</tbody></table></div>
</details>

<footer>
${notes ? `<ul>${notes}</ul>` : ''}
<p>whatleft sees destination hosts and byte counts. It does not decrypt TLS, so it cannot tell you what was inside a request.
Programs that ignore <code>HTTPS_PROXY</code> are only caught by the periodic bypass check, which can miss short connections.
Session log: <code>${esc(summary.file)}</code></p>
</footer>
</main>
</body>
</html>
`;
}

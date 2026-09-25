import { formatBytes, formatDuration, palette } from './format.js';
import { KINDS } from './hosts.js';

const MAX_ROWS = 12;

function fit(text, width) {
  const s = String(text);
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

export function exitText(end) {
  if (!end) return 'did not finish cleanly';
  if (end.signal) return `was stopped by ${end.signal}`;
  if (end.exitCode === null || end.exitCode === undefined) return 'finished';
  return `exited with ${end.exitCode}`;
}

export function renderText(summary, { color = false, reportPath = null } = {}) {
  const c = palette(color);
  const { meta, totals } = summary;
  const command = meta.command.join(' ');
  const lines = [];

  lines.push(
    `${c.bold('whatleft')} ${c.dim('▸')} ${c.bold(fit(command, 60))} ${exitText(summary.end)} after ${formatDuration(summary.durationMs)}`,
  );
  lines.push(
    c.dim(
      `  ${totals.hosts} host${totals.hosts === 1 ? '' : 's'} · ${totals.conns} connection${totals.conns === 1 ? '' : 's'}` +
        ` · ↑ ${formatBytes(totals.up)} sent · ↓ ${formatBytes(totals.down)} received`,
    ),
  );

  if (summary.hosts.length) {
    const hostWidth = Math.min(40, Math.max(4, ...summary.hosts.map((h) => h.host.length)));
    const whatWidth = 20;
    const header =
      `  ${'HOST'.padEnd(hostWidth)}  ${'WHAT'.padEnd(whatWidth)}  ${'CONNS'.padStart(5)}  ` +
      `${'SENT'.padStart(9)}  ${'RECEIVED'.padStart(9)}`;
    lines.push('', c.dim(header));
    const flagged = new Set(summary.flags.filter((f) => f.level !== 'info').map((f) => f.host));
    for (const h of summary.hosts.slice(0, MAX_ROWS)) {
      const what = h.blocked === h.conns ? 'blocked' : h.what ?? (h.kind ? KINDS[h.kind] : '—');
      const row =
        `${fit(h.host, hostWidth).padEnd(hostWidth)}  ${fit(what, whatWidth).padEnd(whatWidth)}  ` +
        `${String(h.conns).padStart(5)}  ${formatBytes(h.up).padStart(9)}  ${formatBytes(h.down).padStart(9)}`;
      if (flagged.has(h.host)) lines.push(`${c.red('!')} ${c.red(row)}`);
      else if (h.blocked === h.conns) lines.push(`  ${c.dim(row)}`);
      else lines.push(`  ${row}`);
    }
    if (summary.hosts.length > MAX_ROWS) {
      lines.push(c.dim(`  … and ${summary.hosts.length - MAX_ROWS} more hosts in the report`));
    }
  } else {
    lines.push('', '  No network traffic went through whatleft.');
  }

  if (summary.flags.length) {
    lines.push('');
    for (const flag of summary.flags) {
      const mark = flag.level === 'high' ? c.red('!') : flag.level === 'warn' ? c.yellow('?') : c.dim('·');
      const text = `${flag.host}: ${flag.text}`;
      lines.push(`  ${mark} ${flag.level === 'info' ? c.dim(text) : text}`);
    }
  }

  for (const note of summary.notes) lines.push(c.dim(`  note: ${note.text}`));
  if (reportPath) lines.push('', `  Report: ${c.cyan(reportPath)}`);
  return `${lines.join('\n')}\n`;
}

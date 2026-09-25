import fs from 'node:fs';
import path from 'node:path';

export const BUCKET_MS = 5000;

export function sessionId(command, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const name =
    path
      .basename(String(command?.[0] ?? ''))
      .replace(/\.(cmd|exe|bat|js|mjs|cjs)$/i, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .slice(0, 32) || 'session';
  return `${stamp}-${name}`;
}

// Appends one JSON record per line. Synchronous writes keep the log intact
// if the process dies; the volume is a few lines per second at most.
export class Recorder {
  #pending = new Map();
  #timer;

  constructor({ dir, meta }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.startedAt = Date.now();
    let id = sessionId(meta.command, new Date(this.startedAt));
    for (let n = 2; fs.existsSync(path.join(dir, `${id}.jsonl`)); n++) id = `${id.replace(/~\d+$/, '')}~${n}`;
    this.id = id;
    this.file = path.join(dir, `${id}.jsonl`);
    this.#write({ type: 'session', v: 1, id, startedAt: new Date(this.startedAt).toISOString(), ...meta });
    this.#timer = setInterval(() => this.flush(), BUCKET_MS);
    this.#timer.unref();
  }

  get elapsed() {
    return Date.now() - this.startedAt;
  }

  onData = (conn, direction, bytes) => {
    let entry = this.#pending.get(conn.host);
    if (!entry) this.#pending.set(conn.host, (entry = [0, 0]));
    entry[direction === 'up' ? 0 : 1] += bytes;
  };

  onClose = (conn) => {
    this.#write({
      type: 'conn',
      id: conn.id,
      kind: conn.kind,
      method: conn.method,
      host: conn.host,
      port: conn.port,
      path: conn.path,
      t0: conn.start - this.startedAt,
      t1: (conn.end ?? Date.now()) - this.startedAt,
      up: conn.up,
      down: conn.down,
      decision: conn.decision,
      listed: conn.listed,
      rule: conn.rule ?? undefined,
      status: conn.status,
      error: conn.error,
    });
  };

  bypass(event) {
    this.#write({ type: 'bypass', t: this.elapsed, ...event });
  }

  note(text) {
    this.#write({ type: 'note', t: this.elapsed, text });
  }

  flush() {
    if (!this.#pending.size) return;
    this.#write({ type: 'bytes', t: this.elapsed, d: Object.fromEntries(this.#pending) });
    this.#pending.clear();
  }

  close({ exitCode = null, signal = null } = {}) {
    this.flush();
    clearInterval(this.#timer);
    this.#write({ type: 'end', t: this.elapsed, endedAt: new Date().toISOString(), exitCode, signal });
  }

  #write(record) {
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}

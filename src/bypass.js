import { execFile } from 'node:child_process';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (err, stdout) => {
      // lsof exits 1 when it finds nothing to list; that is not a failure.
      if (err && !(err.code === 1 && typeof stdout === 'string')) reject(err);
      else resolve(stdout);
    });
  });
}

export async function descendants(rootPid) {
  const children = new Map();
  for (const line of (await run('ps', ['-A', '-o', 'pid=,ppid='])).split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    if (out.includes(pid)) continue;
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

// Parses `lsof -F pcPnT` output into connected sockets.
export function parseLsof(output) {
  const sockets = [];
  let pid = null;
  let command = null;
  let current = null;
  for (const line of output.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      current = null;
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'f') {
      current = { pid, command, proto: null, name: null, state: null };
      sockets.push(current);
    } else if (current && tag === 'P') {
      current.proto = value;
    } else if (current && tag === 'n') {
      current.name = value;
    } else if (current && tag === 'T' && value.startsWith('ST=')) {
      current.state = value.slice(3);
    }
  }
  return sockets
    .filter((s) => s.name?.includes('->'))
    .map((s) => ({ pid: s.pid, command: s.command, proto: s.proto ?? 'TCP', state: s.state, remote: s.name.split('->')[1] }));
}

export function isLoopback(remote) {
  const host = remote.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return /^127\./.test(host) || host === '::1' || host === 'localhost' || /^::ffff:127\./.test(host);
}

// Best effort: every few seconds, list the sockets of the child process tree
// and report connections that do not point at the proxy. Short-lived
// connections between two polls are missed.
export function startBypassMonitor({ rootPid, intervalMs = 2000, onFind, onUnavailable }) {
  if (process.platform === 'win32') {
    onUnavailable?.('bypass check is not available on Windows');
    return { stop() {} };
  }
  const seen = new Set();
  let busy = false;
  let stopped = false;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const pids = await descendants(rootPid);
      const output = await run('lsof', ['-nP', '-a', '-p', pids.join(','), '-i', '-F', 'pcPnT']);
      for (const socket of parseLsof(output)) {
        if (isLoopback(socket.remote)) continue;
        const key = `${socket.pid}|${socket.proto}|${socket.remote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        onFind(socket);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        stopped = true;
        clearInterval(timer);
        onUnavailable?.('bypass check skipped: lsof is not installed');
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 300).unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

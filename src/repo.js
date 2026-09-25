import { execFileSync } from 'node:child_process';

// The packed size of the git repository around `cwd`, used as the yardstick
// for "this upload is about as big as the repo".
export function detectRepo(cwd) {
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 };
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], options).trim();
    const stats = {};
    for (const line of execFileSync('git', ['count-objects', '-v'], options).split('\n')) {
      const [key, value] = line.split(':');
      if (value !== undefined) stats[key.trim()] = Number(value);
    }
    const kib = (stats['size-pack'] || 0) + (stats.size || 0);
    return { root, bytes: kib * 1024 };
  } catch {
    return null;
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatBytes, formatDuration, useColor } from './format.js';
import { loadSession, summarize, toJSON } from './report.js';
import { runWatched, writeReport } from './run.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `whatleft ${VERSION} — see what your coding agent sends off your machine

Usage
  whatleft [options] [--] <command> [args...]   run a command and record its traffic
  whatleft report [session] [--open] [--json]  show a session (default: the latest)
  whatleft ls                                   list recorded sessions

Options
  --allow <hosts>      allowlist, comma separated; "*.example.com" covers subdomains
  --enforce            block hosts that are not on the allowlist (default: only report them)
  --upstream <url>     chain to this HTTP proxy (default: your HTTPS_PROXY); "none" to go direct
  --no-proxy <hosts>   hosts the command reaches without whatleft (default: localhost)
  --config <file>      JSON config (default: ~/.whatleft/config.json)
  --no-ssh             leave git-over-SSH alone instead of routing it through whatleft
  --no-bypass-check    do not poll for connections that skip the proxy
  --open               open the HTML report when the command exits
  --quiet              print the summary only when something needs attention
  -h, --help           show this help
  -v, --version        print the version

Examples
  whatleft claude
  whatleft --allow api.anthropic.com,*.github.com --enforce -- codex
  whatleft report --open
`;

class UsageError extends Error {}

function home() {
  return process.env.WHATLEFT_HOME || path.join(os.homedir(), '.whatleft');
}

function sessionsDir() {
  return path.join(home(), 'sessions');
}

function loadConfig(file) {
  const target = file ?? path.join(home(), 'config.json');
  if (!fs.existsSync(target)) {
    if (file) throw new UsageError(`config file not found: ${file}`);
    return {};
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read ${target}: ${err.message}`);
  }
  const known = new Set(['allow', 'enforce', 'upstream', 'noProxy', 'ssh', 'bypassCheck']);
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new UsageError(`unknown key "${key}" in ${target}`);
  }
  return config;
}

export function parseRunArgs(argv) {
  const options = { allow: [] };
  const needsValue = new Set(['--allow', '--upstream', '--no-proxy', '--config']);
  let i = 0;
  for (; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--') {
      i += 1;
      break;
    }
    if (!arg.startsWith('-')) break;
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (needsValue.has(arg) && value === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      value = argv[++i];
    }
    switch (arg) {
      case '--allow':
        options.allow.push(value);
        break;
      case '--upstream':
        options.upstream = value;
        break;
      case '--no-proxy':
        options.noProxy = value;
        break;
      case '--config':
        options.config = value;
        break;
      case '--enforce':
        options.enforce = true;
        break;
      case '--no-ssh':
        options.ssh = false;
        break;
      case '--no-bypass-check':
        options.bypassCheck = false;
        break;
      case '--open':
        options.open = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      default:
        throw new UsageError(`unknown option ${arg}`);
    }
  }
  return { options, command: argv.slice(i) };
}

function listSessions() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(dir, name));
}

function resolveSession(target) {
  if (target && target !== 'latest') {
    if (fs.existsSync(target)) return target;
    const byId = path.join(sessionsDir(), target.endsWith('.jsonl') ? target : `${target}.jsonl`);
    if (fs.existsSync(byId)) return byId;
    throw new UsageError(`no session "${target}" (see "whatleft ls")`);
  }
  const latest = listSessions().at(-1);
  if (!latest) throw new UsageError('no sessions recorded yet');
  return latest;
}

function reportCommand(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  for (const flag of flags) if (!['--open', '--json'].includes(flag)) throw new UsageError(`unknown option ${flag}`);
  const file = resolveSession(argv.find((a) => !a.startsWith('--')));
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(toJSON(summarize(loadSession(file))), null, 2)}\n`);
    return 0;
  }
  const { text } = writeReport(file, { color: useColor(process.stdout), open: flags.has('--open') });
  process.stdout.write(text);
  return 0;
}

function listCommand() {
  const files = listSessions().slice(-30).reverse();
  if (!files.length) {
    process.stdout.write('No sessions recorded yet.\n');
    return 0;
  }
  process.stdout.write(`${'SESSION'.padEnd(30)}  ${'DURATION'.padStart(8)}  ${'HOSTS'.padStart(5)}  ${'SENT'.padStart(9)}  FLAGS  COMMAND\n`);
  for (const file of files) {
    try {
      const s = summarize(loadSession(file));
      const high = s.flags.filter((f) => f.level === 'high').length;
      process.stdout.write(
        `${path.basename(file, '.jsonl').padEnd(30)}  ${formatDuration(s.durationMs).padStart(8)}  ` +
          `${String(s.totals.hosts).padStart(5)}  ${formatBytes(s.totals.up).padStart(9)}  ` +
          `${String(high || '').padStart(5)}  ${s.meta.command.join(' ').slice(0, 50)}\n`,
      );
    } catch {
      process.stdout.write(`${path.basename(file, '.jsonl').padEnd(30)}  (unreadable)\n`);
    }
  }
  return 0;
}

export async function main(argv) {
  try {
    const [first] = argv;
    if (!first) {
      process.stderr.write(HELP);
      return 2;
    }
    if (first === '-h' || first === '--help' || first === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    if (first === '-v' || first === '--version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (first === 'report') return reportCommand(argv.slice(1));
    if (first === 'ls') return listCommand();

    const { options, command } = parseRunArgs(argv);
    if (!command.length) throw new UsageError('no command given, e.g. "whatleft claude"');
    const config = loadConfig(options.config);
    return await runWatched(command, {
      version: VERSION,
      sessionsDir: sessionsDir(),
      allow: [config.allow ?? [], options.allow],
      enforce: options.enforce ?? config.enforce ?? false,
      upstream: options.upstream ?? config.upstream,
      noProxy: options.noProxy ?? config.noProxy,
      ssh: options.ssh ?? config.ssh ?? true,
      bypassCheck: options.bypassCheck ?? config.bypassCheck ?? true,
      open: options.open ?? false,
      quiet: options.quiet ?? false,
    });
  } catch (err) {
    process.stderr.write(`whatleft: ${err.message}\n`);
    if (err instanceof UsageError) process.stderr.write('Run "whatleft --help" for usage.\n');
    return 2;
  }
}

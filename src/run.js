import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { startBypassMonitor } from './bypass.js';
import { useColor } from './format.js';
import { renderHtml } from './html.js';
import { makePolicy, noProxyMatcher } from './policy.js';
import { Proxy } from './proxy.js';
import { detectRepo } from './repo.js';
import { loadSession, summarize } from './report.js';
import { Recorder } from './session.js';
import { gitSshCommand } from './ssh.js';
import { renderText } from './text.js';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

export function parseUpstream(value) {
  if (!value || value === 'none') return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    throw new Error(`cannot parse upstream proxy "${value}"`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(
      `your upstream proxy is ${url.protocol}//${url.host}, and whatleft can only chain to an http:// proxy.\n` +
        `  Pass --upstream http://host:port (Clash, V2Ray and most local proxies also expose an HTTP port),\n` +
        `  or --upstream none to connect directly.`,
    );
  }
  const auth = url.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
    : null;
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || 80,
    auth,
    display: `http://${url.host}`,
  };
}

export function upstreamFromEnv(env) {
  for (const name of PROXY_VARS) if (env[name]) return env[name];
  return null;
}

export function childEnv(base, { proxyUrl, noProxy, sshCommand }) {
  const env = { ...base };
  for (const name of PROXY_VARS) env[name] = proxyUrl;
  env.YARN_HTTP_PROXY = proxyUrl;
  env.YARN_HTTPS_PROXY = proxyUrl;
  env.NO_PROXY = env.no_proxy = noProxy;
  // Node's built-in fetch and http ignore HTTP(S)_PROXY unless asked (Node 22.21+/24.5+).
  env.NODE_USE_ENV_PROXY = '1';
  env.WHATLEFT_PROXY = proxyUrl;
  if (sshCommand && !base.GIT_SSH_COMMAND && !base.GIT_SSH) env.GIT_SSH_COMMAND = sshCommand;
  return env;
}

function say(text) {
  try {
    process.stderr.write(text);
  } catch {}
}

export function openFile(file) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', file]]
        : ['xdg-open', [file]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

export function writeReport(file, { color, open = false } = {}) {
  const summary = summarize(loadSession(file));
  const htmlPath = file.replace(/\.jsonl$/, '') + '.html';
  fs.writeFileSync(htmlPath, renderHtml(summary), { mode: 0o600 });
  if (open) openFile(htmlPath);
  return { summary, htmlPath, text: renderText(summary, { color, reportPath: htmlPath }) };
}

export async function runWatched(command, options) {
  const upstreamValue = options.upstream ?? upstreamFromEnv(process.env);
  const upstream = parseUpstream(upstreamValue);
  const policy = makePolicy({ allow: options.allow, enforce: options.enforce });
  if (policy.enforce && !policy.allow.length) {
    throw new Error('--enforce needs an allowlist (use --allow or "allow" in the config file)');
  }

  const repo = detectRepo(process.cwd());
  const recorder = new Recorder({
    dir: options.sessionsDir,
    meta: {
      command,
      cwd: process.cwd(),
      repo,
      allow: policy.allow,
      enforce: policy.enforce,
      upstream: upstream?.display ?? null,
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      whatleft: options.version,
    },
  });

  const originalNoProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const proxy = new Proxy({
    decide: (host) => policy.decide(host),
    upstream,
    bypassUpstream: noProxyMatcher(originalNoProxy),
    onData: recorder.onData,
    onClose: recorder.onClose,
  });
  const port = await proxy.listen();
  const proxyUrl = `http://127.0.0.1:${port}`;
  const sshCommand = options.ssh && process.platform !== 'win32' ? gitSshCommand(port) : null;
  const env = childEnv(process.env, {
    proxyUrl,
    noProxy: options.noProxy ?? 'localhost,127.0.0.1,::1',
    sshCommand,
  });

  if (!options.quiet) {
    const mode = policy.enforce ? `enforcing ${policy.allow.length} allow rule(s)` : 'recording';
    say(`whatleft ▸ ${mode} · proxy ${proxyUrl}${upstream ? ` → ${upstream.display}` : ''}\n`);
  }

  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });

  // Ctrl-C reaches the child through the terminal; stay alive to write the report.
  const ignore = () => {};
  const forward = (signal) => () => child.kill(signal);
  const handlers = { SIGINT: ignore, SIGQUIT: ignore, SIGTERM: forward('SIGTERM'), SIGHUP: forward('SIGHUP') };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);

  const monitor = options.bypassCheck
    ? startBypassMonitor({
        rootPid: child.pid,
        onFind: (socket) => recorder.bypass(socket),
        onUnavailable: (text) => recorder.note(text),
      })
    : null;
  if (!options.bypassCheck) recorder.note('bypass check was turned off');

  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  if (monitor) await monitor.tick?.();
  monitor?.stop();
  await proxy.close();
  recorder.close({ exitCode: outcome.code ?? null, signal: outcome.signal ?? null });
  for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);

  if (outcome.error) {
    say(`whatleft: could not start "${command[0]}": ${outcome.error.code === 'ENOENT' ? 'command not found' : outcome.error.message}\n`);
  }

  const report = writeReport(recorder.file, { color: useColor(process.stderr), open: options.open });
  if (!options.quiet || report.summary.flags.some((f) => f.level === 'high')) say(`\n${report.text}`);

  if (outcome.error) return outcome.error.code === 'ENOENT' ? 127 : 126;
  if (outcome.signal) return 128 + (os.constants.signals[outcome.signal] ?? 0);
  return outcome.code ?? 0;
}

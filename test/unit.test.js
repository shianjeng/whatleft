import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLsof, isLoopback } from '../src/bypass.js';
import { formatBytes, formatDuration } from '../src/format.js';
import { classify } from '../src/hosts.js';
import { makePolicy, matchPattern, noProxyMatcher, normalizePatterns } from '../src/policy.js';
import { parseAuthority } from '../src/proxy.js';
import { BURST_FLOOR, longestBurst, SUSTAINED_BUCKET, summarize } from '../src/report.js';
import { childEnv, parseUpstream } from '../src/run.js';
import { parseRunArgs } from '../src/cli.js';
import { shellQuote } from '../src/ssh.js';

test('host patterns', () => {
  assert.ok(matchPattern('api.github.com', '*.github.com'));
  assert.ok(matchPattern('github.com', '*.github.com'));
  assert.ok(!matchPattern('evilgithub.com', '*.github.com'));
  assert.ok(matchPattern('bedrock-runtime.us-east-1.amazonaws.com', 'bedrock-runtime.*.amazonaws.com'));
  assert.ok(!matchPattern('bedrock-runtime.a.b.amazonaws.com', 'bedrock-runtime.*.amazonaws.com'));
  assert.ok(matchPattern('anything.example', '*'));
  assert.ok(!matchPattern('api.anthropic.com.evil.net', 'api.anthropic.com'));
});

test('allowlist normalization accepts pasted URLs and ports', () => {
  assert.deepEqual(normalizePatterns(['https://API.anthropic.com/v1', 'a.com:443, b.com', ['[::1]:8080']]), [
    'api.anthropic.com',
    'a.com',
    'b.com',
    '::1',
  ]);
});

test('policy decisions', () => {
  const audit = makePolicy({ allow: ['*.github.com'] });
  assert.deepEqual(audit.decide('evil.net'), { decision: 'allow', listed: false, rule: null });
  const enforce = makePolicy({ allow: ['*.github.com'], enforce: true });
  assert.equal(enforce.decide('evil.net').decision, 'block');
  assert.equal(enforce.decide('API.GitHub.com.').decision, 'allow');
  assert.equal(makePolicy().decide('x.com').listed, null);
});

test('NO_PROXY matching', () => {
  const match = noProxyMatcher('localhost, .corp.example,internal:8080');
  assert.ok(match('localhost'));
  assert.ok(match('git.corp.example'));
  assert.ok(match('internal'));
  assert.ok(!match('example.com'));
  assert.ok(noProxyMatcher('*')('anything'));
  assert.ok(!noProxyMatcher('')('anything'));
});

test('CONNECT authority parsing', () => {
  assert.deepEqual(parseAuthority('Example.COM:443'), { host: 'example.com', port: 443 });
  assert.deepEqual(parseAuthority('[2001:db8::1]:8443'), { host: '2001:db8::1', port: 8443 });
  assert.deepEqual(parseAuthority('10.0.0.1:22'), { host: '10.0.0.1', port: 22 });
  for (const bad of ['example.com', 'example.com:0', 'example.com:99999', 'a b.com:443', '::1:443', ':443', 'x.com:4a']) {
    assert.equal(parseAuthority(bad), null, bad);
  }
});

test('known hosts', () => {
  assert.equal(classify('api.anthropic.com').kind, 'model');
  assert.equal(classify('statsig.anthropic.com').kind, 'telemetry');
  assert.equal(classify('o123.ingest.sentry.io').kind, 'telemetry');
  assert.equal(classify('objects.githubusercontent.com').kind, 'code');
  assert.equal(classify('unknown.example').kind, null);
});

test('formatting', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');
  assert.equal(formatDuration(8_000), '8s');
  assert.equal(formatDuration(724_000), '12m04s');
  assert.equal(formatDuration(3_725_000), '1h02m');
});

test('bursts need consecutive sustained buckets', () => {
  const big = SUSTAINED_BUCKET * 4;
  const uploads = new Map([
    [0, big],
    [1, big],
    [2, 10],
    [3, big],
    [4, big],
    [5, big],
  ]);
  assert.deepEqual(longestBurst(uploads), { bytes: big * 3, from: 15_000, to: 30_000 });
  assert.equal(longestBurst(new Map([[0, SUSTAINED_BUCKET - 1]])).bytes, 0);
});

function fakeSession({ host = 'paste.example', perTick = 4 * 1024 * 1024, ticks = 6, repoBytes = 10 * 1024 * 1024 } = {}) {
  return {
    file: '/tmp/x.jsonl',
    meta: { command: ['claude'], cwd: '/repo', startedAt: new Date().toISOString(), repo: { root: '/repo', bytes: repoBytes }, allow: [] },
    conns: [{ type: 'conn', kind: 'tunnel', host, port: 443, t0: 0, t1: ticks * 5000, up: perTick * ticks, down: 100, decision: 'allow', listed: null }],
    ticks: Array.from({ length: ticks }, (_, i) => ({ t: (i + 1) * 5000 + 3, d: { [host]: [perTick, 10] } })),
    bypasses: [],
    notes: [],
    end: { t: ticks * 5000 + 100, exitCode: 0 },
  };
}

test('a repo-sized upload to an unknown host is flagged high', () => {
  const summary = summarize(fakeSession());
  const flag = summary.flags.find((f) => f.code === 'burst');
  assert.equal(flag.level, 'high');
  assert.equal(flag.host, 'paste.example');
  assert.match(flag.text, /24\.0 MB/);
});

test('the same upload to a model API is informational', () => {
  const summary = summarize(fakeSession({ host: 'api.anthropic.com' }));
  assert.equal(summary.flags.find((f) => f.code === 'burst').level, 'info');
});

test('small uploads stay under the floor', () => {
  const summary = summarize(fakeSession({ perTick: 300 * 1024, repoBytes: 100 }));
  assert.ok(300 * 1024 * 6 < BURST_FLOOR);
  assert.equal(summary.flags.filter((f) => f.code === 'burst').length, 0);
});

test('lsof field output', () => {
  const output = [
    'p4242',
    'cpython3',
    'f5',
    'PTCP',
    'n192.168.1.2:50000->93.184.216.34:443',
    'TST=ESTABLISHED',
    'f6',
    'PTCP',
    'n127.0.0.1:50001->127.0.0.1:53000',
    'f7',
    'PTCP',
    'n*:8080',
    'TST=LISTEN',
    'p4243',
    'cnode',
    'f9',
    'PUDP',
    'n[fe80::1]:5353->[2001:db8::1]:443',
    '',
  ].join('\n');
  const sockets = parseLsof(output);
  assert.deepEqual(
    sockets.map((s) => [s.pid, s.command, s.proto, s.remote]),
    [
      [4242, 'python3', 'TCP', '93.184.216.34:443'],
      [4242, 'python3', 'TCP', '127.0.0.1:53000'],
      [4243, 'node', 'UDP', '[2001:db8::1]:443'],
    ],
  );
  assert.ok(isLoopback('127.0.0.1:53000'));
  assert.ok(isLoopback('[::1]:443'));
  assert.ok(!isLoopback('93.184.216.34:443'));
});

test('upstream proxy parsing', () => {
  assert.equal(parseUpstream(null), null);
  assert.equal(parseUpstream('none'), null);
  const p = parseUpstream('http://user:p%40ss@127.0.0.1:7890');
  assert.equal(p.port, 7890);
  assert.equal(p.display, 'http://127.0.0.1:7890');
  assert.equal(Buffer.from(p.auth.split(' ')[1], 'base64').toString(), 'user:p@ss');
  assert.equal(parseUpstream('proxy.corp:3128').hostname, 'proxy.corp');
  assert.throws(() => parseUpstream('socks5://127.0.0.1:7891'), /only chain to an http/);
});

test('child environment', () => {
  const env = childEnv({ HTTPS_PROXY: 'http://corp:3128', GIT_SSH_COMMAND: 'ssh -i key', PATH: '/bin' }, {
    proxyUrl: 'http://127.0.0.1:9',
    noProxy: 'localhost',
    sshCommand: 'ssh -o x',
  });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:9');
  assert.equal(env.http_proxy, 'http://127.0.0.1:9');
  assert.equal(env.NO_PROXY, 'localhost');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i key', 'a user-set GIT_SSH_COMMAND is left alone');
  assert.equal(env.PATH, '/bin');
});

test('run arguments stop at the command', () => {
  assert.deepEqual(parseRunArgs(['--allow', 'a.com', '--enforce', 'claude', '--resume']), {
    options: { allow: ['a.com'], enforce: true },
    command: ['claude', '--resume'],
  });
  assert.deepEqual(parseRunArgs(['--allow=a.com', '--', '--weird-command']).command, ['--weird-command']);
  assert.throws(() => parseRunArgs(['--nope', 'x']), /unknown option/);
  assert.throws(() => parseRunArgs(['--allow']), /needs a value/);
});

test('shell quoting', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

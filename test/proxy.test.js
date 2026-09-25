import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dial } from '../src/connect.js';
import { makePolicy } from '../src/policy.js';
import { Proxy } from '../src/proxy.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function echoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  return { server, port: await listen(server) };
}

async function startProxy(options = {}) {
  const closed = [];
  const proxy = new Proxy({
    decide: (host) => makePolicy(options.policy).decide(host),
    upstream: options.upstream ?? null,
    onClose: (conn) => closed.push({ ...conn }),
  });
  const port = await proxy.listen();
  return { proxy, port, closed };
}

function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() > deadline) reject(new Error('timed out'));
      else setTimeout(check, 10);
    };
    check();
  });
}

async function roundTrip(socket, payload) {
  socket.resume();
  const received = [];
  socket.on('data', (chunk) => received.push(chunk));
  socket.write(payload);
  await waitFor(() => Buffer.concat(received).length >= payload.length);
  socket.end();
  return Buffer.concat(received);
}

test('CONNECT tunnels count bytes both ways', async (t) => {
  const echo = await echoServer();
  const { proxy, port, closed } = await startProxy();
  t.after(() => {
    echo.server.close();
    return proxy.close();
  });

  const socket = await dial({ host: '127.0.0.1', port: echo.port, proxy: { hostname: '127.0.0.1', port } });
  const payload = Buffer.alloc(100_000, 7);
  assert.deepEqual(await roundTrip(socket, payload), payload);
  await waitFor(() => closed.length === 1);
  assert.equal(closed[0].kind, 'tunnel');
  assert.equal(closed[0].host, '127.0.0.1');
  assert.equal(closed[0].up, 100_000);
  assert.equal(closed[0].down, 100_000);
});

test('enforced allowlists refuse the tunnel', async (t) => {
  const echo = await echoServer();
  const { proxy, port, closed } = await startProxy({ policy: { allow: ['allowed.test'], enforce: true } });
  t.after(() => {
    echo.server.close();
    return proxy.close();
  });

  await assert.rejects(
    dial({ host: '127.0.0.1', port: echo.port, proxy: { hostname: '127.0.0.1', port } }),
    (err) => err.code === 'EBLOCKED',
  );
  await waitFor(() => closed.length === 1);
  assert.equal(closed[0].decision, 'block');
  assert.equal(closed[0].up, 0);
});

test('unreachable targets are recorded with an error', async (t) => {
  const { proxy, port, closed } = await startProxy();
  t.after(() => proxy.close());
  const unused = net.createServer();
  const deadPort = await listen(unused);
  await new Promise((r) => unused.close(r));

  await assert.rejects(dial({ host: '127.0.0.1', port: deadPort, proxy: { hostname: '127.0.0.1', port } }));
  await waitFor(() => closed.length === 1);
  assert.equal(closed[0].error, 'ECONNREFUSED');
});

test('plain http requests are forwarded and counted', async (t) => {
  const origin = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => res.end(`got ${req.method} ${req.url} ${body.length}`));
  });
  const originPort = await listen(origin);
  const { proxy, port, closed } = await startProxy();
  t.after(() => {
    origin.close();
    return proxy.close();
  });

  const text = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `http://127.0.0.1:${originPort}/upload?token=secret`,
      headers: { host: `127.0.0.1:${originPort}` },
    });
    req.on('response', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end('x'.repeat(5000));
  });
  assert.equal(text, 'got POST /upload?token=secret 5000');
  await waitFor(() => closed.length === 1);
  assert.equal(closed[0].kind, 'http');
  assert.equal(closed[0].path, '/upload', 'query strings are not recorded');
  assert.equal(closed[0].status, 200);
  assert.ok(closed[0].up > 5000);
});

test('tunnels chain through an upstream proxy', async (t) => {
  const echo = await echoServer();
  const outer = await startProxy();
  const inner = await startProxy({ upstream: { hostname: '127.0.0.1', port: outer.port, auth: null } });
  t.after(async () => {
    echo.server.close();
    await inner.proxy.close();
    await outer.proxy.close();
  });

  const socket = await dial({ host: '127.0.0.1', port: echo.port, proxy: { hostname: '127.0.0.1', port: inner.port } });
  const payload = Buffer.from('through two proxies');
  assert.deepEqual(await roundTrip(socket, payload), payload);
  await waitFor(() => inner.closed.length === 1 && outer.closed.length === 1);
  assert.equal(outer.closed[0].up, payload.length);
});

test('the ssh helper tunnels stdin/stdout through the proxy', async (t) => {
  const echo = await echoServer();
  const { proxy, port, closed } = await startProxy();
  t.after(() => {
    echo.server.close();
    return proxy.close();
  });

  const output = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(ROOT, 'src/ssh-connect.js'), '127.0.0.1', String(port), '127.0.0.1', String(echo.port)], (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    child.stdin.end('SSH-2.0-test\r\n');
  });
  assert.equal(output, 'SSH-2.0-test\r\n');
  await waitFor(() => closed.length === 1);
  assert.equal(closed[0].kind, 'ssh');
});

test('end to end: a child process fetch shows up in the session', async (t) => {
  const origin = http.createServer((req, res) => res.end('hello'));
  const originPort = await listen(origin);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whatleft-test-'));
  t.after(() => {
    origin.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Speaks to HTTP_PROXY over a raw socket, so it behaves the same on every Node
  // version whether or not NODE_USE_ENV_PROXY is understood.
  const script =
    `const u = new URL(process.env.HTTP_PROXY);` +
    `const s = require('net').connect(u.port, u.hostname, () => s.write('GET http://127.0.0.1:${originPort}/ping HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n'));` +
    `let b = ''; s.on('data', (c) => (b += c)); s.on('end', () => process.stdout.write(b.split('\\r\\n\\r\\n')[1]));`;
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'bin/whatleft.js'), '--no-proxy', '', '--no-bypass-check', '--', process.execPath, '-e', script],
      { env: { ...process.env, WHATLEFT_HOME: home, NO_COLOR: '1' } },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })),
    );
  });
  assert.equal(stdout, 'hello');
  assert.match(stderr, /127\.0\.0\.1/);
  const files = fs.readdirSync(path.join(home, 'sessions'));
  assert.ok(files.some((f) => f.endsWith('.jsonl')));
  assert.ok(files.some((f) => f.endsWith('.html')));
  const records = fs
    .readFileSync(path.join(home, 'sessions', files.find((f) => f.endsWith('.jsonl'))), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const conn = records.find((r) => r.type === 'conn');
  assert.equal(conn.host, '127.0.0.1');
  assert.equal(conn.path, '/ping');
  assert.ok(conn.up > 0 && conn.down > 0);
  assert.equal(records.at(-1).type, 'end');
  assert.equal(records.at(-1).exitCode, 0);
});

test('the child exit code is passed through', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whatleft-test-'));
  const code = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'bin/whatleft.js'), '--quiet', '--no-bypass-check', process.execPath, '-e', 'process.exit(7)'],
      { env: { ...process.env, WHATLEFT_HOME: home } },
      (err) => resolve(err?.code ?? 0),
    );
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(code, 7);
});

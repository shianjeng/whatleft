import http from 'node:http';
import net from 'node:net';
import { describeError, dial, formatAuthority } from './connect.js';
import { normalizeHost } from './policy.js';

const HOSTNAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

export function parseAuthority(value) {
  if (typeof value !== 'string') return null;
  let host;
  let port;
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (v6) {
    [, host, port] = v6;
  } else {
    const colon = value.lastIndexOf(':');
    if (colon <= 0) return null;
    host = value.slice(0, colon);
    port = value.slice(colon + 1);
    if (host.includes(':')) return null;
  }
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  host = normalizeHost(host);
  if (!net.isIP(host) && !HOSTNAME.test(host)) return null;
  return { host, port };
}

function blockedText(host) {
  return `whatleft blocked ${host}: it is not on the allowlist.\n`;
}

function headBytes(first, headers) {
  let total = first.length + 4;
  for (const [name, value] of Object.entries(headers)) total += name.length + String(value).length + 4;
  return total;
}

// A forward proxy that understands CONNECT tunnels and absolute-form http://
// requests. It never decrypts anything: it learns the destination host and
// counts the bytes that flow each way.
export class Proxy {
  #server;
  #live = new Set();
  #nextId = 1;

  constructor({ decide, upstream = null, bypassUpstream = () => false, onData = () => {}, onClose = () => {} }) {
    this.decide = decide;
    this.upstream = upstream;
    this.bypassUpstream = bypassUpstream;
    this.onData = onData;
    this.onClose = onClose;
    this.#server = http.createServer();
    this.#server.on('connect', (req, socket, head) => this.#onConnect(req, socket, head));
    this.#server.on('request', (req, res) => this.#onRequest(req, res));
    this.#server.on('clientError', (_err, socket) => socket.destroy());
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        this.#server.off('error', reject);
        resolve(this.#server.address().port);
      });
    });
  }

  async close(timeoutMs = 2000) {
    this.#server.close();
    for (const conn of this.#live) conn.teardown?.();
    const deadline = Date.now() + timeoutMs;
    while (this.#live.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    for (const conn of [...this.#live]) this.#finish(conn);
    this.#server.closeAllConnections?.();
  }

  #open(fields) {
    const conn = { id: this.#nextId++, ...fields, start: Date.now(), up: 0, down: 0, ...this.decide(fields.host) };
    this.#live.add(conn);
    return conn;
  }

  #count(conn, direction, bytes) {
    conn[direction] += bytes;
    this.onData(conn, direction, bytes);
  }

  #finish(conn) {
    if (conn.closed) return;
    conn.closed = true;
    conn.end = Date.now();
    this.#live.delete(conn);
    this.onClose(conn);
  }

  #onConnect(req, client, head) {
    client.on('error', () => {});
    const target = parseAuthority(req.url);
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const viaSsh = req.headers['x-whatleft-via'] === 'ssh';
    const conn = this.#open({ kind: viaSsh ? 'ssh' : 'tunnel', method: 'CONNECT', ...target });
    conn.teardown = () => client.destroy();

    if (conn.decision === 'block') {
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${blockedText(target.host)}`);
      this.#finish(conn);
      return;
    }

    // git-over-SSH never used the user's HTTP proxy before, so it goes direct.
    const useUpstream = !viaSsh && this.upstream && !this.bypassUpstream(target.host);
    client.once('close', () => {
      if (!conn.established) this.#finish(conn);
    });

    dial({ ...target, proxy: useUpstream ? this.upstream : null }).then(
      (server) => {
        if (conn.closed || client.destroyed) {
          server.destroy();
          return;
        }
        conn.established = true;
        conn.teardown = () => {
          client.destroy();
          server.destroy();
        };
        server.on('error', (err) => {
          conn.error ??= describeError(err);
        });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) {
          server.write(head);
          this.#count(conn, 'up', head.length);
        }
        client.on('data', (chunk) => this.#count(conn, 'up', chunk.length));
        server.on('data', (chunk) => this.#count(conn, 'down', chunk.length));
        client.pipe(server);
        server.pipe(client);
        const done = () => {
          client.destroy();
          server.destroy();
          this.#finish(conn);
        };
        client.once('close', done);
        server.once('close', done);
      },
      (err) => {
        conn.error = describeError(err);
        if (!client.destroyed) {
          client.end(
            `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n` +
              `whatleft could not reach ${formatAuthority(target.host, target.port)}: ${conn.error}\n`,
          );
        }
        this.#finish(conn);
      },
    );
  }

  #onRequest(req, res) {
    let url = null;
    try {
      url = new URL(req.url);
    } catch {}
    if (!url || url.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('whatleft is a forward proxy: send CONNECT or absolute-form http:// requests.\n');
      return;
    }
    const host = normalizeHost(url.hostname);
    const port = Number(url.port) || 80;
    const conn = this.#open({ kind: 'http', method: req.method, host, port, path: url.pathname });

    if (conn.decision === 'block') {
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end(blockedText(host));
      this.#finish(conn);
      return;
    }

    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const direct = !this.upstream || this.bypassUpstream(host);
    const options = direct
      ? { host, port, path: url.pathname + url.search, headers }
      : {
          host: this.upstream.hostname,
          port: this.upstream.port,
          path: url.href,
          headers: this.upstream.auth ? { ...headers, 'proxy-authorization': this.upstream.auth } : headers,
        };

    const outgoing = http.request({ ...options, method: req.method, agent: false, setHost: false });
    conn.teardown = () => {
      outgoing.destroy();
      res.destroy();
    };
    this.#count(conn, 'up', headBytes(`${req.method} ${url.pathname}${url.search} HTTP/1.1`, headers));

    outgoing.on('response', (incoming) => {
      conn.status = incoming.statusCode;
      this.#count(conn, 'down', headBytes(`HTTP/1.1 ${incoming.statusCode}`, incoming.headers));
      res.writeHead(incoming.statusCode, incoming.statusMessage, incoming.headers);
      incoming.on('data', (chunk) => this.#count(conn, 'down', chunk.length));
      incoming.pipe(res);
    });
    outgoing.on('error', (err) => {
      conn.error ??= describeError(err);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.on('data', (chunk) => this.#count(conn, 'up', chunk.length));
    req.pipe(outgoing);
    res.on('close', () => {
      outgoing.destroy();
      this.#finish(conn);
    });
  }
}

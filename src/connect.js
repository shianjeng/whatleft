import net from 'node:net';

export const CONNECT_TIMEOUT_MS = 30_000;
const MAX_HEAD_BYTES = 16 * 1024;

export function codeError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function describeError(err) {
  return err?.code || err?.message || String(err);
}

export function formatAuthority(host, port) {
  return net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}

// Opens a TCP connection to host:port, either directly or through an HTTP
// proxy's CONNECT method. Resolves with a paused socket once the tunnel is up.
export function dial({ host, port, proxy = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy ? { host: proxy.hostname, port: proxy.port } : { host, port });
    let settled = false;

    const onTimeout = () => fail(codeError('ETIMEDOUT', `timed out connecting to ${formatAuthority(host, port)}`));
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.off('timeout', onTimeout);
      socket.off('error', fail);
      resolve(socket);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('timeout', onTimeout);
    socket.on('error', fail);
    socket.once('connect', () => {
      if (!proxy) {
        succeed();
        return;
      }
      const authority = formatAuthority(host, port);
      const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
      if (proxy.auth) lines.push(`Proxy-Authorization: ${proxy.auth}`);
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      readResponseHead(socket).then(({ status, rest }) => {
        if (status !== 200) {
          const code = status === 403 ? 'EBLOCKED' : 'EUPSTREAM';
          fail(codeError(code, `proxy answered ${status || 'garbage'} for ${authority}`));
          return;
        }
        if (rest.length) socket.unshift(rest);
        succeed();
      }, fail);
    });
  });
}

// Reads an HTTP response head off a socket and leaves the socket paused, with
// any bytes after the head handed back so the caller can unshift them.
function readResponseHead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.pause();
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > MAX_HEAD_BYTES) {
          cleanup();
          reject(codeError('EUPSTREAM', 'proxy sent an oversized response head'));
        }
        return;
      }
      cleanup();
      const statusLine = buffer.subarray(0, buffer.indexOf('\r\n')).toString('latin1');
      resolve({ status: Number(statusLine.split(' ')[1]) || 0, rest: buffer.subarray(end + 4) });
    };
    const onEnd = () => {
      cleanup();
      reject(codeError('EUPSTREAM', 'proxy closed the connection'));
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
  });
}

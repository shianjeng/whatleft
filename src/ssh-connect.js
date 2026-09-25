#!/usr/bin/env node
// ssh ProxyCommand helper: opens a CONNECT tunnel through the whatleft proxy
// and splices it onto stdin/stdout.
import { dial } from './connect.js';

const [proxyHost, proxyPort, host, port] = process.argv.slice(2);

try {
  const socket = await dial({
    host,
    port: Number(port),
    proxy: { hostname: proxyHost, port: Number(proxyPort) },
    headers: { 'X-Whatleft-Via': 'ssh' },
  });
  socket.on('error', () => process.exit(1));
  socket.on('close', () => process.exit(0));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
} catch (err) {
  const reason = err.code === 'EBLOCKED' ? `${host} is not on the allowlist` : err.message;
  process.stderr.write(`whatleft: ssh to ${host}:${port} failed: ${reason}\n`);
  process.exit(1);
}

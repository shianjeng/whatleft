import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./ssh-connect.js', import.meta.url));

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// A GIT_SSH_COMMAND that sends git-over-SSH through the proxy, so a `git push`
// to an SSH remote shows up in the report like any HTTPS request.
export function gitSshCommand(port) {
  const proxyCommand = `ProxyCommand=${shellQuote(process.execPath)} ${shellQuote(HELPER)} 127.0.0.1 ${port} %h %p`;
  return `ssh -o ${shellQuote(proxyCommand)}`;
}

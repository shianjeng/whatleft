# whatleft

**See what your coding agent sends off your machine.**

```bash
npx whatleft claude
```

When the agent exits you get a list of every host it talked to, how much it sent to each one, and a warning if anything looks like your repository walking out the door. For example (illustrative data):

```
whatleft ▸ claude exited with 0 after 41m12s
  6 hosts · 212 connections · ↑ 58.3 MB sent · ↓ 9.1 MB received

  HOST                     WHAT                  CONNS       SENT   RECEIVED
  api.anthropic.com        Anthropic API           188    57.9 MB     8.7 MB
! paste.example.net        —                         1    38.0 MB       1 KB
  statsig.anthropic.com    Anthropic (Statsig)      14     212 KB      19 KB
  registry.npmjs.org       npm                       6      11 KB     301 KB
  github.com               GitHub                    3     1.7 KB     240 KB

  ! paste.example.net: sustained upload of 38.0 MB over 1m20s (the repository is 41.2 MB packed)
  · statsig.anthropic.com: telemetry / analytics (Anthropic (Statsig))

  Report: ~/.whatleft/sessions/20260925-103000-claude.html
```

It works with any command-line agent: Claude Code, Codex CLI, Gemini CLI, Aider, OpenCode, or a shell script.

## Why

Coding agents run with your credentials, in your repository, with network access. Most of the time that is fine. But recent incidents keep showing that you can't take an agent's network behaviour on trust: an agent uploading a user's git history, agents probing sites they were never pointed at, telemetry sent only under certain settings. Nearly everyone's answer is "I don't know what my agent sent." whatleft gives you that answer in one command.

## What makes it different

- **No certificates, no MITM.** whatleft is a local CONNECT proxy. It sees the destination host and counts bytes; it never decrypts TLS, so there is no root CA to install and nothing sensitive to leak.
- **Zero dependencies.** One small Node.js package, built only from the standard library. A tool that audits your supply chain shouldn't add to it.
- **Works behind your existing proxy.** If `HTTPS_PROXY` is already set (a corporate proxy, Clash, V2Ray), whatleft chains to it, so your network keeps working.
- **Catches git over SSH.** `git push` to an SSH remote goes through whatleft too.
- **Reports what slipped past.** Programs that ignore proxy settings are caught by a periodic check of the process tree's open sockets.

## Usage

```bash
whatleft claude                          # record a session
whatleft -- codex exec "fix the tests"   # use -- when the command has its own flags
whatleft report --open                   # reopen the latest report in your browser
whatleft ls                              # list recorded sessions
```

### Allowlists

Record first, then decide what is allowed:

```bash
# audit mode: everything goes through, unlisted hosts are flagged
whatleft --allow api.anthropic.com,statsig.anthropic.com,*.github.com claude

# enforce mode: unlisted hosts are refused
whatleft --allow api.anthropic.com,*.github.com,registry.npmjs.org --enforce claude
```

`*.github.com` covers `github.com` and all its subdomains. You can keep defaults in `~/.whatleft/config.json`:

```json
{
  "allow": ["api.anthropic.com", "*.github.com", "registry.npmjs.org"],
  "enforce": false
}
```

The config lives in your home directory on purpose: a project-level file could be edited by the very agent you are watching.

### Options

| Option | |
| --- | --- |
| `--allow <hosts>` | Allowlist, comma separated. Repeatable. |
| `--enforce` | Block hosts that aren't on the allowlist instead of only flagging them. |
| `--upstream <url>` | Chain to this HTTP proxy. Defaults to your `HTTPS_PROXY`; `none` connects directly. |
| `--no-proxy <hosts>` | Hosts the command reaches without whatleft. Default: `localhost,127.0.0.1,::1`. |
| `--config <file>` | Config file. Default: `~/.whatleft/config.json`. |
| `--no-ssh` | Don't route git-over-SSH through whatleft. |
| `--no-bypass-check` | Don't poll for connections that skip the proxy. |
| `--open` | Open the HTML report when the command exits. |
| `--quiet` | Print the summary only when something needs attention. |

## How it works

1. whatleft starts a proxy on `127.0.0.1` and runs your command with `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NODE_USE_ENV_PROXY` pointing at it. Git-over-SSH gets a `ProxyCommand` that tunnels through the same proxy.
2. Each connection is logged with its host, port, and bytes in each direction; upload volume is also bucketed every 5 seconds.
3. Every 2 seconds it lists the sockets of the command's process tree with `lsof` and notes any that don't point at the proxy.
4. When the command exits, it writes a JSONL session log and a self-contained HTML report to `~/.whatleft/sessions/` (readable only by you).

### What gets flagged

| Finding | When |
| --- | --- |
| **Sustained upload** | Uploads to one host stay above 256 KB per 5 s and add up to at least half the repository's packed size (minimum 8 MB; 32 MB outside a repo). High severity for unknown hosts; informational for model APIs, since sending code to the model is what agents do. |
| **Skipped the proxy** | A process in the tree held a connection that didn't go through whatleft. |
| **Not on allowlist** | You passed `--allow` and the host isn't covered. |
| **Telemetry** | Known analytics, error-reporting and feature-flag endpoints. |

## Limits

- whatleft can't see *what* was sent, only where and how much. That is the price of not decrypting TLS.
- It is an auditing tool, not a sandbox. A determined process can ignore proxy settings; the bypass check is best effort and can miss connections that open and close between polls. For hard guarantees, run the agent in a container or VM with an egress firewall. whatleft is still useful there for the report.
- The bypass check needs `lsof` (preinstalled on macOS, usually available on Linux) and isn't available on Windows.
- Upstream chaining supports `http://` proxies. For SOCKS-only setups, point `--upstream` at your client's HTTP port.

## Related

[pkgguard](https://github.com/shianjeng/pkgguard) stops agents from installing hallucinated, typosquatted or freshly compromised packages. whatleft shows you where data went; pkgguard checks packages before they're installed.

---

## 中文简介

**看清你的 AI 编程助手到底往外发了什么。**

```bash
npx whatleft claude
```

用 whatleft 包一层启动 Claude Code、Codex CLI、Gemini CLI 等任何命令行 agent。会话结束后，你会看到它连过哪些域名、往每个域名各发了多少数据；如果出现“疑似把整个仓库传出去”的持续大流量上传，会直接标红。

- **不装证书、不解密 TLS**：本地 CONNECT 代理，只看目标域名和字节数。
- **零依赖**：只用 Node.js 标准库。
- **兼容已有代理**：已经设置了 `HTTPS_PROXY`（公司代理、Clash、V2Ray 等）时会自动串联，不会断网。
- **白名单**：`--allow` 用于标记白名单以外的域名，加上 `--enforce` 则直接拦截。
- **绕过检测**：定期检查进程树的连接，发现没走代理的连接会报出来。
- **git over SSH** 也会计入报告。

它是审计工具，不是沙箱：只能看到数据发往哪里、发了多少，看不到内容。如果需要强隔离，请在容器或虚拟机里配合出站防火墙使用。

## License

MIT

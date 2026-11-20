# Security

English counterpart of [SECURITY.md](SECURITY.md). The Chinese file is authoritative when wording differs.

## What this plugin touches

`dsh-npm-release` runs in DSH's host process **as the current operating-system user** and executes npm commands under that identity. What it touches can be listed explicitly:

| Object | Reads | Writes |
|---|---|---|
| User `.npmrc` (`~/.npmrc`) | Yes — only the `_authToken` for the target registry and a diagnosis of its shape | **Never** |
| Temporary userconfig | — | Written to the system temp directory, removed after the command |
| `.npm-cache` under the package directory | — | npm cache and logs |
| Public registry metadata | Yes (package name, versions, `dist-tags`) | — |
| `/-/npm/v1/user`, `/-/npm/v1/tokens` | Yes, when credentials are present | — |

## How credentials are handled

**The plugin writes the token nowhere persistent.**

- At publish time the token is injected into a userconfig in the system temp directory with mode `0600`; the whole temp directory is removed after the command.
  Normal paths (including thrown errors) clean up via `finally`; a forcibly killed process does not, so temporary files may remain in the system temp directory. They are still protected by `0600` — clean that directory periodically.
- Your own `~/.npmrc` is never rewritten. This is deliberate: `_authToken` is stored **once per registry host**, not per package, so rewriting it would erase the login state of other packages on the same machine.
- The raw token never appears in tool results, logs or session records. Diagnostics give only the first four characters and the length.
- The plugin stores no long-lived token and hardcodes no credentials.

## Who can read credentials

**Same limits as DSH's own credential storage**: only the current operating-system user can read them. This is not strong isolation — the agent's tool process runs as the same user and therefore can read your files. DSH's `dsh-credentials-local` has the same known limitation.

If your deployment needs credentials hidden from the agent, file permissions cannot do it and a separate secret store is required — this plugin does not support that.

## The 2FA boundary

**The plugin never completes two-factor authentication for you.**

When publishing demands 2FA, the plugin hands the authorization link to you and stops. You confirm in the browser, then publish again with the same parameters.

The plugin will **not**:

- ask for or store your one-time code;
- click the authorization automatically;
- use a bypass-2FA token to skip multi-factor authentication.

In a non-TTY environment npm redacts the authorization URL to `***`. The plugin reports that plainly and points you to a real terminal; it never presents a redacted URL as if it were usable.

## Network behavior

The plugin sends requests only to:

| Address | Purpose |
|---|---|
| The target registry (default `https://registry.npmjs.org`) | Pack metadata, publishing, post-publish verification |
| `/-/npm/v1/user`, `/-/npm/v1/tokens` | Account 2FA mode, token package scope |
| Probe host (default `/-/ping`) | Checking whether a proxy really works |

No data is sent to any other host, and there is no telemetry.

## Command execution

The plugin executes only three things, all with argument arrays through `spawn` / `execFile` (no shell concatenation, hence no injection surface):

- `node <npm-cli.js> …` — npm itself;
- `git tag --list …` — a read-only local tag query;
- `reg query …` — Windows only, a read-only system proxy setting query.

## Content leak scanning

The pre-publish check scans files that will actually enter the tarball for home paths, emails, credentials, private IPs and loopback ports. Hits are reported **redacted** so the report itself cannot become a leak list. This check is heuristic: it does not know your project's private codenames, customer names or unreleased domains, so a human pass is still required.

## Reporting issues

Report security problems through GitHub Issues; never paste a token or the contents of `.npmrc` into a public issue.

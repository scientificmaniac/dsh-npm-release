# Changelog

All notable changes to this plugin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and versioning follows [Semantic Versioning](https://semver.org/).

This is the English counterpart of [CHANGELOG.md](CHANGELOG.md); the Chinese file is authoritative when wording differs.

## [1.0.2] - 2026-11-19

This release fixes problems introduced by the fixes in v1.0.1 itself, and adds tests that actually catch regressions.

### Fixed

- **An invalid token was reported as "does not affect publishing".** After a package was deleted, the token was revoked too; `npm token list` returned `E401`, but the old code filed it as "no permission to read the token list, publishing still works". Result: `check` was green and `publish` got 401. A 401 with credentials attached is now a blocking finding that asks you to log in again.
- **Redacted authorization links were not fully recognized.** v1.0.1 handled `/auth/cli/***` but missed `login?next=/login/cli/***`: that URL was handed to the user as if real. The rule is now "a URL containing `***` is redacted", regardless of wording, so redacted links are never handed out.
- **The leak report could leak itself.** AWS keys (`AKIA…`) were not covered by the redaction prefixes and were written verbatim into reports; loopback ports were also printed as-is. Both are now redacted.
- **POSIX home paths were widely missed.** The regex required `/` or end-of-line after the username, so `/home/<name>` followed by a space, comma, `&&` or a subpath produced no hit (an error-level rule). It now allows those forms while still letting documented placeholders pass.
- **The `unpublish` state had no real test coverage.** Deleting the whole decision left every test passing. The decision is now a pure function with direct assertions; the same mutation makes three tests fail.
- **The 24-hour cooldown was treated as a permission error.** Republishing an unpublished package returns 403; the old code sent users to inspect token scopes. It is now recognized as a cooldown: "not a credential problem, wait 24 hours".
- **The leak check no longer blocks its own rule text.** Example paths in the checker's comments produced a steady `error`, blocking the plugin from publishing itself. Rule files are now excluded, with a test that a same-named file elsewhere is not excluded.
- **Tests are cross-platform.** The `describeSpawnError` assertion now injects the platform explicitly, and two powerless real-network calls were removed. CI passes on Node 20, 22 and 24.

### Tests

227 unit tests pass. Mutation tests: removing the `unpublish` decision fails 3 tests; removing the `AKIA` redaction fails 1 test.

## [1.0.1] - 2026-11-19

All of this release came from the first real publish of v1.0.0 — the plugin publishing itself. Six defects surfaced: one made `check` crash before npm was even called, one blocked publishing with the wrong reason, and one **put local machine information on a public registry**.

### Added: the tenth check — content leak scanning

Added after the fact at a real cost: versions `1.0.0` and `1.0.1` shipped with a README example containing a home directory, absolute project path, proxy port, account name and email domain. None of the first nine checks covered it, and npm does not allow overwriting published versions — all three had to be unpublished.

`lib/leak-check.js` uses the **real pack list** rather than a recursive scan, so it neither misses README/package.json (included by npm by default) nor drowns in `.env` and test data that will not ship. Two levels:

- `error`: Windows/POSIX home paths, emails, npm credentials, GitHub/OpenAI/AWS tokens.
- `warn`: loopback addresses and ports, private IPs, absolute paths.

Every hit is **redacted** in the report (`C:\Users\<user>`, `s******@sample-mail.net`, `npm_********`) so the output does not become another leak list. Documented placeholders are allowed through.

Its own failure path was fixed too: `publish` used `skip: ['pack']`, and the leak scan depends on the pack list — so it was silently skipped on the very path that publishes. `publish` no longer skips pack.

### Fixed

- **`spawn EINVAL` crashed `check`.** The DSH host process uses its own runtime without npm and is not started by npm, so all four inference paths failed and the old fallback spawned `npm.cmd`; Node 18.20 / 20.12 (CVE-2024-27980) rejects `.cmd` under `shell: false` synchronously. A `PATH` scan for a real `npm-cli.js` was added, falling back to `cmd /d /c npm`.
- **spawn failures no longer bubble up.** Synchronous `EINVAL` and asynchronous `ENOENT` both become an explained `spawnError` result.
- **Token scope false positive blocked publishing.** An arbitrary writable token that did not cover the target was treated as an error. Since the list redacts values, the machine's actual token cannot be inferred; only "no writable token covers the package" blocks now.
- **Redacted authorization links gave the wrong next step.** Outside a TTY npm renders `auth/cli/***`; the old code returned `undefined`, said "no link captured" and implied retrying would help — retrying never did.
- **`0.0.0-stage` looked like name hijacking.** Six seconds after `PUT 202`, the registry showed only `0.0.0-stage` with `latest` pointing at it. It is a stub npm pre-creates for an in-flight publish. `isPlaceholderVersion` / `realVersions` now explain "your publish is on its way, do not retry".
- **`unpublish` state was misread.** After unpublishing, `GET /<name>` still returns 200 with `versions` and `dist-tags` emptied. `STATE_UNPUBLISHED` now reports: content removed, name still occupied, no rename needed.

### Added

- `realVersions` / `placeholderOnly`: drop placeholders before deciding "published or not".
- New unit tests for the above defects, including a real `npm --version` call, mixed token sets, redacted log samples and placeholder registry documents.

### Confirmed facts

- Real publish chain: `PUT 202` → "being processed" → `+ dsh-npm-release@1.0.0`, while `verify` still reported `not-visible`; about two minutes later the version appeared. This is exactly why success is judged from the registry, not the command exit code.
- After publishing, `verify` compared integrity with the registry and matched; after a local edit it honestly reported a mismatch.

## [1.0.0] - 2026-11-18

### Added

- The `npm_release` tool with five actions: `check` / `pack` / `publish` / `verify` / `status`.
- Nine pre-publish checks: version and metadata, credential shape, token package scope, registry, proxy, cache writability, pack contents (both directions), registry occupancy, account 2FA mode.
- Publish output classified into ten shapes, distinguishing five "not a failure" cases: web-auth 401, `/-/v1/done` polling, PUT 202, `+ pkg@ver`, ETARGET not propagated.
- Success judged from the registry's `versions`; timeout returns `not-visible` rather than `failed`.
- Authorization link recognition covers three generations of wording.
- Proxy probing uses a real HTTPS request with retry rather than a port check (which gives false positives).
- Publishing uses an isolated temporary userconfig and never rewrites your `~/.npmrc`.
- npm cache defaults inside the workspace to avoid `EPERM / _cacache` under a sandbox.
- `verify` compares locally packed integrity (sha512) with the registry instead of comparing SHA1 with SHA256.

### Fixed

- **Credential inheritance.** Isolating the userconfig also isolated `_authToken`; requests went out unauthenticated and 401s were misread as "token lacks permission to read profile", leading to the wrong "2FA cannot be queried" conclusion. The target registry's token is now inherited explicitly.
- **2FA is queryable.** With credentials, `/-/npm/v1/user` returns 200 with `tfa.mode`.
- **Proxy fallback.** The port can succeed, fail and succeed within a minute; query requests fall back to direct and report the path that worked.

> Defects such as `spawn EINVAL`, the token-scope false positive and redacted-link handling were discovered at the first real publish of v1.0.0 and are detailed in 1.0.1 and 1.0.2.

### Notes

- The plugin never completes 2FA for you and never stores a long-lived token.
- HTTP proxies only; SOCKS fails explicitly rather than silently going direct.

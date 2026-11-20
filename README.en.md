# dsh-npm-release

**Turns common npm packaging and publishing mistakes into defaults.**

A DSH plugin that exposes the `npm_release` tool. A single `action` parameter covers checks, packing, publishing, verification and environment reporting.
It does not replace npm; it covers the *publishing* part — version consistency, credential shape and permission boundaries, proxies, cache writability, the human 2FA step, and judging the result from the registry.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-2EA44F)](package.json)
![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-3B82F6)

[Changelog](CHANGELOG.en.md) · [Security](SECURITY.en.md) · [中文](README.md) · [Contributing](CONTRIBUTING.md)

---

## Install

```powershell
# From inside the plugin directory, install from the local path
dsh plugin --profile desktop install .
```

Or pick this directory under **Settings → Plugins → Add plugin**. Then **restart DSH Desktop completely** (closing the window is not enough) — host-side tools load at startup.

---

## The five actions

### `action: "status"` — see the environment first

Read-only; runs no npm write operation. Reports the npm entry point and how it was found, the registry, proxy availability, the shape of the token in your `.npmrc`, and your account / 2FA mode.

```
npm publishing environment
Working directory: <project-dir>
npm: <node> <npm-cli.js> (source: derived)
registry: https://registry.npmjs.org (official)
proxy: http://127.0.0.1:<port> (system proxy) → available

User npmrc: C:\Users\<user>\.npmrc
  registry in it: https://registry.npmmirror.com
  //registry.npmjs.org/:_authToken → valid shape (npm-token)
  ! Global registry points to mirror https://registry.npmmirror.com. Mirrors are for installing, not publishing.

Account: <username> <you@example.com>
2FA mode: auth-and-writes
  Write operations (publishing) require 2FA: npm will ask for a one-time code or browser approval.
```

### `action: "check"` — ten pre-publish checks

| # | Check | What it catches |
|---|---|---|
| 1 | Version and metadata | SemVer, `private`, CHANGELOG / RELEASE_NOTES consistency, local git tag |
| 2 | Credential shape | Length and prefix allowlist; dedicated messages for `Bearer`, placeholders, whitespace |
| 3 | Token package scope | Reads `npm token list` to see if the token covers this package; unreadable means "unreadable", never "not covered" |
| 4 | Registry | Mirrors cannot publish |
| 5 | Proxy | Real HTTPS probe with retry; reports "connected after retry" when the network flaps |
| 6 | Cache writability | Under a sandbox the user-level cache gives `EPERM`, so npm cannot even write logs |
| 7 | Pack contents | Whether `files` covers the entry and exports; whether heavy assets slipped in |
| 8 | Registry occupancy | Whether the name exists, the version is published, or the version is older than `latest` |
| 9 | 2FA necessity | Reads `tfa.mode` from the account endpoint to predict whether publishing will demand authorization |
| 10 | **Content leaks** | Whether files about to be published contain home paths, emails, credentials or private IPs; reports redacted hits |

Check 10 uses the **real pack list** as input, not a recursive directory scan — so it neither misses files npm includes by default (README, package.json) nor drowns in `.env` and test data that will not ship. `error`-level hits (home paths, emails, credentials) block publishing; loopback addresses, private IPs and absolute paths are `warn` and left to human judgement.

> This check was added after the fact: versions `1.0.0` and `1.0.1` went out with a README example that contained a home directory, project path, proxy port and account name. None of the first nine checks covered it, and npm does not allow overwriting a published version — all three versions had to be unpublished.

Any `error`-level finding returns "publishing will fail" and `publish` aborts **before** calling npm.

### `action: "pack"` — real pack preview

Runs `npm pack --dry-run --json` and returns a structured summary: file count, packed/unpacked size, shasum, integrity, large files and missing files. A native pack listing has 27–32 lines of `npm notice`; sending all of it into the context is wasteful.

### `action: "publish"` — publish, then judge the result by the registry's `versions`

Flow:

1. Run `check` first (skip with `skip_check: true`);
2. Call `npm publish --registry <official registry>`;
3. Classify the output into **eleven shapes**;
4. Stop when 2FA is required and hand the authorization link to you;
5. Otherwise poll the registry until the version is really visible or a timeout occurs.

**Eleven output shapes** (verified against real log samples):

| Shape | Meaning | Next step |
|---|---|---|
| `accepted` | Submitted (`+ pkg@ver` / PUT 202 / "being processed") | Enter polling |
| `needs-authorization` | Authorization URL obtained, not yet confirmed | Hand to the user, then retry |
| `needs-otp` | One-time password required | Needs a human |
| `bad-token` | Token is not a legal HTTP header value | Fix `.npmrc` |
| `forbidden` | 403 | Triage three causes |
| `already-published` | Version exists | Bump the version |
| `republish-cooldown` | The name is in npm's 24-hour republish cooldown after an unpublish | **Wait the full 24 hours; retrying cannot work** |
| `not-logged-in` | No login state | Log in or provide a token |
| `cache-unwritable` | EPERM | Change the cache directory (already the default) |
| `not-propagated` | ETARGET | **Wait, do not retry** |
| `failed` | Anything else | Inspect the output |

**Three overall states, only one of which means success**:

- `published` — the version is really in the registry's `versions`. This is the only state where "success" is justified.
- `not-visible` — submitted but not visible yet. **Not a failure**; retrying hits E409.
- `needs-authorization` — a human is required.

### `action: "verify"` — query only the registry

For "published but not yet propagated". By default it also packs locally and compares **integrity (sha512)**.

> Note: the registry's `dist.shasum` is SHA1; comparing it with a locally computed SHA256 can never match — we wasted that comparison in a real release. Only the same algorithm is compared here.

Besides "visible / absent", two easily misread states are explained separately:

- **Only a `0.0.0-stage` placeholder** — a stub npm pre-creates for an in-flight publish.
  `latest` points at it, which looks *exactly like someone else claimed the name*, but actually means "your publish is on its way".
- **`unpublished`** — previously published, now fully taken down. `GET /<name>` **still returns 200**,
  but `versions` and `dist-tags` are emptied and only `time.unpublished` remains.
  The name is **still yours** (nobody else can take it); republishing needs no rename.

---

## The 2FA boundary

**The plugin never completes 2FA for you, and never stores a long-lived token.**

A complete 2FA publish log looks like this:

```text
31 http fetch PUT 401 https://registry.npmjs.org/pkg      ← 2FA challenge, not a failure
33 http fetch GET 202 .../-/v1/done?sessionId=...  ×8      ← you confirm in the browser
43 http fetch PUT 202 https://registry.npmjs.org/pkg      ← accepted, not yet effective
```

The plugin recognizes three generations of authorization text:

```text
Login at:                                    ← npm login --auth-type=web
  https://www.npmjs.com/login?next=/login/cli/<id>

Authenticate your account at:                ← publish OTP challenge
  https://www.npmjs.com/auth/cli/<id>

Open this URL in your browser to authenticate:  ← another EOTP wording
```

When a link is obtained the plugin stops and hands it to you. Confirm in the browser, then publish again with the same parameters (the old link is one-time; retrying gives a new one).

**But there is a precondition: the real link is only available with a TTY.** The plugin can only use `stdio: pipe`, and in that non-interactive mode npm redacts the identifier in the authorization URL to `***` (`auth/cli/***`, `done?authId=***`). The plugin then tells you plainly that the link was redacted and to use a real terminal — it will **not** hand you a star-filled URL pretending it works; retrying always yields `***` again. To run it yourself in a terminal:

```powershell
npm publish --registry https://registry.npmjs.org
```

> We hit this for real: an early implementation treated the redaction as "link not captured" and implied retrying would help — retrying never produced anything but `***`.

**Why not fully automate it**: npm is tightening bypass-2FA tokens, and automation would hand publishing authority to an unattended process.

---

## Configuration

```yaml
- id: npm-release
  name: 'dsh-npm-release'
  config:
    registry: https://registry.npmjs.org   # default
    timeoutMs: 240000                       # timeout for a single npm command
    verifyTimeoutMs: 300000                 # time to wait for the registry after publishing
    verifyIntervalMs: 10000                 # polling interval
    proxy: http://127.0.0.1:<port>          # explicit proxy; empty reads env and system proxy
    permissions:
      publish: true                         # false keeps check / pack / verify only
```

**Credentials do not go in config**: a token is a credential, not configuration. The plugin does not read, store or write your token in plain text; it only inspects the *shape* of the line in `.npmrc`, and injects it into an isolated temporary userconfig for the real publish.

---

## Known limitations

- **`/-/npm/v1/user` requires credentials.** Without a token it returns 401, which is easily misread as "the granular token lacks permission to read user profile". An early version did exactly that: it isolated the userconfig without inheriting the token, then concluded "2FA cannot be queried". It now inherits credentials explicitly and distinguishes "no credentials sent" from "credentials rejected".
- **The npm entry point is inferred, not taken from `PATH` order.** Order: explicit config → `npm-cli.js` next to `process.execPath` → `npm_execpath` → scan `PATH` for a real `npm-cli.js` → `cmd /d /c npm`. The plugin will **never** directly `spawn('npm.cmd')`: since Node 18.20 / 20.12 (CVE-2024-27980) that synchronously throws `EINVAL` under `shell: false`, and the DSH host process uses its own runtime without npm — we crashed there once with nothing but `Error: spawn EINVAL`. Set `DSH_NPM_RELEASE_NPM_CLI` and `DSH_NPM_RELEASE_NODE` to pin the location.
- **A token list only proves whether some token covers the package, not which one this machine uses.** `npm token list` redacts token values while `.npmrc` stores a single `_authToken`. Only "no writable token covers this package" is blocking; otherwise it says "a covering token exists" without asserting publishing will succeed.
- **Authorization is never submitted automatically.** A human is in the loop, without exception.
- **The token list may be unreadable.** Without `tokens:read`, `npm token list` returns 401; the plugin only says it cannot verify the scope, never invents a conclusion.
- **Proxies flap.** We measured a port succeeding, failing and succeeding again within one minute, so query requests fall back to direct connection on failure and report which path actually worked.
- **HTTP proxies only, no SOCKS.** Zero dependencies; SOCKS fails explicitly rather than silently going direct.
- **git tags are local only.** The remote needs network; a local tag is enough to detect "version not bumped".
- **`dist-tags` may still point at an older version.** With a non-`latest` tag, "version visible" and "became latest" are separate facts and reported separately.
- **The name stays occupied after unpublish.** After unpublishing all three versions, `GET /<name>` still returns 200 with `versions` and `dist-tags` emptied and only `time.unpublished` left. This is reported as `unpublished`: content removed, name still yours, no rename needed to republish.
- **The leak check is heuristic.** It works by pattern matching and does not know your project's internal codenames, customer names or unreleased service domains. Anything outside the rules still needs a human pass.

---

## Tests

```powershell
node scripts/check-icon.mjs                  # icon self-check
node scripts/probe-2fa.mjs                   # 2FA / credential path experiment (direct vs proxy)
node test/unit.mjs                           # unit tests (pure functions and classifiers)
node test/smoke.mjs status                   # real environment self-check (account and 2FA mode)
node test/smoke.mjs check "E:/path/to/pkg"   # run all ten checks on a real package
node test/smoke.mjs verify "E:/path/to/pkg"  # verify a real package against the registry
```

`test/smoke.mjs` drives the real `apply()` with a minimal fake ctx, so it verifies that the registered tool actually runs, not merely that the module imports.

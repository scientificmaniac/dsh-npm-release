# 更新日志

本插件的所有重要改动记录在这里。格式参照 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [Semantic Versioning](https://semver.org/)。

## [1.0.0] - 2026-11-18

### 新增

- `npm_release` 工具，五个动作：`check` / `pack` / `publish` / `verify` / `status`。
- 九项发布前检查：版本与元数据、凭据形态、token 包级 scope、注册源、代理可用性、
  缓存可写性、打包内容（双向）、registry 占用、账号 2FA 模式。
- 发布输出按十种形态分类，区分出五种「不是失败」：web auth 的 401、`/-/v1/done` 轮询、
  PUT 202、`+ pkg@ver`、`ETARGET` 传播未完成。
- 发布成功判定改为 registry 的 `versions` 是否真的出现该版本；超时返回 `not-visible` 而非 `failed`。
- 2FA 授权链接识别覆盖三代文案（`login?next=/login/cli/`、`auth/cli/`、`Open this URL`）。
- 代理探测改为真实 HTTPS 请求并带重试，不探端口（端口在听会假阳性）。
- 发布使用隔离的临时 userconfig，不改写用户的 `~/.npmrc`。
- npm 缓存默认放在工作区内，避开沙箱下的 `EPERM / _cacache`。
- `verify` 会用本地打包的 integrity（sha512）与 registry 对照，而不是拿 SHA1 对照 SHA256。

### 修正

- **npm 入口定位（首次真实发布时踩到，最重要）。** 在本机 DSH Desktop 里跑 `check` 直接崩成
  一句 `Error: spawn EINVAL`，什么都做不了。根因不是 npm 装错了，而是三条推断同时不成立：
  Host 进程用的是 DSH 自带运行时（`…/dsh-runtimes/…/node/bin/node.exe`，目录里**没有 npm**），
  且它不由 npm 启动（`npm_execpath` 为空）。于是旧代码退到兜底的 `npm.cmd`，
  而 Node 从 18.20 / 20.12 起（CVE-2024-27980）在 `shell: false` 下**同步拒绝**执行 `.cmd`。
  现在补了「扫 `PATH` 找真实 `npm-cli.js` 并配对 `node.exe`」这一层，最后才退到
  `cmd /d /c npm` 并明确标注「退出码经过一层壳」。
- **spawn 失败不再冒泡。** 同步 `EINVAL` 与异步 `ENOENT` 原先分别被抛成异常和伪装成
  「命令跑了但没输出」。现在两条路径都翻成带解释的 `spawnError` 结果：
  `npm_release` 会说明是插件没能启动 npm，与包内容、凭据无关，而不会被误读成发布失败。
- **token 包级 scope 误报阻断（首次真实发布时踩到）。** 旧逻辑从 `npm token list` 里
  随便挑一条「有写权限但不覆盖目标包」的 token 就判 error，于是发布全新的 `dsh-npm-release`
  被拦下，理由是另一条 token（`dsh-ssh-vault`，scope 仅该包）不包含它。
  但列表接口把 token 原文打码了，**无法反推本机 `.npmrc` 里用的是哪一条**；
  本机恰好还有一条全包 token，完全能发布。现在只有「每一条可写 token 都不含目标包」
  才算必然 403，否则放行并说明「存在覆盖项」。
- **凭据继承（重要）。** 隔离 userconfig 的代价是连同用户 `.npmrc` 里的 `_authToken`
  一起隔离掉；早期版本只隔离不继承，导致所有需要凭据的请求裸奔返回 401，
  进而把「没带凭据」误判成「token 没有读用户资料的权限」，并错误地宣称「2FA 查不到」。
  现在按目标 registry 继承那一行凭据，并把「没带凭据」与「凭据被拒」分开报告。
- **2FA 可查。** 带上凭据后 `/-/npm/v1/user` 返回 200，响应含 `tfa.mode`。
  实测账号为 `auth-and-writes`，即发布需要 2FA。`status` 与 `check` 都会如实报告。
- **代理回退。** 同一分钟内代理端口会成功、失败、再成功，因此查询类请求在代理失败时
  自动回退直连，并报告实际走成的路径。

### 说明

- 插件不代替人完成 2FA，也不保存长期 token。
- 只支持 HTTP 代理；SOCKS 会明确报错而不是静默直连。

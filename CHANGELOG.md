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

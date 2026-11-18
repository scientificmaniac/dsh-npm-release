# 更新日志

本插件的所有重要改动记录在这里。格式参照 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [Semantic Versioning](https://semver.org/)。

## [1.0.1] - 2026-11-19

这一版全部来自 **v1.0.0 的第一次真实发布**：用插件发它自己。三个缺陷都是在那一刻暴露的，
其中一个让 `check` 在动 npm 之前就崩掉，另一个拦住了发布并把原因指错了方向。

### 修正

- **`spawn EINVAL`：`check` 在真实发布里直接崩掉。**
  症状只有一句 `Error: spawn EINVAL`，看不出是哪个命令、什么原因。根因是 npm 入口定位：
  DSH Desktop 的 Host 进程用自带运行时（`…/dsh-runtimes/…/node/bin/node.exe`，目录里**没有 npm**），
  且它不由 npm 启动（`npm_execpath` 为空）。四条推断全部落空后，旧代码退到兜底的 `npm.cmd`，
  而 Node 从 18.20 / 20.12 起（CVE-2024-27980）在 `shell: false` 下**同步拒绝**执行 `.cmd`。
  现在补了「扫 `PATH` 找真实 `npm-cli.js` 并配对 `node.exe`」这一层（实测来源变为 `path-scan`），
  最后才退到 `cmd /d /c npm` 并标注「退出码经过一层壳」。可用
  `DSH_NPM_RELEASE_NPM_CLI` / `DSH_NPM_RELEASE_NODE` 钉死位置。
- **spawn 失败不再冒泡。** 同步 `EINVAL` 与异步 `ENOENT` 原先分别被抛成异常、
  和伪装成「命令跑了但没输出」。现在两条路径都翻成带解释的 `spawnError` 结果。
- **token 包级 scope 误报，把可发布的包拦在 npm 之前。**
  旧逻辑从 `npm token list` 里挑任意一条「有写权限但不覆盖目标包」的 token 就判 error。
  本机同时存在 `dsh-ssh-vault`（scope 仅该包）与一条全包 token，于是发布全新的
  `dsh-npm-release` 被判成「现在发布必然失败」，理由是另一条 token 不包含它。
  但列表接口把 token 原文**打码**了，无法反推 `.npmrc` 里用的是哪一条。
  现在只有「每一条可写 token 都不含目标包」才算必然 403，否则放行并说明存在覆盖项。
- **授权链接被 npm 打码成 `***` 时给错了下一步。**
  非 TTY（插件的 `stdio: pipe`）下 npm 把 `auth/cli/***` 的标识符渲染成星号，
  旧实现返回 `undefined`，工具于是说「没有取到授权链接」并暗示重发即可，
  而重发永远只会得到 `***`。现在单独识别为 `redacted: true`，
  直接给出正确的下一步：去真终端执行（那里有 TTY）。
- **`0.0.0-stage` 占位符会被误读成「包名被抢注」。**
  发布被接受六秒后，registry 上出现唯一版本 `0.0.0-stage`、`latest` 指向它，
  描述是 `Temporary package placeholder for staged publishing`。这看起来完全是
  「别人先占了这个名字」，实际是 npm 为正在传播的发布预建的 stub。
  新增 `isPlaceholderVersion` / `realVersions`，`verify` 与 `check` 都会说明
  「我的发布在路上，不是被抢注」，并明确不要重发。

### 新增

- `realVersions` / `placeholderOnly`：`versions` 里剔除占位符后再判断「发布了没有」。
- 12 组 / 20 条新单元测试，覆盖上述三个缺陷，含真实 `npm --version` 调用与
  混合 token 组合、打码授权日志样本、占位符 registry 文档。

### 已确认的事实

- 本次真实发布链路：`PUT 202` → npm 提示「正在处理」→ `+ dsh-npm-release@1.0.0`，
  但 `verify` 当时仍报 `not-visible`，约两分钟后 `versions` 才出现 `1.0.0`、`latest` 转向它。
  **这正是插件不以命令退出码判定成功的原因**：若当时宣布成功，就会出现一个 registry 上
  还不存在的「成功」。
- 发布后 `verify` 比对 integrity 与 registry 完全一致；本地改动后再比对则如实报告「不一致」。

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

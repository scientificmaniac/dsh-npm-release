# dsh-npm-release

**把 npm 打包与发布里踩过的坑，变成缺省行为。**

一个 DSH 插件：暴露 `npm_release` 工具，用一个 `action` 参数覆盖检查、打包、发布、校验与环境报告。
它不替代 npm，补的是**发布这一段**——版本一致性、凭据形态与权限边界、代理、缓存、2FA 人工环节、以及发布后的判定。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-2EA44F)](package.json)
![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-3B82F6)

[更新日志](CHANGELOG.md) · [安全说明](SECURITY.md)

---

## 安装

```powershell
# 在插件目录内，从本地目录安装
dsh plugin --profile desktop install .
```

或在 **设置 → 插件 → 添加插件** 里选这个目录。装完**重启 DSH Desktop**（要完全退出进程，关窗口不够），Host 侧工具在启动时加载。

---

## 五个动作

### `action: "status"` —— 先看清环境

只读，不跑任何 npm 写操作。报告 npm 的入口与来源、registry、代理可用性、用户 `.npmrc` 的 token 形态，以及账号与 2FA 模式。

```
npm 发布环境
工作目录：<project-dir>
npm：<node> <npm-cli.js>（来源：derived）
registry：https://registry.npmjs.org（官方源）
代理：http://127.0.0.1:<port>（系统代理） → 可用

用户 npmrc：C:\Users\<user>\.npmrc
  其中的 registry：https://registry.npmmirror.com
  //registry.npmjs.org/:_authToken → 形态合法（npm-token）
  ! 全局 registry 指向镜像 https://registry.npmmirror.com。镜像适合装包，不承载登录态也不能发布。

账号：<username> <you@example.com>
2FA 模式：auth-and-writes
  写入类操作（发布）需要 2FA：发布时 npm 会要求一次性验证码或浏览器授权。
```

### `action: "check"` —— 十项发布前检查

| # | 检查 | 说明 |
|---|---|---|
| 1 | 版本与元数据 | 语义化版本、`private`、CHANGELOG/RELEASE_NOTES 一致性、本地 git tag |
| 2 | 凭据形态 | 长度与前缀白名单；`Bearer` 前缀、占位符、空白字符各有专门提示 |
| 3 | token 包级 scope | 读 `npm token list` 判断是否覆盖当前包；读不到就说「读不到」，不冒充「不覆盖」 |
| 4 | 注册源 | 镜像源不能发布 |
| 5 | 代理 | 真实 HTTPS 探测，带重试；抖动了会说「重试后才通」 |
| 6 | 缓存可写 | 沙箱下用户级缓存不可写会 `EPERM`，连日志都写不出来 |
| 7 | 打包内容 | `files` 是否覆盖入口与 exports；重资产是否误入 |
| 8 | registry 占用 | 包名是否存在、目标版本是否已发布、是否低于 latest |
| 9 | 2FA 必要性 | 查账号接口的 `tfa.mode`，得出「发布时会不会被要求授权」 |
| 10 | **内容泄露** | 待发布的文件里有没有主目录、邮箱、凭据、内网地址；命中时脱敏报告 |

第 10 项以**真实打包清单**为输入，不是递归扫目录——所以既不会漏掉被 npm 默认包含的
README/package.json，也不会被不会进包的 `.env`、测试数据淹没。`error` 级命中（主目录、
邮箱、凭据）会阻断发布；回环地址、内网 IP、绝对路径是 `warn`，交给人判断。

> 这一项是**事后补的**：`1.0.0` 与 `1.0.1` 上线之后才发现 README 示例里带着本机主目录、
> 项目路径、代理端口与账号名。前九项一条都没覆盖它，而 npm 不允许覆盖已发布版本——
> 最后只能把这三个版本全部 unpublish。

有 `error` 级问题时返回「现在发布必然失败」，`publish` 会据此在调用 npm **之前**中止。

### `action: "pack"` —— 真实打包预览

走 `npm pack --dry-run --json`，给回结构化摘要：文件数、压缩/展开体积、shasum、integrity、大文件、缺失文件。
一次发布的原生清单有 27–32 行 `npm notice`，全部塞进上下文是浪费。

### `action: "publish"` —— 发布，但以 registry 为准

流程：

1. 先跑一遍 `check`（可用 `skip_check: true` 跳过）；
2. 调用 `npm publish --registry <官方源>`；
3. 把输出按**十种形态**分类；
4. 需要 2FA 时停下，把授权链接交给你；
5. 否则轮询 registry，直到真的看到这一版或超时。

**十种输出分类**（用真实日志样本验证过）：

| 分类 | 含义 | 下一步 |
|---|---|---|
| `accepted` | 已提交（`+ pkg@ver` / PUT 202 / 「正在处理」） | 进入轮询 |
| `needs-authorization` | 授权 URL 已取到，人未确认 | 交给用户，重发 |
| `needs-otp` | 要求一次性验证码 | 需要人 |
| `bad-token` | token 不是合法 HTTP 头值 | 修 `.npmrc` |
| `forbidden` | 403 | 分诊三种原因 |
| `already-published` | 版本已存在 | 提版本 |
| `not-logged-in` | 无登录态 | 登录或给 token |
| `cache-unwritable` | EPERM | 改缓存目录（已默认） |
| `not-propagated` | ETARGET | **等，不要重发** |
| `failed` | 其他 | 看输出 |

**三种状态，只有一种叫成功**：

- `published` —— registry 的 `versions` 里真的有了这一版。这是唯一能说「成功」的情况。
- `not-visible` —— 已提交但还看不到。**不是失败**，重发会撞 E409。
- `needs-authorization` —— 需要人。

### `action: "verify"` —— 只查 registry

用于「已经发过，只是还没传播完」的场景。默认还会在本地打包一次，比对 **integrity（sha512）**。

> 注意：registry 的 `dist.shasum` 是 SHA1，拿它和本地算的 SHA256 对照永远不可能相等——真实发布里这一步白跑过一次。所以这里只比对同一种算法。

除了「可见 / 不存在」，还有两种容易被误读的状态，`verify` 会分别说明：

- **只有 `0.0.0-stage` 占位符** —— npm 为正在传播的发布预建的 stub。
  `latest` 会指向它，看起来**完全像「包名被别人抢先注册」**，实际是「你的发布在路上」。
- **`unpublished`** —— 曾经发布过、内容已全部下架。此时 `GET /<name>` **仍返回 200**，
  只是 `versions` 与 `dist-tags` 被抽空、只剩 `time.unpublished`。
  包名**仍归你**（别人注册不了），重新发布不需要改名。

---

## 2FA 的边界

**插件不替你完成 2FA，也不保存长期 token。**

真实形态比想象的复杂。一个完整的 2FA 发布日志长这样：

```text
31 http fetch PUT 401 https://registry.npmjs.org/pkg      ← 2FA 挑战，不是失败
33 http fetch GET 202 .../-/v1/done?sessionId=...  ×8      ← 你在浏览器里确认
43 http fetch PUT 202 https://registry.npmjs.org/pkg      ← 已接受，不是已生效
```

本插件认三类授权文案（来自不同 npm 版本与阶段）：

```text
Login at:                                    ← npm login --auth-type=web
  https://www.npmjs.com/login?next=/login/cli/<id>

Authenticate your account at:                ← publish 的 OTP 挑战
  https://www.npmjs.com/auth/cli/<id>

Open this URL in your browser to authenticate:  ← 另一条 EOTP 文案
```

拿到链接后插件停下，把 URL 交给你。你在浏览器里确认完，用同样参数再发一次
（旧链接一次性失效，重发会拿到新链接）。

**但有个前提：只在有 TTY 时才能拿到真链接。** 插件只能用 `stdio: pipe`，而 npm 在这种
非交互环境下会把授权 URL 里的标识符渲染成 `***`（`auth/cli/***`、`done?authId=***`）。
这时插件会明确告诉你「链接已被 npm 打码，去真终端执行」，**不会**把含星号的无效 URL
当成可用链接塞给你——重发多少次都是 `***`。想在终端里自己走一遍就用：

```powershell
npm publish --registry https://registry.npmjs.org
```

> 这一条是真实撞出来的：早期实现把打码当成「没取到链接」，暗示重发即可，结果重发永远只有 `***`。

**为什么不做全自动**：npm 正在收紧 bypass-2FA token，而且那等于把发布权交给无人值守进程。

---

## 配置

```yaml
- id: npm-release
  name: 'dsh-npm-release'
  config:
    registry: https://registry.npmjs.org   # 默认
    timeoutMs: 240000                       # 单条 npm 命令超时
    verifyTimeoutMs: 300000                 # 发布后等待 registry 生效的超时
    verifyIntervalMs: 10000                 # 轮询间隔
    proxy: http://127.0.0.1:<port>          # 显式代理；留空则读环境变量与系统代理
    permissions:
      publish: true                         # 设为 false 只保留 check / pack / verify
```

**凭据不进配置**：token 属于凭据，不属于配置。本插件不读、不存、不写你的 token 原文，
只读取 `.npmrc` 里那一行的**形态**；真实发布会把它注入隔离的临时 userconfig。

---

## 已知限制

- **`/-/npm/v1/user` 必须带凭据才有效。** 不带 token 时它返回 401，而这个 401 极易被误读成「granular token 没有读用户资料的权限」。本插件早期版本正是这样误判的：隔离 userconfig 时没有继承 token，于是得出「2FA 查不到」的错误结论。现在改成显式继承凭据，并区分「没带凭据」与「凭据被拒」。
- **npm 入口靠推断，不靠 `PATH` 的顺序。** 顺序是：显式配置 → 与 `process.execPath` 同级的 `npm-cli.js` → `npm_execpath` → 扫 `PATH` 找真实 `npm-cli.js` → `cmd /d /c npm`。**任何情况下都不会直接 `spawn('npm.cmd')`**：Node 从 18.20 / 20.12 起（CVE-2024-27980）在 `shell: false` 下同步抛 `EINVAL`，DSH Desktop 的 Host 进程用的正是自带的不含 npm 的运行时，这条路上崩溃过一次，报错只有一句 `Error: spawn EINVAL`。想钉死位置时设 `DSH_NPM_RELEASE_NPM_CLI` 与 `DSH_NPM_RELEASE_NODE`。
- **token 列表只能证明「有没有一条能覆盖」，不能证明「本机在用哪一条」。** `npm token list` 把 token 原文打码了，而 `.npmrc` 里只存一条 `_authToken`。所以只有「每一条可写 token 的 scope 都不含目标包」才判阻断；反过来只能说「存在覆盖项」，不会替你断言发布一定成功。
- **不自动提交授权。** 人在环，没有例外。
- **token 列表可能读不到。** 无 `tokens:read` 权限时 `npm token list` 返回 401；此时插件只告诉你「无法核对包范围」，不会编造结论。
- **代理时通时断。** 实测同一分钟内代理端口会成功、失败、再成功，因此查询类请求在代理失败时自动回退直连，并把实际走成的路径报告出来。
- **只支持 HTTP 代理，不支持 SOCKS。** 零依赖实现；SOCKS 会明确报错而不是静默直连。
- **git tag 只看本地。** 远端要联网，本地 tag 已足够发现「版本号没动」。
- **`dist-tags` 可能仍指向旧版本。** 传了非 `latest` 的 tag 时，「版本可见」与「成为 latest」是两件事，两者分开报告。
- **unpublish 之后包名仍被占用。** 实测把三个版本全部 unpublish 后，`GET /<name>` 仍返回 200，但 `versions` 与 `dist-tags` 被抽空，只剩 `time.unpublished`。这个状态被单独识别为 `unpublished`：内容已下架，但名字还是你的，重新发布不需要改名。
- **内容泄露检查是启发式的。** 它按规则匹配，不认识你项目里的专有名词（内部代号、客户名、未公开的服务域名）。规则之外的信息仍需自己过一遍。

---

## 测试

```powershell
node scripts/check-icon.mjs                  # 图标自检
node scripts/probe-2fa.mjs                   # 2FA / 凭据链路对照实验（直连 vs 代理）
node test/unit.mjs                           # 单元测试（纯函数与分类器）
node test/smoke.mjs status                   # 真实环境自检（含账号与 2FA 模式）
node test/smoke.mjs check "E:/path/to/pkg"   # 对真实包跑十项检查
node test/smoke.mjs verify "E:/path/to/pkg"  # 对真实包校验 registry
```

`test/smoke.mjs` 用最小假 ctx 驱动真实的 `apply()`，因此它验证的是**已经注册的工具真的能跑**，
而不只是模块能 import。

# dsh-npm-release

**把 npm 打包与发布里踩过的坑，变成缺省行为。**

一个 DSH 插件：暴露 `npm_release` 工具，用一个 `action` 参数覆盖检查、打包、发布、校验与环境报告。
它不替代 npm，补的是**发布这一段**——版本一致性、凭据形态与权限边界、代理、缓存、2FA 人工环节、以及发布后的判定。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-2EA44F)](package.json)
![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-3B82F6)

[更新日志](CHANGELOG.md) · [安全说明](SECURITY.md)

---

## 为什么需要它

以下每一条都不是假想，都是本机真实发生过、并让人走错方向的事故。

| 现象 | 真实原因 | 本插件的处理 |
|---|---|---|
| `Bearer <新token> is not a legal HTTP header value` | `.npmrc` 里有一行占位符 `_authToken`，被当成真实凭据发出 | 用**形态白名单**校验 token，占位符在调用 npm 之前就被拦下 |
| `403 You may not perform that action with these credentials` | granular token 的 `scopes` 只含别的包；npm 的文案完全没说这件事 | 读 `npm token list` 核对包级 scope，把 403 分诊成三个不同原因 |
| `npm login` 覆盖掉了另一个包的登录态 | `_authToken` 按 registry host 存**一条**，不按包分 | 用隔离的临时 userconfig，一次也不改写用户的 `~/.npmrc` |
| 发布返回成功，registry 上仍是旧版本 | 命令的 202 只代表「已接受」，传播要几十秒到两分钟 | **唯一成功判据是 registry 的 `versions` 里真的出现该版本** |
| `ETARGET: No matching version found` | 传播未完成，不是发布失败 | 归类为 `not-propagated`，明确提示不要重发 |
| 发布后 `npm install` 拿旧版本 | 同上；此时重发会撞 `E409` | 轮询 `dist-tags`，超时返回 `not-visible` 而非 `failed` |
| `EPERM ... _cacache`，连 `npm pack --dry-run` 都跑不了 | 沙箱下用户级缓存不可写，日志也落不了盘 | 自动把 `npm_config_cache` 指到工作区内 |
| GitHub / npm 全部超时，但端口在听 | `ProxyEnable=0`；或 fake-ip 让端口通、TLS 失败 | 真的发一次 HTTPS 请求来判断，**不探端口**（会假阳性） |
| 发布前不知道包名是否被占 / 版本是否已发 | 没查 | registry 查询 + 版本比对，在 `check` 阶段阻断 |
| 1.5 MB 的包，1.5 MB 是一张宣传图 | `files` 没约束重资产 | 打包清单双向检查：该在的在，不该在的不在 |

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

只读，不跑任何 npm 写操作。报告 npm 的入口与来源、registry、代理可用性、用户 `.npmrc` 的 token 形态。

```
npm 发布环境
工作目录：E:\ai project\dsh-npm
npm：D:\NodeJs\node.exe ...\npm-cli.js（来源：derived）
registry：https://registry.npmjs.org（官方源）
代理：直连 → 可用

用户 npmrc：C:\Users\...\.npmrc
  其中的 registry：https://registry.npmmirror.com
  //registry.npmjs.org/:_authToken → 形态合法（npm-token）
  ! 全局 registry 指向镜像 https://registry.npmmirror.com。镜像适合装包，不承载登录态也不能发布。
```

### `action: "check"` —— 九项发布前检查

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
    proxy: http://127.0.0.1:7897            # 显式代理；留空则读环境变量与系统代理
    permissions:
      publish: true                         # 设为 false 只保留 check / pack / verify
```

**凭据不进配置**：token 属于凭据，不属于配置。本插件不读、不存、不写你的 token 原文，
只读取 `.npmrc` 里那一行的**形态**；真实发布会把它注入隔离的临时 userconfig。

---

## 已知限制

- **`/-/npm/v1/user` 必须带凭据才有效。** 不带 token 时它返回 401，而这个 401 极易被误读成「granular token 没有读用户资料的权限」。本插件早期版本正是这样误判的：隔离 userconfig 时没有继承 token，于是得出「2FA 查不到」的错误结论。现在改成显式继承凭据，并区分「没带凭据」与「凭据被拒」。
- **不自动提交授权。** 人在环，没有例外。
- **token 列表可能读不到。** 无 `tokens:read` 权限时 `npm token list` 返回 401；此时插件只告诉你「无法核对包范围」，不会编造结论。
- **代理时通时断。** 实测同一分钟内代理端口会成功、失败、再成功，因此查询类请求在代理失败时自动回退直连，并把实际走成的路径报告出来。
- **只支持 HTTP 代理，不支持 SOCKS。** 零依赖实现；SOCKS 会明确报错而不是静默直连。
- **git tag 只看本地。** 远端要联网，本地 tag 已足够发现「版本号没动」。
- **`dist-tags` 可能仍指向旧版本。** 传了非 `latest` 的 tag 时，「版本可见」与「成为 latest」是两件事，两者分开报告。

---

## 测试

```powershell
node scripts/check-icon.mjs                  # 图标自检
node scripts/probe-2fa.mjs                   # 2FA / 凭据链路对照实验（直连 vs 代理）
node test/unit.mjs                           # 单元测试（纯函数与分类器）
node test/smoke.mjs status                   # 真实环境自检（含账号与 2FA 模式）
node test/smoke.mjs check "E:/path/to/pkg"   # 对真实包跑九项检查
node test/smoke.mjs verify "E:/path/to/pkg"  # 对真实包校验 registry
```

`test/smoke.mjs` 用最小假 ctx 驱动真实的 `apply()`，因此它验证的是**已经注册的工具真的能跑**，
而不只是模块能 import。

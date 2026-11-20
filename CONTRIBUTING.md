# Contributing / 贡献指南

本文件面向 `dsh-npm-release`（DeepSeek Harness 的 npm 发布插件）的贡献者：怎么准备环境、改代码、跑测试、同步文档、出新版本。

本文档的写法参考了一份同类插件的贡献指南，但**结构按本仓库实际情况改写**：本仓库没有多语言目录、没有发行工作流、没有 `dist/` 产物，这些不适用规则已删除；其中真正通用的规则（文档成对、纯文档改动不升版本、隐私不落盘、提交前缀）保留下来。

---

This document is for contributors to `dsh-npm-release` (an npm publishing plugin for DeepSeek Harness): how to set up, change code, run tests, keep docs in sync, and cut a release.

Its structure follows the actual repository rather than the template it was modeled on: there are no multilingual source directories, no release workflow and no `dist/` artifacts here. Only the rules that genuinely apply — paired documentation, no version bump for docs-only changes, privacy never on disk, and commit prefixes — are kept.

## 环境准备 / Setup

- **Node ≥ 20**（`package.json` 的 `engines.node`）。仓库**没有第三方依赖**，也没有 lockfile，因此不需要 `npm install` / `npm ci`。
- 单元测试不需要登录 npm，也不需要网络：分类器与纯函数都用本地样本驱动。
- `test/smoke.mjs` 会连真实 registry 并读取本机 `.npmrc`，属于手动自检，不在 CI 中运行。
- 可选：装好 DSH Desktop 以便从 Host 侧调用 `npm_release` 工具；改动 Host 行为后必须重启 DSH。

```bash
git clone https://github.com/scientificmaniac/dsh-npm-release.git
cd dsh-npm-release
node --version      # 需 ≥ 20
npm test
```

## 仓库结构 / Layout

| 路径 | 职责 |
| --- | --- |
| `index.js` | Host 入口：注册 `npm_release` 工具、五个动作的编排、服务暴露 |
| `lib/credentials.js` | 凭据形态诊断、`npm token list` 解析、账号 2FA 查询 |
| `lib/npm-run.js` | npm 入口定位、隔离 userconfig、缓存、代理变量、命令执行 |
| `lib/check-runner.js` | 十项发布前检查的编排 |
| `lib/leak-check.js` | 发布前内容泄露扫描与脱敏 |
| `lib/package-check.js` | 版本与 `files` 清单一致性、`npm pack` 摘要 |
| `lib/registry.js` | registry 状态判定、轮询、发布输出分类、授权链接提取 |
| `lib/publish-runner.js` | 发布编排：授权 / 冷却期 / 失败分诊 / 等待 registry 生效 |
| `lib/render.js` | 面向模型的文本渲染 |
| `lib/proxy.js`、`lib/http.js` | 系统代理解析、真实 HTTPS 探测与直连回退 |
| `lib/reason.js` | `category → message → hint` 三段式失败原因 |
| `locale/{zh,en}.json` | 市场展示名与描述 |
| `cordis.patch.yml` | DSH 装载补丁（`dsh.bundle.patch` 指向它） |
| `icon.svg` | 插件图标 |
| `scripts/check.mjs` | 打包自检：manifest、locale、补丁、模块加载、真实 `npm pack` 清单 |
| `scripts/check-icon.mjs` | 图标自检 |
| `scripts/probe-2fa.mjs` | 手动对照实验：直连 vs 代理下的 2FA / 凭据链路 |
| `test/unit.mjs` | 单元测试：纯函数与分类器 |
| `test/smoke.mjs` | 用最小假 ctx 驱动真实 `apply()` 的手动自检 |
| `.github/workflows/ci.yml` | 每次 push 与 PR 在 Node 20 / 22 / 24 上跑测试与自检 |
| `RELEASE_NOTES/v<version>.md` | 每个版本的发行说明 |
| `README.md` / `README.en.md` | 中文主文档与英文对照 |
| `CHANGELOG.md` / `CHANGELOG.en.md` | 中文主更新日志与英文对照 |
| `SECURITY.md` / `SECURITY.en.md` | 中文主安全说明与英文对照 |

## 本地验证 / Local checks

```bash
npm test                # 单元 + 图标自检 + 打包自检，不需要网络
npm run check           # 只跑打包自检
npm run check:icon      # 只跑图标自检
npm run probe           # 手动 2FA / 凭据链路对照实验，会访问 registry

node test/smoke.mjs status   # 真实环境自检（账号、2FA、代理、凭据形态）
node test/smoke.mjs check    # 对真实包跑十项检查
node test/smoke.mjs verify   # 对真实包校验 registry
```

新增行为必须有测试；**只改文档时 `npm run check` 足够**，不需要升版本。

## 代码约定 / Conventions

- **纯 ESM、零依赖、无构建步骤。** 不要引入打包器或转译。
- **逻辑放 `lib/`，`index.js` 只做编排。** 工具入口与将来的设置页共用同一份服务实现，不要在入口里复制逻辑。
- **面向模型的文本统一走 `lib/render.js`**，避免工具与其它入口说法不一致。
- **判定与渲染分离。** registry 状态这类结论用纯函数产出（见 `interpretPackageDoc`），这样才能被测试真正覆盖——把判定内联进网络函数，会导致删掉判定而测试全绿。
- **成功以 registry 为准。** npm 的退出码、`+ pkg@ver`、PUT 202 都只代表「已提交」；只有 registry 的 `versions` 真的出现该版本才算成功。超时返回 `not-visible`，**不要重发**。
- **凭据不落盘、不进配置。** token 只进隔离的临时 userconfig；诊断只给前缀与长度；用户的 `.npmrc` 一次也不改写。
- **报告本身不能成为泄露清单。** 泄露扫描的所有命中片段必须脱敏后再输出。
- **2FA 必须有人在环。** 不询问、不保存一次性验证码，不自动点击授权，不使用 bypass-2FA token。
- **注释解释「为什么」，不复述代码。** 本仓库的注释里记录的是真实事故的成因，不要删改成泛泛而谈。

## 测试分工 / What each test file covers

| 文件 | 覆盖 |
| --- | --- |
| `test/unit.mjs` | 凭据形态与 token scope、发布输出分类、授权链接提取与打码、registry 状态推导、泄露规则与脱敏、npm 入口定位、失效 token |
| `test/smoke.mjs` | 用最小假 ctx 驱动真实 `apply()`，验证注册的工具确实能跑；会访问真实 registry |

单元测试不依赖网络：需要真实 registry 文档的地方用本地构造的对象直接喂给纯函数。CI 在 Ubuntu 的 Node 20 / 22 / 24 上跑，因此任何断言都不能依赖 `process.platform` 的当前值。

## 文档要求 / Docs

- `README.md` 与 `README.en.md`、`CHANGELOG.md` 与 `CHANGELOG.en.md`、`SECURITY.md` 与 `SECURITY.en.md` 成对修改，行为描述不能分歧。中文文件为权威版本。
- 每个版本在 `CHANGELOG.md` 与 `CHANGELOG.en.md` 各加一节，标题为 `## [<version>] - YYYY-MM-DD`。
- 每个版本在 `RELEASE_NOTES/v<version>.md` 写一份发行说明。
- 涉及安全边界的变化（凭据处理、泄露扫描、2FA）同步更新两份 SECURITY 文件。
- **发布者的隐私是硬要求**：文档与测试中不得出现真实 IP、真实端口、本机绝对路径、真实邮箱、真实账号名或本机用户名。示例一律用占位写法，如 `127.0.0.1:<port>`、`C:\Users\<user>`、`you@example.com`。

## 版本与发行 / Versioning and release

- 遵循语义化版本：修 bug → patch，兼容新增 → minor，破坏性变更 → major。
- **纯文档改动不升版本、不发版**——版本号只在有代码或打包内容变化时前进。
- 发行步骤：

  ```bash
  # 1) 改版本 + 两份 CHANGELOG + RELEASE_NOTES/v<version>.md
  npm test                 # 检查 → 测试 → 打包自检
  git commit -am "chore(release): <version>"
  git tag -a v<version> -m "<version>"
  git push origin main && git push origin v<version>
  ```

- 标签与 `package.json` 版本必须一致。已发布的版本不可覆盖，出问题只能发下一个补丁版本。
- npm 不允许覆盖已发布版本；unpublish 之后包名有 24 小时冷却期，期间无法重新发布。

## 提交与 PR / Commits and pull requests

- 一个 PR 只做一件事；不要顺手改无关文件、不要重排格式。
- 提交信息沿用仓库历史里的前缀：`feat:`、`fix:`、`chore:`、`docs:`；正文说明「为什么」。
- 不要提交 `.npmrc`、任何令牌、`.npm-cache/` 或本机路径。
- PR 描述里写清：改了什么、怎么验证（跑了哪几条命令、结果如何）。

## 行为准则 / Conduct

讨论对事不对人；评审意见只针对代码与文档。提交前自己跑一遍 `npm test`，并在 PR 里如实说明验证方式。

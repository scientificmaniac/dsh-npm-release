/**
 * 发布编排：把「命令退出码」换成「registry 状态」作为成功判据。
 *
 * 这个文件里最重要的一段是 {@link classifyPublishOutput} 与它的调用顺序。真实日志里，
 * 一次成功的 `npm publish` 是这样走的：
 *
 * ```text
 * PUT 401 ...pkga            ← 2FA 挑战；把它当失败会掐死整个流程
 * GET 202 .../-/v1/done ×8   ← 人在浏览器里确认
 * PUT 202 ...pkga            ← 已接受，不是已生效
 * Your package is being processed and may take a few minutes
 * + pkga@1.2.3               ← npm 自己的本地成功提示
 * ```
 *
 * 所以这里有三种「不是失败」必须分别处理：
 *
 * 1. **需要人授权**（401/EOTP）：拿到授权 URL，把决定权交出去；插件不代替人完成 2FA。
 * 2. **已接受待传播**（202 / `+ pkg@ver`）：进入轮询，等 `dist-tags` 变。
 * 3. **轮询超时**（not-visible）：返回 `not-visible`，**不是** `failed`，绝不能重发。
 *
 * @module dsh-npm-release/lib/publish-runner
 */

import { access } from 'node:fs/promises'
import path from 'node:path'
import { createRunEnv, locateNpm, runCommand } from './npm-run.js'
import { OFFICIAL_REGISTRY } from './credentials.js'
import { classifyPublishOutput, waitForVersion } from './registry.js'
import { reason } from './reason.js'

/** 发布结果的三种总体状态。 */
export const RESULT_OK = 'published'
export const RESULT_PENDING = 'not-visible'
export const RESULT_NEEDS_HUMAN = 'needs-authorization'
export const RESULT_FAILED = 'failed'

/**
 * 执行一次发布。
 *
 * @param options - 目录、registry、tag、access、代理、超时、是否 dry-run。
 * @returns 结构化发布结果。
 */
export async function runPublish({
  dir,
  name,
  version,
  registry = OFFICIAL_REGISTRY,
  tag = 'latest',
  accessLevel = 'public',
  proxy,
  token,
  dryRun = false,
  timeoutMs = 240000,
  waitTimeoutMs = 300000,
  waitIntervalMs = 10000,
  signal,
  onAuthRequired,
  onPoll,
} = {}) {
  const npm = await locateNpm()
  const runEnv = await createRunEnv({ cwd: dir, registry, proxy, token })

  try {
    if (dryRun) {
      const result = await runCommand({
        command: npm.command,
        args: buildPublishArgs(npm, { registry, tag, accessLevel, dryRun: true }),
        cwd: dir,
        env: runEnv.env,
        timeoutMs,
        signal,
      })
      if (result.spawnError !== undefined) {
        return {
          status: RESULT_FAILED,
          dryRun: true,
          command: 'npm publish --dry-run',
          exitCode: result.exitCode,
          classification: 'spawn-failed',
          failure: reason('spawn-failed', result.spawnError, '这是插件没能启动 npm，与包内容无关。'),
          notices: [],
          timedOut: false,
          output: undefined,
          elapsedMs: result.elapsedMs,
        }
      }
      const classification = classifyPublishOutput(result.combined, result.exitCode)
      return {
        status: result.exitCode === 0 ? RESULT_OK : RESULT_FAILED,
        dryRun: true,
        command: 'npm publish --dry-run',
        exitCode: result.exitCode,
        classification: classification.category,
        notices: classification.messages,
        timedOut: result.timedOut,
        output: tailOutput(result.combined),
        elapsedMs: result.elapsedMs,
      }
    }

    const result = await runCommand({
      command: npm.command,
      args: buildPublishArgs(npm, { registry, tag, accessLevel }),
      cwd: dir,
      env: runEnv.env,
      timeoutMs,
      signal,
    })

    // spawn 没起来就绝不能说「已接受」：那会让调用方去轮询 registry，
    // 然后得到一个「not-visible」，再被读成「稍等就好」。这里必须是明确失败。
    if (result.spawnError !== undefined) {
      return {
        status: RESULT_FAILED,
        failure: reason('spawn-failed', result.spawnError, '这是插件没能启动 npm，与包内容、凭据都无关。'),
        exitCode: result.exitCode,
        classification: 'spawn-failed',
        notices: [],
        elapsedMs: result.elapsedMs,
      }
    }

    const classification = classifyPublishOutput(result.combined, result.exitCode)

    // —— 情况 1：需要人授权 ——
    if (classification.needsHuman === true) {
      const authUrl = classification.webAuth?.url
      if (typeof onAuthRequired === 'function') {
        await onAuthRequired({ url: authUrl, doneUrl: classification.webAuth?.doneUrl, classification })
      }
      // 打码与「没抓到」是两件事。npm 在非 TTY 下会把 URL 输出成 ***，
      // 此时再说「没取到链接、重发会拿到新链接」是错的：重发多少次都是 ***。
      const redacted = classification.webAuth?.redacted === true
      return {
        status: RESULT_NEEDS_HUMAN,
        needsHuman: true,
        authorizationUrl: authUrl,
        redacted,
        prompt: classification.webAuth?.prompt,
        exitCode: result.exitCode,
        classification: classification.category,
        notices: classification.messages,
        output: tailOutput(result.combined),
        hint: redacted
          ? 'npm 在非 TTY 环境里把授权 URL 打码成了 ***，插件这边拿不到真链接，重发也不会变。'
            + '请在本机终端里手动执行一次 npm publish（那里有 TTY），用它给出的链接完成授权。'
          : '在浏览器里完成授权后，再用同一参数重新发布一次。旧的授权链接一次性失效，重发会拿到新链接。',
        elapsedMs: result.elapsedMs,
      }
    }

    // —— 情况 1.5：24 小时冷却期 ——
    //
    // 这不是失败，也不能重试：包名被 unpublish 之后，npm 强制等 24 小时才允许重新发布。
    // 它报的是 403，措辞与权限拒绝相似，所以必须比 forbidden 先判，
    // 否则会把人送去查 token scope 而白忙一场。
    if (classification.category === 'republish-cooldown') {
      return {
        status: RESULT_FAILED,
        name,
        version,
        cooldown: true,
        exitCode: result.exitCode,
        classification: classification.category,
        notices: classification.messages,
        failure: reason(
          'republish-cooldown',
          '包名被 unpublish 后有 24 小时冷却期，期间无法重新发布任何版本。',
          '这不是凭据或权限问题，重试也没用。等满 24 小时后重发即可；'
            + '或临时改用另一个包名（不推荐——包名一旦换掉，之前的工作就白费了）。',
        ),
        output: tailOutput(result.combined),
        elapsedMs: result.elapsedMs,
      }
    }

    // —— 情况 2：命令明确失败 ——
    // 只有在这几种分类下才可以断言「失败」，其余都要去 registry 求证。
    const definitelyFailed = ['bad-token', 'cache-unwritable', 'already-published', 'forbidden', 'not-logged-in', 'failed']
    if (definitelyFailed.includes(classification.category)) {
      return {
        status: RESULT_FAILED,
        failure: describePublishFailure(classification, result),
        exitCode: result.exitCode,
        classification: classification.category,
        notices: classification.messages,
        output: tailOutput(result.combined),
        elapsedMs: result.elapsedMs,
      }
    }

    // —— 情况 3：已接受或结论不明，一律以 registry 为准 ——
    const wait = await waitForVersion({
      registry,
      name,
      version,
      timeoutMs: waitTimeoutMs,
      intervalMs: waitIntervalMs,
      proxy,
      onPoll,
    })

    if (wait.ok === true) {
      return {
        status: RESULT_OK,
        version,
        name,
        // 这是唯一有资格说「发布成功」的分支：registry 的 versions 里真的出现了这一版。
        confirmedBy: 'registry dist-tags',
        exitCode: result.exitCode,
        classification: classification.category,
        notices: classification.messages,
        shasum: wait.shasum,
        integrity: wait.integrity,
        tarball: wait.tarball,
        latest: wait.latest,
        inDistTag: wait.inDistTag,
        output: tailOutput(result.combined),
        elapsedMs: result.elapsedMs + wait.elapsedMs,
      }
    }

    return {
      status: RESULT_PENDING,
      name,
      version,
      exitCode: result.exitCode,
      classification: classification.category,
      notices: classification.messages,
      wait,
      hint: wait.reason,
      output: tailOutput(result.combined),
      elapsedMs: result.elapsedMs + wait.elapsedMs,
    }
  } finally {
    await runEnv.cleanup()
  }
}

/**
 * 构造 publish 的参数。
 *
 * `--registry` 是必需的：全局 registry 常常指向镜像，而镜像是可以装包、
 * 不能发布的；漏掉它得到的错误与真实原因毫无关系。
 *
 * @param npm - {@link locateNpm} 的结果。
 * @param options - registry、tag、access、dry-run。
 * @returns 完整参数数组。
 */
function buildPublishArgs(npm, { registry, tag, accessLevel, dryRun }) {
  const args = [...npm.prefixArgs, 'publish', '--registry', registry]
  if (typeof tag === 'string' && tag.length > 0) args.push('--tag', tag)
  if (typeof accessLevel === 'string' && accessLevel.length > 0) args.push('--access', accessLevel)
  if (dryRun === true) args.push('--dry-run')
  return args
}

/**
 * 把分类结果翻成「发生了什么 + 怎么修」。
 * @param classification - {@link classifyPublishOutput} 的结果。
 * @param result - 命令结果。
 * @returns 原因对象。
 */
function describePublishFailure(classification, result) {
  const output = String(result.combined ?? '')
  const table = {
    'bad-token': reason(
      'bad-token',
      'npm 拒绝了 _authToken：它不是合法的 HTTP 头值。',
      '几乎总是凭据里带了 "Bearer " 前缀，或是 <新token> 这样的占位符。检查 ~/.npmrc 里 //registry.npmjs.org/:_authToken= 这一行的形态。',
    ),
    'cache-unwritable': reason(
      'cache-unwritable',
      'npm 缓存目录不可写（EPERM / _cacache），连日志都写不出来。',
      '把 npm_config_cache 指到工作区内的目录。本插件默认已经这样做；若仍失败，多半是包目录本身不可写。',
    ),
    'already-published': reason(
      'already-published',
      '这个版本已经存在于 registry。',
      'npm 不允许覆盖已发布版本，必须提升版本号后重发。不要尝试 unpublish，它有 24 小时窗口且风险更高。',
    ),
    forbidden: reason(
      'forbidden',
      'registry 拒绝了这次发布（403）。',
      describe403(output),
    ),
    'not-logged-in': reason(
      'not-logged-in',
      '当前 registry 上没有登录态。',
      '登录态按 registry host 存一条；镜像源不承载登录态。用官方源登录或提供 token。',
    ),
    failed: reason('failed', `npm publish 以退出码 ${result.exitCode} 结束。`, '查看下面保留的输出；若其中有授权链接，先完成授权再重发。'),
  }
  return table[classification.category] ?? table.failed
}

/**
 * 403 有三种完全不同的原因，文案一模一样。
 *
 * 这是本插件最想解决的一次误导：`You may not perform that action with these credentials`
 * 听起来像账号被封，实际最常见的原因是**这条 granular token 的包范围不含这个包**。
 *
 * @param output - npm 输出。
 * @returns 一段分诊说明。
 */
function describe403(output) {
  const scoped = /with these credentials/i.test(output)
  return [
    scoped
      ? '按可能性排序：(1) 这条 granular token 的包范围（scopes）不包含此包——最常见，且 npm 的文案完全没说这件事；'
        + '(2) token 只有只读权限；(3) 账号对这些包名没有发布权。'
      : '区分三种原因：token 的包级 scope、token 的读写权限、账号的发布权限。',
    '用 `npm token list` 看 scopes：空数组表示全部包，有值则必须包含目标包名。注意 token 的 name 是人起的名字，不是权限说明。',
  ].join('\n')
}

/**
 * 保留输出的尾部：失败时才需要原始行，而发布成功的完整清单有三四十行。
 * @param text - 输出。
 * @returns 截断后的文本。
 */
function tailOutput(text, limit = 4000) {
  const source = String(text ?? '').trim()
  if (source.length <= limit) return source
  return `…（前 ${source.length - limit} 字符已省略）\n${source.slice(-limit)}`
}

/**
 * 确认某个目录确实是一个可发布的包。
 * @param dir - 目录。
 * @returns true 表示有 package.json。
 */
export async function isPackageDir(dir) {
  try {
    await access(path.join(dir, 'package.json'))
    return true
  } catch {
    return false
  }
}

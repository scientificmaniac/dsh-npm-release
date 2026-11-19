/**
 * registry 查询与「发布到底成没成」的判定。
 *
 * 这个模块的全部存在理由是：**发布命令的输出不能用来判断发布是否成功。**
 * 真实数据里有这么一串，同一个 `npm publish` 进程里依次出现：
 *
 * ```text
 * http fetch PUT 401 https://registry.npmjs.org/pkg       ← 2FA 挑战，不是失败
 * http fetch GET 202 .../-/v1/done?sessionId=...  ×8       ← 人在浏览器里确认
 * http fetch PUT 202 https://registry.npmjs.org/pkg       ← 已接受，不是已生效
 * ```
 *
 * 401 之后必然跟着轮询，最后再 PUT 一次；把 401 当失败会把整个 2FA 流程掐死。
 * 202 只代表「已接受」，registry 的 `dist-tags` 往往还要两分钟才变。
 *
 * 于是：**判定成功的唯一标准是 dist-tags 真的变了。**
 * 而在它变之前，`npm install <pkg>@<ver>` 会得到 `ETARGET`，`npm view <pkg>@<ver>` 会得到
 * `E404`——两者都是「还没传播」，与「发布失败」是两件事。
 *
 * @module dsh-npm-release/lib/registry
 */

import { fetchWithFallback } from './http.js'

/** 终态：这一版真的出现在 registry 上了。 */
export const STATE_VISIBLE = 'visible'
/** 非终态：命令说已接受，但 registry 上还看不到。**不是失败。** */
export const STATE_NOT_VISIBLE = 'not-visible'
/** 非终态：包名在 registry 上不存在。对首次发布是正常状态。 */
export const STATE_PACKAGE_ABSENT = 'package-absent'
/**
 * 非终态：包名存在，但没有任何可发布版本。
 *
 * 这是 **unpublish 之后**的真实形态：`GET /<name>` 仍然返回 200，
 * 但响应里没有 `versions` 与 `dist-tags`，只剩 `time.unpublished` 记录。
 * 单看 HTTP 状态码会以为「包还在」；单看 `versions` 为空会以为「首次发布」；
 * 两者都不对——包名其实还占着（别人抢不到），但内容已经下架。
 */
export const STATE_UNPUBLISHED = 'unpublished'
/** 终态：查询本身出错（网络、鉴权），不能据此判断发布结果。 */
export const STATE_UNKNOWN = 'unknown'

/**
 * npm 为「正在进行的发布」预建的占位版本。
 *
 * 真实发布里撞到过一次，而且差点被误读成**包名被抢注**：
 * `dsh-npm-release` 刚 `PUT 202` 六秒后，registry 上就出现了唯一版本 `0.0.0-stage`，
 * `latest` 也指向它，描述是 `Temporary package placeholder for staged publishing`。
 * 看起来就像「别人先占了这个名字」。
 *
 * 实际上这是 npm 自己的 stub：它在接收某次发布时先登记一个占位符，
 * 真正的版本要等传播完成才出现在 `versions` 里，然后 `latest` 才转向它。
 * 所以看到 `-stage` 占位符的正确结论是「我的发布在路上」，不是「名字被抢了」。
 */
export const PLACEHOLDER_VERSION = '0.0.0-stage'

/**
 * 判断某个版本号是不是 npm 的发布占位符。
 *
 * @param version - 版本号。
 * @returns true 表示这是占位符，不能当成真实发布版本。
 */
export function isPlaceholderVersion(version) {
  if (typeof version !== 'string') return false
  return version === PLACEHOLDER_VERSION || /^0\.0\.0-stage(?:\.|$)/.test(version)
}

/**
 * 从版本列表里挑出真实版本（去掉占位符）。
 *
 * @param versions - registry 返回的版本列表。
 * @returns 真实版本列表。
 */
export function realVersions(versions) {
  return (Array.isArray(versions) ? versions : []).filter((version) => isPlaceholderVersion(version) !== true)
}

/**
 * 取出一个包在 registry 上的当前状态。
 *
 * @param options - registry、包名、超时与代理。
 * @returns `{ state, latest, versions, doc }`。
 */
export async function fetchPackageState({ registry, name, timeoutMs = 20000, proxy } = {}) {
  const url = `${trimSlash(registry)}/${encodeURIComponent(name).replace(/^%40/, '@')}`
  const response = await fetchWithFallback(url, {
    timeoutMs,
    proxy,
    headers: {
      // 绕开 CDN：真实数据里传播延迟可达两分钟，命中缓存会看不出来。
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      accept: 'application/json',
    },
  })
  if (response.status === 404) {
    return { state: STATE_PACKAGE_ABSENT, latest: undefined, versions: [], doc: undefined, url }
  }
  if (!response.ok) {
    return {
      state: STATE_UNKNOWN,
      latest: undefined,
      versions: [],
      doc: undefined,
      url,
      error: `registry 返回 HTTP ${response.status}`,
    }
  }
  let doc
  try {
    doc = JSON.parse(response.body)
  } catch {
    return { state: STATE_UNKNOWN, latest: undefined, versions: [], doc: undefined, url, error: 'registry 返回的不是合法 JSON' }
  }
  return { ...interpretPackageDoc(doc), url }
}

/**
 * 把 registry 返回的包文档解读成状态。
 *
 * 抽成纯函数是为了**能被测试真正覆盖**：之前这段判定写在
 * {@link fetchPackageState} 里面，测试只能把 `state:'unpublished'` 手工喂给渲染层，
 * 从未验证「真实 registry 文档 → 状态」这一步。实测把 STATE_UNPUBLISHED 的判定整个删掉，
 * 全部测试仍然通过——等于这个特性没有任何保护。
 *
 * @param doc - registry 的 `GET /<name>` 响应体。
 * @returns 结构化状态，不含 url。
 */
export function interpretPackageDoc(doc) {
  const distTags = doc?.['dist-tags'] ?? {}
  const allVersions = doc?.versions !== null && typeof doc?.versions === 'object' ? Object.keys(doc.versions) : []
  const real = realVersions(allVersions)
  // unpublish 之后 registry 仍返回 200，但 versions 与 dist-tags 都被抽空，
  // 只在 time.unpublished 里留一条记录。这个状态既不是「首次发布」也不是「包还在」。
  const unpublishedAt = doc?.time?.unpublished?.time
  if (allVersions.length === 0 && typeof unpublishedAt === 'string') {
    return {
      state: STATE_UNPUBLISHED,
      latest: undefined,
      distTags: {},
      versions: [],
      realVersions: [],
      placeholderOnly: false,
      unpublishedAt,
      unpublishedVersions: Array.isArray(doc?.time?.unpublished?.versions) ? doc.time.unpublished.versions : [],
      doc,
    }
  }
  return {
    state: STATE_VISIBLE,
    latest: distTags.latest,
    distTags,
    versions: allVersions,
    // 真实版本（去掉 0.0.0-stage 占位符）。判断「发布了没有」只能用这个。
    realVersions: real,
    // 只有一个占位符时，latest 指向它属于 npm 的中间状态，
    // 不能说成「已有一个别人的版本」。
    placeholderOnly: allVersions.length > 0 && real.length === 0,
    doc,
  }
}

/**
 * 判断某个具体版本是否已经在 registry 上可见。
 *
 * 这里刻意不只看 `dist-tags`：一次发布可能带非 `latest` 的 tag，
 * 所以两个条件分开返回，判定成功的门由调用方定义（默认是「版本在 versions 里」）。
 *
 * @param state - {@link fetchPackageState} 的结果。
 * @param version - 目标版本。
 * @returns `{ visible, inDistTag, latest, shasum, integrity }`。
 */
export function inspectVersion(state, version) {
  if (state.state !== STATE_VISIBLE) {
    return { visible: false, inDistTag: false, latest: undefined, shasum: undefined, integrity: undefined }
  }
  const entry = state.doc?.versions?.[version]
  const inDistTag = Object.values(state.distTags ?? {}).includes(version)
  return {
    visible: entry !== undefined,
    inDistTag,
    latest: state.latest ?? state.distTags?.latest,
    shasum: entry?.dist?.shasum,
    integrity: entry?.dist?.integrity,
    tarball: entry?.dist?.tarball,
    publishedAt: state.doc?.time?.[version],
  }
}

/**
 * 轮询 registry，直到目标版本可见或超时。
 *
 * **超时不等于失败**，返回 `not-visible` 而不是 `failed`：这时正确的动作是继续等或稍后再查，
 * 绝不是重发——重发会撞 `E409` 或产生不可预期的状态。
 *
 * @param options - registry、包名、版本、轮询参数、代理。
 * @returns 轮询结论。
 */
export async function waitForVersion({
  registry,
  name,
  version,
  timeoutMs = 300000,
  intervalMs = 10000,
  proxy,
  onPoll,
} = {}) {
  const deadline = Date.now() + timeoutMs
  const attempts = []
  let last
  while (Date.now() < deadline) {
    const state = await fetchPackageState({ registry, name, proxy })
    const detail = inspectVersion(state, version)
    last = { state, detail }
    attempts.push({
      at: new Date().toISOString(),
      state: state.state,
      latest: state.latest,
      visible: detail.visible,
      versionCount: state.versions.length,
    })
    if (onPoll !== undefined) onPoll({ state, detail, attempts })
    if (detail.visible) {
      return {
        state: 'visible',
        ok: true,
        ...detail,
        attempts,
        elapsedMs: timeoutMs - (deadline - Date.now()),
      }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(intervalMs, remaining))
  }
  return {
    state: 'not-visible',
    ok: false,
    // 明确写出「这不是失败」，让调用方和模型都不会去重发。
    reason: 'registry 上还没有这个版本。发布命令报告成功与 registry 生效之间通常有几十秒到两分钟的传播时间；此时重发会撞 E409。',
    latest: last?.state?.latest,
    attempts,
    elapsedMs: timeoutMs,
  }
}

/**
 * 把 npm 命令的输出（含 stderr）解析成发布结果分类。
 *
 * 这里做的是**分类**，不是判断成败：把五种「不是失败」的状态分别认出来。
 *
 * @param output - 合并后的 stdout + stderr。
 * @param exitCode - 进程退出码。
 * @returns `{ category, messages, webAuth }`。
 */
export function classifyPublishOutput(output, exitCode) {
  const text = String(output ?? '')
  const messages = []
  const webAuth = extractWebAuth(text)

  // 401 是 web auth 的第一步：npm 先被挑战，再去轮询 done。这不是失败。
  const put401 = /http fetch PUT 401\b/.test(text) || /\bPUT 401\b/.test(text)
  const put202 = /http fetch PUT 202\b/.test(text) || /\bPUT 202\b/.test(text)
  const donePolls = (text.match(/GET 20[02] [^\n]*\/-\/v1\/done/g) ?? []).length
  const doneExpired = /GET 404 [^\n]*\/-\/v1\/done/.test(text)
  const processing = /Your package is being processed/.test(text)
  // `+ pkg@1.2.3` 是 npm 的本地成功提示，仍不代表 registry 已生效。
  const plusLine = /^\+\s+\S+@\S+/m.test(text)
  const eotp = /npm (?:error|ERR!) code EOTP/.test(text) || /This operation requires a one-time password/.test(text)
  const e409 = /E409|409 Conflict|cannot publish over|previously published/i.test(text)
  const e403 = /E403|403 Forbidden/.test(text)
  const e404 = /E404|404 Not Found/.test(text)
  const eneedauth = /ENEEDAUTH/.test(text) || /need auth/.test(text)
  const eperm = /EPERM/.test(text) && /_cacache/.test(text)
  const headerValue = /is not a legal HTTP header value/.test(text)
  const etarget = /ETARGET|No matching version found/.test(text)
  // unpublish 之后 24 小时内不能重发同名包。这是 npm 的硬性等待期，
  // 与权限毫无关系——但它报的是 403，措辞又和权限拒绝一样，极易被归进 forbidden，
  // 于是人跑去查 token scope，而真正该做的是等。
  const republishCooldown = /cannot be republished until \d+ hours? ha(?:s|ve) passed/i.test(text)

  let category
  if (eotp) {
    // EOTP 是「要求一次性验证码」。它比任何链接都更具体，必须先判。
    category = 'needs-otp'
    messages.push('npm 要求一次性验证码。这条路径无法在非交互环境完成，需要人。')
  } else if (plusLine || processing || put202) {
    // `+ pkg@ver`、「正在处理」、以及 PUT 202 都是**已完成提交**的信号。
    // 即使日志里出现过授权 URL（2FA 流程会打印它），此刻也不该再要求人做事——
    // 一次成功的发布日志里同样有这些行。
    category = 'accepted'
    messages.push('npm 报告已提交。这只说明请求被接受，是否生效要看 registry 的 dist-tags。')
  } else if (headerValue) {
    category = 'bad-token'
    messages.push('`_authToken` 不是合法的 HTTP 头值——几乎总是凭据里带了 "Bearer " 前缀或是占位符。')
  } else if (eperm) {
    category = 'cache-unwritable'
    messages.push('npm 缓存目录不可写（EPERM / _cacache）。把 npm_config_cache 指到工作区内再试。')
  } else if (e409) {
    category = 'already-published'
    messages.push('这个版本已经存在。npm 不允许覆盖已发布版本，必须提升版本号。')
  } else if (republishCooldown) {
    // 必须排在 e403 之前：这条消息里同时含 403，先判权限就会把它归成 forbidden，
    // 把人送去查 token scope，而真正需要的是等够 24 小时。
    category = 'republish-cooldown'
    messages.push('包名被 unpublish 后有 24 小时冷却期，期间任何版本都无法重新发布。'
      + '这是 npm 的硬性限制，与凭据、权限无关，等够时间即可。')
  } else if (e403) {
    category = 'forbidden'
    messages.push('权限被拒。先分三种原因：token 的 package scope 不含这个包、token 没有写权限、账号没有该 scope 的发布权。')
  } else if (eneedauth) {
    category = 'not-logged-in'
    messages.push('没有登录态。登录态是按 registry host 存一条的，镜像源上永远不会有。')
  } else if (etarget) {
    category = 'not-propagated'
    messages.push('这个版本还看不到——传播未完成，不是发布失败。')
  } else if (webAuth !== undefined && exitCode !== 0 && !put202) {
    // npm 在非 TTY 下遇到 OTP 挑战会带着授权 URL 直接退出。
    // 这是「需要人」，不是失败——但必须排除前面那些「已提交」的情形。
    category = 'needs-authorization'
    messages.push('npm 要求 2FA 授权后重新提交。授权 URL 已取到，需要人在浏览器里确认。')
  } else if (exitCode === 0) {
    // 退出码 0 只说明命令完成；真正的结论要等 dist-tags。
    category = 'accepted'
    messages.push('npm 命令成功结束。这只说明请求被接受，是否生效要看 registry 的 dist-tags。')
  } else {
    category = 'failed'
  }

  // 401 紧跟轮询是**完整且正常**的 web auth 流程：command 成功的日志里也会有它，
  // 所以这里只补说明，不改分类。
  if (put401 && donePolls > 0) {
    messages.push(`日志里有 PUT 401 紧跟 ${donePolls} 次 /-/v1/done 轮询：这是完整的 web auth 流程，不是失败。`)
  }
  if (put202) messages.push('日志里有 PUT 202：已接受，等待传播。')
  if (processing) messages.push('npm 自己提示「正在处理，可能需要几分钟才能用」。')
  if (plusLine) messages.push('`+ pkg@ver` 是 npm 的本地成功提示，仍不是 registry 生效的证据。')
  if (doneExpired) messages.push('轮询出现过 404：授权会话已过期，需要重新发起，旧链接不可复用。')

  return { category, exitCode, messages, webAuth, needsHuman: category === 'needs-authorization' || category === 'needs-otp' }
}

/**
 * 从 npm 输出里提取 web auth 的链接。
 *
 * 需要同时认三类文案，因为它们来自不同版本的 npm 与不同阶段：
 *
 * - `Login at:` + `https://www.npmjs.com/login?next=/login/cli/<id>`（npm login）
 * - `Authenticate your account at:` + `https://www.npmjs.com/auth/cli/<id>`（publish 的 OTP 挑战）
 * - `Open this URL in your browser to authenticate:`（另一条 EOTP 文案）
 *
 * **第四种情况必须单独处理：链接被打码了。**
 * npm 在**非 TTY**（也就是插件只能用的 `stdio: pipe`）下，会把授权 URL 本身渲染成
 * `https://www.npmjs.com/auth/cli/***`，`/-/v1/done?authId=***` 同理。
 * 于是 `[0-9a-f-]+` 匹配不到，旧实现直接返回 undefined，工具只能说
 * 「这次没有取到授权链接」——把「npm 主动打码」讲成了「插件没抓到」，
 * 并让人以为只要再发一次就会拿到链接。实际上再发多少次都是 `***`。
 *
 * 现在把打码单独认出来，返回 `redacted: true`，让调用方能给出正确的下一步：
 * 去真实终端里跑，那里有 TTY。
 *
 * @param text - npm 输出。
 * @returns `{ url, doneUrl, prompt, redacted }`；完全没有授权迹象时返回 undefined。
 */
export function extractWebAuth(text) {
  const source = String(text ?? '')
  const urlPatterns = [
    /(https:\/\/www\.npmjs\.com\/login\?next=[^\s"'<>]+)/,
    /(https:\/\/www\.npmjs\.com\/auth\/cli\/[0-9a-f-]+)/i,
    /(https:\/\/[^\s"'<>]*\/auth\/cli\/[0-9a-f-]+)/i,
  ]
  let url
  for (const pattern of urlPatterns) {
    const match = pattern.exec(source)
    if (match !== null) {
      url = match[1]
      break
    }
  }
  let doneUrl = /(https?:\/\/[^\s"'<>]*\/-\/v1\/done\?[^\s"'<>]+)/.exec(source)?.[1]

  // 打码形态的判定必须在**已经提取出的 URL** 上做，而不是在原文里找固定前缀。
  //
  // 曾经只在原文里找 `/auth/cli/***`，于是 `npm login` 那条
  // `https://www.npmjs.com/login?next=/login/cli/***` 逃过了判定：
  // 第一条模式用 `[^\s"'<>]+` 把含 `***` 的串整个吃下，返回了一个「真链接」，
  // 用户拿着这个无效 URL 去浏览器，插件还在说「在浏览器里打开它」。
  // 这比原始 bug 更糟——原始 bug 至少说的是「没取到链接」。
  //
  // 正确的判据只有一个：URL 里出现 *** 就说明 npm 打了码，无论它长什么样。
  const urlRedacted = typeof url === 'string' && url.includes('***')
  const doneRedacted = typeof doneUrl === 'string' && doneUrl.includes('***')
  const redacted = urlRedacted || doneRedacted
  // 打码的 URL 不能当真链接交出去，否则等于把无效链接伪装成可用链接。
  if (urlRedacted) url = undefined
  if (doneRedacted) doneUrl = undefined

  if (url === undefined && doneUrl === undefined && redacted !== true) return undefined
  return {
    url,
    doneUrl,
    redacted,
    prompt: /Press ENTER to open in the browser/.test(source) ? 'Press ENTER' : undefined,
  }
}

/**
 * 从 npm 输出里提取发布后的版本元数据（体积、文件数、shasum、integrity）。
 *
 * 这些行都在 **stderr**，且一次发布有三四十行；工具结果里只放这几项，
 * 原始输出只在失败时保留。
 *
 * @param text - npm 输出。
 * @returns 结构化摘要。
 */
export function parsePublishNotice(text) {
  const source = String(text ?? '')
  const read = (label) => {
    const match = new RegExp(`npm notice ${label}:\\s*(.+)$`, 'm').exec(source)
    return match === null ? undefined : match[1].trim()
  }
  const totalFiles = read('total files')
  const size = read('package size')
  const unpacked = read('unpacked size')
  return {
    name: read('name'),
    version: read('version'),
    filename: read('filename'),
    sizeText: size,
    unpackedText: unpacked,
    sizeBytes: parseSize(size),
    unpackedBytes: parseSize(unpacked),
    shasum: read('shasum'),
    integrity: read('integrity'),
    fileCount: totalFiles === undefined ? undefined : Number.parseInt(totalFiles, 10),
    publishingTo: (() => {
      const match = /npm notice Publishing to (\S+) with tag (\S+) and (\S+) access/.exec(source)
      if (match === null) return undefined
      return { registry: match[1], tag: match[2], access: match[3] }
    })(),
    // 仅供参考的可读文件清单；数量可能三四十项，调用方自己决定要不要展开。
    contents: [...source.matchAll(/^npm notice \d+(?:\.\d+)?[kMG]?B (.+)$/gm)].map((match) => match[1].trim()),
  }
}

/**
 * 把 `1.5 MB` 这类文本转成字节数。
 * @param text - 体积文本。
 * @returns 字节数；无法解析时返回 undefined。
 */
export function parseSize(text) {
  if (typeof text !== 'string') return undefined
  const match = /^([\d.]+)\s*(B|kB|MB|GB)$/i.exec(text.trim())
  if (match === null) return undefined
  const value = Number.parseFloat(match[1])
  const unit = match[2].toLowerCase()
  const scale = unit === 'b' ? 1 : unit === 'kb' ? 1024 : unit === 'mb' ? 1024 * 1024 : 1024 * 1024 * 1024
  return Math.round(value * scale)
}

/**
 * 去掉 URL 末尾的斜杠。
 * @param value - URL。
 * @returns 结果。
 */
function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '')
}

/**
 * 等待若干毫秒。
 * @param ms - 毫秒。
 * @returns Promise。
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

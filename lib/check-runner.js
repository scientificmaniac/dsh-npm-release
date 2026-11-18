/**
 * 九项发布前检查。
 *
 * 每一项都对应一次真实浪费，所以这里的顺序也是「先便宜的、先能确定原因的」：
 *
 * | # | 检查 | 不检查的代价 |
 * |---|---|---|
 * | 1 | 版本与元数据 | 已发布版本不能覆盖，只能提版本重发 |
 * | 2 | 凭据形态 | `Bearer <新token>` 报的是「非法 HTTP 头值」，把人引向网络问题 |
 * | 3 | 凭据包级 scope | `403 ... these credentials` 完全指错方向 |
 * | 4 | 注册源 | 镜像源发布必然失败，且报错与真实原因无关 |
 * | 5 | 代理可用性 | 端口在听、TLS 失败、请求静默超时 |
 * | 6 | 缓存可写 | 沙箱下连 `npm pack --dry-run` 都 EPERM，日志也写不出来 |
 * | 7 | 打包内容 | 该在的不在（`files` 漏项），不该在的在（宣传图进包） |
 * | 8 | registry 上是否已被占用 | 抢到别人的包名才发现 |
 * | 9 | 2FA 必要性 | **查不到**，只能由发布时的响应说明 |
 *
 * @module dsh-npm-release/lib/check-runner
 */

import { access, constants } from 'node:fs/promises'
import path from 'node:path'
import {
  OFFICIAL_REGISTRY,
  diagnoseCredentials,
  fetchAccountAuth,
  inspectTokenScopes,
  isMirrorRegistry,
} from './credentials.js'
import { probeProxy, resolveProxy } from './proxy.js'
import { checkPacklist, checkVersion, formatBytes, readManifest, summarizePackList } from './package-check.js'
import { fetchPackageState } from './registry.js'
import { createRunEnv, locateNpm, readUserTokenFor, runCommand } from './npm-run.js'
import { reason, sortFindings } from './reason.js'

/**
 * 取出可用于目标 registry 的 token：优先用户 `.npmrc`。
 *
 * 这个 helper 的存在本身就是一次修正：插件早期版本在隔离 userconfig 时没有继承 token，
 * 导致所有需要凭据的查询都变成 401，进而产生一连串错误结论。
 *
 * @param registry - 目标 registry。
 * @returns token 或 undefined。
 */
async function resolveTokenForRegistry(registry) {
  return await readUserTokenFor(registry)
}

/**
 * 执行全部发布前检查。
 *
 * @param options - 包目录、registry、代理覆盖、各类超时、跳过的检查。
 * @returns 结构化检查报告。
 */
export async function runChecks({
  dir,
  registry = OFFICIAL_REGISTRY,
  proxy: proxyOverride,
  proxyProbeUrl,
  timeoutMs = 60000,
  verifyPackageName = true,
  skip = [],
} = {}) {
  const skipSet = new Set(Array.isArray(skip) ? skip : [])
  const findings = []
  const facts = {}
  const startedAt = Date.now()

  // —— 1. 清单与版本 ——
  let manifest
  let manifestError
  try {
    const result = await readManifest(dir)
    manifest = result.manifest
    facts.manifestPath = result.file
  } catch (error) {
    manifestError = reason('manifest', error.message, '确认传入的是包含 package.json 的包目录。')
    findings.push({ level: 'error', code: 'manifest-unreadable', message: manifestError.message })
  }

  const name = typeof manifest?.name === 'string' ? manifest.name : undefined
  facts.name = name
  facts.requestedRegistry = registry
  facts.registryIsMirror = isMirrorRegistry(registry)

  if (manifest !== undefined) {
    const versionCheck = await checkVersion({ dir, manifest })
    facts.version = versionCheck.version
    findings.push(...versionCheck.findings)

    const packCheck = await checkPacklist({ dir, manifest })
    findings.push(...packCheck.findings)

    // git tag 是否已经被这个版本占用——回退时四处都要清，这里先看两处。
    const tagState = await inspectGitTag({ dir, version: versionCheck.version })
    facts.gitTag = tagState
    if (tagState?.exists === true) {
      findings.push({
        level: 'warn',
        code: 'git-tag-exists',
        message: `本地已存在 tag ${tagState.tag}。若本次是新版本，说明版本号没提升；若只是补发同一版本，忽略。`,
      })
    }
  }

  // —— 4. 注册源 ——
  if (facts.registryIsMirror) {
    findings.push({
      level: 'error',
      code: 'registry-mirror',
      message: `${registry} 是镜像源，不能用于发布。镜像适合装包，不承载登录态。`,
    })
  }

  // —— 2/3. 凭据 ——
  if (!skipSet.has('credentials')) {
    const credentials = await diagnoseCredentials({ registry, packageName: name })
    facts.credentials = credentials
    findings.push(...credentials.findings.map((entry) => ({ level: entry.level, code: entry.code, message: entry.message })))

    // 3. 包级 scope：只有真能跑 npm 时才查，否则就是猜。
    if (summarizeTokenPresence(credentials)) {
      const scopeReport = await inspectScopes({ dir, registry, packageName: name, proxy: proxyOverride })
      facts.tokenScopes = scopeReport
      if (scopeReport?.available !== true) {
        // 读不到 token 列表 ≠ token 不能发布。这一区分很重要：granular token
        // 只给 package:write 时读列表就 401，但它照样能发。
        findings.push({
          level: 'info',
          code: 'scopes-unknown',
          message: scopeReport?.error ?? '无法读取 token 的权限范围。',
        })
      } else if (scopeReport.blockingAll !== undefined && name !== undefined) {
        // 只有「每一条可写 token 的 scope 都不含这个包」才是必然 403。
        // 列表里出现别的包的 token（例如只授权了 dsh-ssh-vault）本身不是问题。
        findings.push({
          level: 'error',
          code: 'token-scope',
          message: `账号下 ${scopeReport.tokens.filter((token) => token.canWrite).length} 条可写 token，没有一条的包范围包含 ${name}`
            + `（例如「${scopeReport.blockingAll.name ?? '未命名'}」的 scope 是 ${formatScopes(scopeReport.blockingAll)}）。`
            + '这正是 `403 You may not perform that action with these credentials` 的真实原因。',
        })
      } else if (scopeReport.covering === undefined && name !== undefined) {
        findings.push({
          level: 'warn',
          code: 'token-scope-unknown',
          message: `token 列表里没有可写 token，无法核对 ${name} 的包范围。发布是否成功只能看实际响应。`,
        })
      } else if (scopeReport.covering !== undefined && scopeReport.covering.coversAllPackages !== true) {
        // 有覆盖，但覆盖它的那条不是「全包」token——本机到底用哪一条无法从打码列表反推，
        // 所以只能说「存在一条能覆盖的」，不能说「你正在用的就是它」。
        findings.push({
          level: 'info',
          code: 'token-scope-partial',
          message: `有一条可写 token「${scopeReport.covering.name ?? '未命名'}」的包范围包含 ${name}（全包 token 也可能存在）。`
            + '`.npmrc` 里只存了一条凭据且列表接口打码，无法反推本机正在用哪一条；发布时若 403 再回来核对。',
        })
      }
    }
  }

  // —— 5. 代理 ——
  if (!skipSet.has('proxy')) {
    const resolved = await resolveProxy({})
    const proxy = proxyOverride ?? resolved.url
    const probe = await probeProxy({ url: proxyProbeUrl, proxy, timeoutMs: Math.min(timeoutMs, 20000) })
    facts.proxy = {
      url: proxy,
      source: proxyOverride !== undefined ? 'argument' : resolved.source,
      system: resolved.system,
      probe,
    }
    if (probe.ok !== true) {
      findings.push({
        level: 'error',
        code: `proxy-${probe.category}`,
        message: buildProxyMessage(proxy, resolved, probe),
      })
    } else if (probe.flaky === true) {
      // 重试后才通，说明网络不稳。不当成错误，但必须说出来——
      // 否则下一次发布超时会被当成插件的问题。
      findings.push({
        level: 'warn',
        code: 'proxy-flaky',
        message: `网络在重试后才连通（第 ${probe.attempts.length} 次尝试成功，共 ${probe.elapsedMs} ms）。代理可能不稳，发布时若超时先怀疑它，不要重发。`,
      })
    }
    if (resolved.system?.enabled === false && resolved.system?.server !== undefined) {
      findings.push({
        level: 'warn',
        code: 'system-proxy-off',
        message: `系统代理地址是 ${resolved.system.server}，但 ProxyEnable=0（开关关着）。只看配置会以为代理配好了。`,
      })
    }
  }

  // —— 6. 缓存可写 ——
  if (!skipSet.has('cache')) {
    const cacheDir = path.join(dir, '.npm-cache')
    const writable = await canWrite(cacheDir)
    facts.cache = { dir: cacheDir, writable }
    // 目录不存在是正常的（第一次运行会创建）；父目录不可写才是问题。
    const parentWritable = await canWrite(dir)
    if (parentWritable !== true) {
      findings.push({
        level: 'error',
        code: 'cache-unwritable',
        message: `包目录不可写，无法把 npm 缓存放到 ${cacheDir}。沙箱下的用户级缓存会 EPERM，连 npm 日志都落不了盘。`,
      })
    } else if (writable === false) {
      findings.push({
        level: 'warn',
        code: 'cache-dir-unwritable',
        message: `${cacheDir} 已存在但不可写；发布时会改用临时目录缓存。`,
      })
    }
  }

  // —— 7. 真实打包清单 ——
  if (!skipSet.has('pack')) {
    const packResult = await previewPack({ dir, registry, proxy: proxyOverride, timeoutMs })
    facts.pack = packResult.summary
    if (packResult.error !== undefined) {
      findings.push({
        level: 'error',
        code: 'pack-failed',
        message: `npm pack --dry-run 失败：${packResult.error}`,
      })
    } else if (packResult.summary !== undefined) {
      const summary = packResult.summary
      if (summary.missing !== undefined && summary.missing.length > 0) {
        findings.push({
          level: 'error',
          code: 'pack-missing',
          message: `npm 报告打包缺文件：${summary.missing.join(', ')}`,
        })
      }
      if (summary.heavy !== undefined && summary.heavy.length > 0) {
        const top = summary.heavy[0]
        findings.push({
          level: 'warn',
          code: 'pack-heavy',
          message: `包里有 ${summary.heavy.length} 个超过 ${formatBytes(256 * 1024)} 的文件，最大的是 ${top.path}（${formatBytes(top.size)}）。`
            + 'README 里的图片可以从仓库加载，放进包只会让每次安装都多下一份。',
        })
      }
      if (typeof summary.size === 'number' && summary.size > 5 * 1024 * 1024) {
        findings.push({
          level: 'warn',
          code: 'pack-large',
          message: `打包后 ${formatBytes(summary.size)}，超过 5 MB 的包会明显拖慢安装。`,
        })
      }
    }
  }

  // —— 8. registry 上的占用情况 ——
  if (verifyPackageName && name !== undefined && !skipSet.has('registry')) {
    const state = await fetchPackageState({ registry, name, proxy: proxyOverride, timeoutMs: Math.min(timeoutMs, 20000) })
    facts.registry = {
      state: state.state,
      latest: state.latest,
      versions: state.versions.slice(-10),
      versionCount: state.versions.length,
    }
    if (state.state === 'unknown') {
      findings.push({ level: 'warn', code: 'registry-unknown', message: `无法查询 registry：${state.error ?? '未知原因'}` })
    } else if (state.state === 'package-absent') {
      findings.push({
        level: 'info',
        code: 'registry-new-package',
        message: `${name} 在 registry 上还不存在——这是首次发布。确认这个名字你确实要占用。`,
      })
    } else if (facts.version !== undefined) {
      if (state.versions.includes(facts.version)) {
        findings.push({
          level: 'error',
          code: 'version-already-published',
          message: `${name}@${facts.version} 已经发布过了。npm 不允许覆盖，必须提升版本号。`,
        })
      } else if (state.latest !== undefined && compareVersions(facts.version, state.latest) < 0) {
        findings.push({
          level: 'warn',
          code: 'version-older-than-latest',
          message: `待发布版本 ${facts.version} 低于 registry 上的 latest ${state.latest}。发布不会改为 latest，但仍可能不是你想要的。`,
        })
      }
    }
  }

  // —— 9. 账号认证状态（2FA） ——
  //
  // 这条曾经被误判成「查不到」：当时隔离了 userconfig 却没继承 token，请求裸奔拿到 401，
  // 于是被读成「granular token 没有读用户资料的权限」。带上凭据后这个接口返回 200，
  // 响应里直接有 tfa.mode。所以现在如实去查，查不到时也要说清是哪一种查不到。
  if (!skipSet.has('auth')) {
    const token = await resolveTokenForRegistry(registry)
    const auth = await fetchAccountAuth({ registry, token, proxy: proxyOverride })
    facts.account = auth
    if (auth.ok === true) {
      findings.push({
        level: 'info',
        code: 'tfa-mode',
        message: `账号 ${auth.username ?? '(未知)'} 的 2FA 模式：${auth.mode ?? '未启用'}。${auth.implication}`,
      })
    } else {
      findings.push({
        level: 'info',
        code: 'tfa-unreadable',
        message: auth.error ?? '无法查询账号认证状态。',
      })
    }
  }

  const sorted = sortFindings(findings)
  return {
    ok: sorted.every((entry) => entry.level !== 'error'),
    name,
    version: facts.version,
    registry,
    dir,
    findings: sorted,
    facts,
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * 用 `npm pack --dry-run --json` 拿到真实打包清单。
 *
 * @param options - 目录、registry、代理、超时。
 * @returns `{ summary, error }`。
 */
export async function previewPack({ dir, registry = OFFICIAL_REGISTRY, proxy, timeoutMs = 120000 } = {}) {
  const npm = await locateNpm()
  const runEnv = await createRunEnv({ cwd: dir, registry, proxy })
  try {
    const result = await runCommand({
      command: npm.command,
      args: [...npm.prefixArgs, 'pack', '--dry-run', '--json', '--registry', registry],
      cwd: dir,
      env: runEnv.env,
      timeoutMs,
    })
    if (result.timedOut) return { error: `npm pack 在 ${timeoutMs} ms 内没有结束` }
    if (result.spawnError !== undefined) return { error: result.spawnError }
    // npm pack --json 把 JSON 打到 stdout，notice 打到 stderr。
    const payload = extractJson(result.stdout)
    if (payload === undefined) {
      return { error: `npm pack 没有输出可解析的 JSON（exit ${result.exitCode}）：${tail(result.combined, 800)}` }
    }
    return { summary: summarizePackList(payload), raw: result }
  } finally {
    await runEnv.cleanup()
  }
}

/**
 * 读 `npm token list --json` 并判断是否覆盖目标包。
 *
 * @param options - 目录、registry、包名、代理。
 * @returns {@link inspectTokenScopes} 的结果，或带 `error` 的对象。
 */
async function inspectScopes({ dir, registry, packageName, proxy }) {
  const npm = await locateNpm()
  const runEnv = await createRunEnv({ cwd: dir, registry, proxy })
  try {
    const result = await runCommand({
      command: npm.command,
      args: [...npm.prefixArgs, 'token', 'list', '--json', '--registry', registry],
      cwd: dir,
      env: runEnv.env,
      timeoutMs: 60000,
    })
    if (result.timedOut) return { error: 'npm token list 超时' }
    if (result.spawnError !== undefined) return { error: result.spawnError }
    const payload = extractJson(result.stdout)
    if (payload === undefined) {
      return { error: `npm token list 没有输出 JSON（exit ${result.exitCode}）：${tail(result.combined, 400)}` }
    }
    const report = inspectTokenScopes(payload, packageName)
    // 把「这次到底有没有带凭据」一并交出去：读不到 token 列表时，
    // 「没带凭据」与「凭据没权限」是两种完全不同的原因，不能混为一谈。
    return { ...report, tokenAttached: runEnv.hasToken === true, tokenSource: runEnv.tokenSource }
  } finally {
    await runEnv.cleanup()
  }
}

/**
 * 检查本地是否已有同名 git tag。
 *
 * 只看本地：远端要联网，而这一步的目的是「发布前发现版本号没动」，
 * 本地 tag 已经足够给出信号。失败时不报错——没有 git 也能发布。
 *
 * @param options - 目录与版本。
 * @returns `{ tag, exists }`；不是 git 仓库时返回 undefined。
 */
async function inspectGitTag({ dir, version }) {
  if (typeof version !== 'string') return undefined
  const result = await runCommand({
    command: 'git',
    args: ['tag', '--list', `v${version}`, `v${version}^0`],
    cwd: dir,
    env: process.env,
    timeoutMs: 15000,
  })
  if (result.exitCode !== 0) return undefined
  const tag = `v${version}`
  return { tag, exists: result.stdout.split(/\r?\n/).some((line) => line.trim() === tag) }
}

/**
 * 凭据是否存在且形态合法——只有这时查 scope 才有意义。
 * @param credentials - 诊断结果。
 * @returns true 表示有可用凭据。
 */
function summarizeTokenPresence(credentials) {
  return Array.isArray(credentials?.tokenReports) && credentials.tokenReports.some((entry) => entry.ok === true)
}

/**
 * 把 blockng token 的 scope 渲染成一句人话。
 * @param token - token 记录。
 * @returns 文本。
 */
function formatScopes(token) {
  if (token.scopes === undefined || token.scopes.length === 0) return '（未知）'
  return token.scopes.join(', ')
}

/**
 * 代理不可用时的解释。
 * @param proxy - 代理 URL。
 * @param resolved - 解析结果。
 * @param probe - 探测结果。
 * @returns 一句话。
 */
function buildProxyMessage(proxy, resolved, probe) {
  const where = proxy === undefined ? '直连' : `${proxy}（来源：${resolved.source}）`
  const tried = probe.attempts === undefined ? '' : `，共尝试 ${probe.attempts.length} 次`
  const base = `网络不可用：${where} → ${probe.message ?? '未知原因'}（${probe.elapsedMs} ms${tried}）`
  const hint = probe.category === 'timeout'
    ? '代理端口可能在监听但上游不通；先确认代理客户端已启动并且订阅可用，再试直连作对照。'
    : probe.category === 'reset'
      ? '连接被重置：代理接受了连接又断开，通常是对端代理在抖动或上游不可达。稍后重试，或换一个代理端口。'
      : probe.category === 'tls'
        ? 'TLS 握手失败：端口在监听但代理不可用。探测端口会通过，请求却全部失败。改用可用的代理端口或关掉代理。'
        : probe.category === 'refused'
          ? '代理端口没有在监听：先启动代理客户端，或改用直连。'
          : '检查网络与 DNS；若开启了系统代理但开关为 0，浏览器能通而命令行不通。'
  return `${base}\n${hint}`
}

/**
 * 判断目录可写（不创建它）。
 * @param dir - 目录。
 * @returns true / false / undefined（目录不存在）。
 */
async function canWrite(dir) {
  try {
    await access(dir, constants.W_OK)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return false
  }
}

/**
 * 从可能夹杂噪声的输出里取出第一段 JSON。
 * @param text - 原始输出。
 * @returns 解析结果或 undefined。
 */
export function extractJson(text) {
  const source = String(text ?? '').trim()
  if (source.length === 0) return undefined
  try {
    return JSON.parse(source)
  } catch {
    // npm 偶尔会在 JSON 前打警告，从第一个 [ 或 { 开始再试一次。
  }
  const arrayStart = source.indexOf('[')
  const objectStart = source.indexOf('{')
  const start = arrayStart === -1 ? objectStart : objectStart === -1 ? arrayStart : Math.min(arrayStart, objectStart)
  if (start === -1) return undefined
  for (let end = source.length; end > start; end -= 1) {
    const chunk = source.slice(start, end)
    try {
      return JSON.parse(chunk)
    } catch {
      // 继续收缩。
    }
  }
  return undefined
}

/**
 * 比较两个语义化版本。
 * @param left - 版本号。
 * @param right - 版本号。
 * @returns 负数表示 left < right。
 */
export function compareVersions(left, right) {
  const parse = (value) => String(value ?? '').split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * 取输出尾部。
 * @param text - 文本。
 * @param limit - 字符数。
 * @returns 尾部。
 */
function tail(text, limit) {
  const source = String(text ?? '').trim()
  return source.length <= limit ? source : `…${source.slice(-limit)}`
}

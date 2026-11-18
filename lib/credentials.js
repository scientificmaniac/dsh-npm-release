/**
 * 凭据诊断：占位符形态、包级 scope、以及「登录态只有一条」这个现实。
 *
 * 三件事在这里被编码成规则，因为它们在真实发布里各自骗过一次人：
 *
 * 1. **占位符比没有凭据更糟。** `_authToken=<新token>` 会让报错指向
 *    `Bearer <新token> is not a legal HTTP header value`——一个与真实原因无关的地方。
 *    所以这里用**形态白名单**而不是黑名单：长度与前缀都对得上才算凭据。
 * 2. **有 token 不等于能发这个包。** granular token 可以带 `scopes`，只能发名单里的包。
 *    拿它发别的包得到的是 `403 You may not perform that action with these credentials`，
 *    这句文案完全指错方向。而 `npm token list` 里 token 的 `name` 是**人起的名字**，
 *    看起来像用途说明，实际是权限边界的唯一线索。
 * 3. **`npm profile get` 查不到 2FA。** granular token 默认只有 `package:write`，读用户资料
 *    直接 403。所以「发布前探测 2FA 状态」这条路根本不通，不能假装能查。
 *
 * @module dsh-npm-release/lib/credentials
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fetchWithFallback } from './http.js'

/** npm 官方 registry 主机名。发布只能用官方源。 */
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org'

/** 已知镜像源主机——它们适合装包，**不能**发布。 */
export const MIRROR_HOSTS = Object.freeze([
  'registry.npmmirror.com',
  'registry.npm.taobao.org',
  'npmmirror.com',
  'registry.yarnpkg.com',
  'mirrors.cloud.tencent.com',
  'mirrors.huaweicloud.com',
])

/**
 * npm 凭据的合法形态。
 *
 * npm 在 2024 年后签发的 token 形如 `npm_` + 36 位 base36/base62；
 * 旧版 granular token 是裸 UUID。两者都接受，其余一律视为无效。
 */
const TOKEN_SHAPES = Object.freeze([
  { name: 'npm-token', pattern: /^npm_[A-Za-z0-9]{36}$/ },
  { name: 'npm-token-legacy', pattern: /^npm_[A-Za-z0-9]{30,}$/ },
  { name: 'classic-uuid', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  { name: 'granular-base64', pattern: /^[A-Za-z0-9+/=]{40,}$/ },
])

/**
 * 判断一段 token 文本是不是真实凭据。
 *
 * @param value - 从 `.npmrc` 里取出的原始值。
 * @returns `{ ok, shape, reason }`；`ok:false` 时 `reason` 直接说明该怎么修。
 */
export function inspectTokenShape(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length === 0) {
    return { ok: false, shape: undefined, reason: '凭据为空。空的 _authToken 会静默失败，比没有更糟：删掉该行而不是留一个空值。' }
  }
  // 这是最贵的一个坑：`Bearer <新token>` 会被当成真实凭据发出去，
  // 服务端返回的是 HTTP 头非法，看上去像网络或代理问题。
  if (/^bearer\s+/i.test(raw)) {
    return {
      ok: false,
      shape: 'bearer-prefixed',
      reason: `凭据带了 Bearer 前缀（长度 ${raw.length}），npm 会把它原样塞进 Authorization 头并报「不是合法的 HTTP 头值」。去掉 "Bearer " 前缀。`,
    }
  }
  if (/[<>]/.test(raw)) {
    return {
      ok: false,
      shape: 'placeholder',
      reason: `凭据里含 < 或 >，是占位符而不是 token（长度 ${raw.length}）。请写入真实 token。`,
    }
  }
  if (/^(invalid|none|null|undefined|changeme|your[_-]?token|xxx+)$/i.test(raw)) {
    return { ok: false, shape: 'placeholder-word', reason: `凭据是占位词 "${raw}"，不是 token。` }
  }
  if (/\s/.test(raw)) {
    return { ok: false, shape: 'whitespace', reason: '凭据里含空白字符，多半是粘贴时带进了换行或空格。' }
  }
  for (const shape of TOKEN_SHAPES) {
    if (shape.pattern.test(raw)) return { ok: true, shape: shape.name, reason: undefined }
  }
  return {
    ok: false,
    shape: 'unknown',
    reason: `凭据形态无法识别（长度 ${raw.length}，开头 ${raw.slice(0, 4)}…）。npm token 形如 npm_ 加 36 位字符，或一个 UUID。`,
  }
}

/**
 * 从一段 `.npmrc` 文本里取出各个 registry 的 `_authToken` 行。
 *
 * 同时识别 `//host/:_authToken=` 与 `//host/path/:_authToken=` 两种键形，
 * 后者用于私有 scope registry。
 *
 * @param text - `.npmrc` 内容。
 * @returns `Array<{ key, registryHost, registryPath, value, line }>`。
 */
export function parseNpmrcTokens(text) {
  const found = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = /^\s*(\/\/[^\s=]+\/):_authToken\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = `${match[1]}:_authToken`
    const registry = match[1]
    const hostMatch = /^\/\/([^/]+)/.exec(registry)
    found.push({
      key,
      registryHost: hostMatch === null ? undefined : hostMatch[1],
      registryPath: registry.slice(2 + (hostMatch === null ? 0 : hostMatch[1].length)),
      value: match[2],
      line: index + 1,
    })
  }
  return found
}

/**
 * 读出 `.npmrc` 的 `registry=` 设置。
 * @param text - `.npmrc` 内容。
 * @returns registry URL；未设置时返回 undefined。
 */
export function parseNpmrcRegistry(text) {
  const match = /^\s*registry\s*=\s*(.+)$/m.exec(String(text ?? ''))
  return match === null ? undefined : match[1].trim()
}

/**
 * 判断一个 registry 是否只能用于安装、不能用于发布。
 * @param registry - registry URL。
 * @returns true 表示是镜像源。
 */
export function isMirrorRegistry(registry) {
  if (typeof registry !== 'string') return false
  let host
  try {
    host = new URL(registry).hostname
  } catch {
    return false
  }
  return MIRROR_HOSTS.some((mirror) => host === mirror || host.endsWith(`.${mirror}`))
}

/**
 * 用户级 `.npmrc` 的默认位置。
 * @returns 绝对路径。
 */
export function defaultUserNpmrc() {
  return path.join(homedir(), '.npmrc')
}

/**
 * 读取并诊断凭据环境。
 *
 * 只读：这里不会改写用户的 `.npmrc`。真实发布时用的是隔离的临时 userconfig，
 * 因为 `_authToken` 是**按 registry host 存一条**、不按包分的，改写它会让
 * 同一台机器上别的包的登录态消失。
 *
 * @param options - 目标 registry、目标包名、自定义 npmrc 路径。
 * @returns 结构化的凭据诊断结果。
 */
export async function diagnoseCredentials({ registry = OFFICIAL_REGISTRY, packageName, npmrcPath } = {}) {
  const file = npmrcPath ?? defaultUserNpmrc()
  let text = ''
  let readable = false
  try {
    text = await readFile(file, 'utf8')
    readable = true
  } catch {
    readable = false
  }

  const configuredRegistry = parseNpmrcRegistry(text)
  const tokens = parseNpmrcTokens(text)
  const registryHost = safeHost(registry)
  const matching = tokens.filter((entry) => entry.registryHost === registryHost)

  const findings = []
  if (!readable) {
    findings.push({
      level: 'warn',
      code: 'npmrc-missing',
      message: `没有读到 ${file}。若从未登录，这是正常的；若刚登录过，说明登录态写在别处（例如 -userconfig 指定的临时文件）。`,
    })
  }
  if (configuredRegistry === undefined) {
    findings.push({ level: 'info', code: 'registry-default', message: '`.npmrc` 没有设置 registry，npm 会用默认值 https://registry.npmjs.org。' })
  } else if (isMirrorRegistry(configuredRegistry)) {
    findings.push({
      level: 'warn',
      code: 'registry-mirror',
      message: `全局 registry 指向镜像 ${configuredRegistry}。镜像适合装包，不承载登录态也不能发布；发布命令必须显式指定 ${OFFICIAL_REGISTRY}。`,
    })
  }
  if (registry !== OFFICIAL_REGISTRY && isMirrorRegistry(registry)) {
    findings.push({
      level: 'error',
      code: 'publish-to-mirror',
      message: `目标 registry ${registry} 是镜像源，不能用于发布。`,
    })
  }

  if (matching.length === 0 && readable) {
    findings.push({
      level: 'warn',
      code: 'token-absent',
      message: `\`.npmrc\` 里没有 ${registryHost} 的 _authToken。发布需要人或插件另行提供凭据。`,
    })
  }

  const tokenReports = matching.map((entry) => {
    const shape = inspectTokenShape(entry.value)
    if (!shape.ok) {
      findings.push({
        level: 'error',
        code: 'token-shape',
        message: `第 ${entry.line} 行（${entry.key}）的凭据不可用：${shape.reason}`,
      })
    }
    return {
      key: entry.key,
      line: entry.line,
      registryHost: entry.registryHost,
      shape: shape.shape,
      ok: shape.ok,
      reason: shape.reason,
      // 绝不回显 token 本身，连前缀都只给 4 位。
      preview: entry.value.trim().length === 0 ? '' : `${entry.value.trim().slice(0, 4)}…（长度 ${entry.value.trim().length}）`,
    }
  })

  return {
    npmrcPath: file,
    readable,
    configuredRegistry,
    registry,
    registryHost,
    mirror: isMirrorRegistry(registry),
    tokenReports,
    findings,
    // 「登录态能不能用」这里不下结论——只能由真实请求证明。
    verified: false,
  }
}

/**
 * 解析 `npm token list --json` 的输出，判断某条 token 是否覆盖目标包。
 *
 * 这是本插件里唯一能解释 `403 ... with these credentials` 的地方。
 *
 * 但**它经常读不到**：granular token 只有 `package:write` 时，`GET /-/npm/v1/tokens`
 * 直接返回 `401 Unauthorized`，而 npm 的 `--json` 会把错误体写进 stdout。
 * 所以这里必须把「没有权限看」与「看了但没有覆盖」区分开——前者不能说成后者。
 *
 * **另一样必须区分的事**：`npm token list` 列出的是这个**账号下所有** token，
 * 而 `.npmrc` 里只存了一条 `_authToken`。列表接口把 token 原文打码了，
 * 所以拿它反推「本机正在用哪一条」是不可能的。
 * 因此结论只有两种有资格作为阻断项：
 *
 * - 某条可写 token 的 scope 覆盖目标包 → `covering`，放行；
 * - 所有可写 token 的 scope 都**不含**目标包 → `blockingAll`，这才是必然 403。
 *
 * 旧的 `blocking` 语义是「随便找一条不覆盖的 token」，结果是：本机同时存在
 * 一条只授权了别的包的 token 与一条全包 token 时，
 * 发布一个全新的包会被判成「现在发布必然失败」并中止发布——
 * 而实际上 `.npmrc` 里那条全包 token 完全能发。误报阻断比漏报更糟：
 * 它把一个可发布的包挡在 npm 之前，且理由是错的。
 *
 * @param payload - `npm token list --json` 的解析结果，或字符串。
 * @param packageName - 目标包名。
 * @returns `{ available, tokens, covering, blocking, blockingAll, error }`。
 */
export function inspectTokenScopes(payload, packageName) {
  let list = payload
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return { available: false, tokens: [], covering: undefined, blocking: undefined, blockingAll: undefined, error: 'npm token list 的输出不是合法 JSON' }
    }
  }
  // npm 在失败时仍以 --json 形态输出 { error: { code, summary } }。
  if (list !== null && typeof list === 'object' && !Array.isArray(list) && list.error !== undefined) {
    const code = list.error?.code ?? 'unknown'
    const summary = list.error?.summary ?? ''
    const is401 = /401/.test(String(summary)) || code === 'E401'
    const detail = is401
      ? '当前凭据没有读取 token 列表的权限（或这次请求没带凭据）。这不代表它不能发布，只是无法在发布前核对包范围。'
      : `npm token list 失败：${code} ${summary}`
    return { available: false, tokens: [], covering: undefined, blocking: undefined, blockingAll: undefined, error: detail, errorCode: code }
  }
  if (!Array.isArray(list)) {
    return { available: false, tokens: [], covering: undefined, blocking: undefined, blockingAll: undefined, error: 'npm token list 的输出不是数组' }
  }

  const tokens = list.map((entry) => {
    const permissions = Array.isArray(entry?.permissions) ? entry.permissions : []
    const canWrite = permissions.some((item) => item?.name === 'package' && (item?.action === 'write' || item?.action === 'read-write'))
    const scopes = Array.isArray(entry?.scopes) ? entry.scopes.map((scope) => scope?.name).filter((name) => typeof name === 'string') : []
    // 空 scopes 表示「所有包」，这是 npm granular token 的语义。
    const coversAll = scopes.length === 0
    const covers = canWrite && (coversAll || scopes.includes(packageName))
    return {
      name: typeof entry?.name === 'string' ? entry.name : undefined,
      key: typeof entry?.key === 'string' ? entry.key : undefined,
      bypass2fa: entry?.bypass_2fa === true,
      revoked: entry?.revoked !== null && entry?.revoked !== undefined,
      canWrite,
      scopes,
      coversAllPackages: coversAll,
      covers,
      expiry: typeof entry?.expiry === 'string' ? entry.expiry : undefined,
      expired: typeof entry?.expiry === 'string' ? Date.parse(entry.expiry) < Date.now() : false,
    }
  })

  const usable = tokens.filter((token) => token.canWrite && !token.revoked && !token.expired)
  const covering = usable.find((token) => token.covers)
  // 「每一条可写 token 都不含这个包」才是必然 403；只要有一条覆盖就放行，
  // 因为本机实际用哪一条无法从打码的列表里反推。
  const blockingAll = usable.length > 0 && covering === undefined ? usable[0] : undefined
  return {
    available: true,
    tokens,
    covering,
    // 保留旧字段供调用方兼容，但语义收紧为「全部不可用时的代表」。
    blocking: blockingAll,
    blockingAll,
    error: undefined,
  }
}


/**
 * 查询账号的认证状态（含 2FA 模式）。
 *
 * **这条路走得通**，前提是请求**真的带上了凭据**。早期版本把它判成「查不到」是个错误推断：
 * 当时插件把用户 `.npmrc` 隔离掉却没继承 token，于是请求裸奔，拿到 401 后
 * 被误读成「granular token 没有读用户资料的权限」。真实情况是——
 * 带 token 请求 `/-/npm/v1/user` 返回 200，响应里直接就有 `tfa.mode`。
 *
 * 实测取值：`auth-and-writes` 表示写入类操作（发布）需要 2FA，
 * `auth-only` 表示只在登录时需要，`disabled` / 缺失表示未启用。
 *
 * @param options - registry、token、代理、超时。
 * @returns `{ ok, mode, pending, readOnly, username, status, error, implication }`。
 */
export async function fetchAccountAuth({ registry = OFFICIAL_REGISTRY, token, proxy, timeoutMs = 20000 } = {}) {
  const url = `${String(registry).replace(/\/+$/, '')}/-/npm/v1/user`
  const headers = { accept: 'application/json', 'user-agent': 'dsh-npm-release' }
  if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`

  // 代理时通时断是真实环境特性，所以失败时回退直连，而不是把一次超时当成「查不到」。
  const response = await fetchWithFallback(url, { proxy, timeoutMs, headers })

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: response.status,
      via: response.via,
      error: typeof token === 'string' && token.length > 0
        ? `带着凭据请求仍被拒（HTTP ${response.status}）：这条 token 没有读取账号资料的权限，或已失效。`
        : `请求没有携带凭据（HTTP ${response.status}），因此查不到账号状态——这不代表 token 没有权限。`,
      implication: undefined,
    }
  }
  if (response.status !== 200) {
    return {
      ok: false,
      status: response.status,
      via: response.via,
      attempts: response.attempts,
      error: `查询账号状态失败：${response.status === undefined ? (response.proxyError ?? response.error ?? '网络不可达') : `HTTP ${response.status}`}`,
      implication: undefined,
    }
  }

  let doc
  try {
    doc = JSON.parse(response.body)
  } catch {
    return { ok: false, status: response.status, via: response.via, error: '账号接口返回的不是合法 JSON', implication: undefined }
  }

  const mode = typeof doc?.tfa?.mode === 'string' ? doc.tfa.mode : undefined
  const pending = doc?.tfa?.pending ?? undefined
  return {
    ok: true,
    status: 200,
    via: response.via,
    fellBack: response.fellBack,
    mode,
    pending,
    username: typeof doc?.name === 'string' ? doc.name : undefined,
    email: typeof doc?.email === 'string' ? doc.email : undefined,
    emailVerified: doc?.email_verified === true,
    readOnly: doc?.tfa?.readonly === true,
    implication: describeTfaMode(mode),
  }
}

/**
 * 把 `tfa.mode` 翻成「发布时会不会被要求授权」。
 *
 * @param mode - 账号接口返回的 `tfa.mode`。
 * @returns 一句话。
 */
export function describeTfaMode(mode) {
  if (mode === 'auth-and-writes') {
    return '写入类操作（发布）需要 2FA：发布时 npm 会要求一次性验证码或浏览器授权。'
  }
  if (mode === 'auth-only') {
    return '只在登录时需要 2FA：正常情况下发布不会触发 2FA 挑战。'
  }
  if (mode === 'disabled' || mode === undefined) {
    return '账号未启用基于 TOTP 的 2FA：发布预期不需要一次性验证码。'
  }
  return `账号的 2FA 模式是「${mode}」，含义未知，发布时以实际响应为准。`
}

/**
 * 从 registry URL 安全地取主机名。
 * @param registry - registry URL。
 * @returns 主机名；无法解析时返回 registry 原文。
 */
function safeHost(registry) {
  try {
    return new URL(registry).hostname
  } catch {
    return String(registry)
  }
}

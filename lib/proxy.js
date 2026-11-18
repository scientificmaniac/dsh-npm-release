/**
 * 代理解析与**真实可用性**探测。
 *
 * 本机踩过的坑决定了这里的设计：
 *
 * 1. 系统代理开关为 0 时，`ProxyServer` 仍然写着 `127.0.0.1:<port>`——只看配置会以为配好了。
 * 2. 端口在听也不等于可用：Clash 的 fake-ip 会把域名解析到 198.18.0.0/15，端口通、
 *    TLS 握手失败，所有请求静默超时。
 *
 * 所以「探端口」这个判断故意没有实现：它给出的是假阳性。唯一可信的证据是真的发一次
 * HTTPS 请求并拿到状态码。
 *
 * @module dsh-npm-release/lib/proxy
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { probeFetch } from './http.js'

const execFileAsync = promisify(execFile)

/** 环境变量里代理键的优先级顺序（小写排在后面，因为大小写不敏感的系统上两者等价）。 */
const PROXY_ENV_KEYS = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'])

/** 默认探测目标：能代表「registry 到底能不能连」的那个主机。 */
export const DEFAULT_PROBE_URL = 'https://registry.npmjs.org/-/ping'

/**
 * 从环境变量里读代理。
 * @param env - 环境变量表，默认 `process.env`。
 * @returns 代理地址；没有配置时返回 undefined。
 */
export function proxyFromEnv(env = process.env) {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 从 Windows 注册表读系统代理。
 *
 * 返回的 `enabled` 与 `server` 分开给：调用方能看到「地址配了但开关关着」这个真实状态，
 * 而不是被合并成一句「没有代理」。
 *
 * @param platform - 平台，默认 `process.platform`。
 * @returns `{ enabled, server, autoConfigUrl }`；非 Windows 或读取失败时各字段为 undefined。
 */
export async function systemProxy(platform = process.platform) {
  if (platform !== 'win32') return { enabled: undefined, server: undefined, autoConfigUrl: undefined }
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  try {
    const { stdout } = await execFileAsync('reg', ['query', key], { windowsHide: true, timeout: 15000 })
    const read = (name) => {
      const match = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(stdout)
      return match === null ? undefined : match[1].trim()
    }
    const enable = read('ProxyEnable')
    return {
      enabled: enable === undefined ? undefined : enable !== '0x0' && enable !== '0',
      server: read('ProxyServer'),
      autoConfigUrl: read('AutoConfigUrl'),
    }
  } catch {
    return { enabled: undefined, server: undefined, autoConfigUrl: undefined }
  }
}

/**
 * 把注册表里的 `ProxyServer` 值规范化成 URL。
 *
 * Windows 允许 `host:port`、`http=host:port;https=host:port`、`socks=host:port` 三种写法，
 * 直接用会得到 `fetch` 无法解析的地址。
 *
 * @param raw - 注册表里的原始值。
 * @param protocol - 需要的是 http 还是 https 通道。
 * @returns 规范化后的代理 URL；无法解析时返回 undefined。
 */
export function normalizeProxyServer(raw, protocol = 'https') {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const text = raw.trim()
  if (!text.includes('=')) return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  const entries = new Map()
  for (const part of text.split(';')) {
    const [scheme, address] = part.split('=', 2)
    if (scheme === undefined || address === undefined) continue
    entries.set(scheme.trim().toLowerCase(), address.trim())
  }
  const picked = entries.get(protocol) ?? entries.get('http') ?? entries.get('socks') ?? entries.get('https')
  if (picked === undefined || picked.length === 0) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(picked)) return picked
  const onlySocks = entries.has('socks') && !entries.has('http') && !entries.has('https')
  return `${onlySocks ? 'socks5' : 'http'}://${picked}`
}

/**
 * 解析本机代理：环境变量 → Windows 系统代理。
 *
 * 不返回「已可用」这个结论——可用性只能由 {@link probeProxy} 给出。
 *
 * @param options - 平台与自定义环境。
 * @returns `{ url, source, system }`；完全没配置时 `url` 为 undefined。
 */
export async function resolveProxy({ platform = process.platform, env = process.env } = {}) {
  const fromEnv = proxyFromEnv(env)
  if (fromEnv !== undefined) return { url: fromEnv, source: 'env', system: undefined }
  const system = await systemProxy(platform)
  if (system.enabled === true && system.server !== undefined) {
    return { url: normalizeProxyServer(system.server, 'https'), source: 'system', system }
  }
  return { url: undefined, source: 'none', system }
}

/**
 * 判断一次失败是否值得重试。
 *
 * 本机实测：同一个代理端口在同一分钟内会成功、然后连续两次 `ECONNRESET`。
 * 单次探测就下「代理不可用」的结论会把一个能用的环境判死，所以这里只对
 * **传输层抖动**重试——DNS 失败、端口没开、SOCKS 不支持都是确定性错误，重试没有意义。
 *
 * @param category - {@link probeProxyOnce} 的分类。
 * @returns true 表示可重试。
 */
function isRetryable(category) {
  return category === 'reset' || category === 'timeout' || category === 'tls'
}

/**
 * 探测网络是否真的可用，带重试。
 *
 * 这是整个插件里唯一有资格说「网络通」的函数。超时、TLS 失败、DNS 失败都归为不可用，
 * 但各自带不同的 `category`，因为修复动作完全不同。
 *
 * @param options - 目标 URL、代理、单次超时、尝试次数。
 * @returns `{ ok, status, category, message, elapsedMs, attempts }`。
 */
export async function probeProxy({ url = DEFAULT_PROBE_URL, proxy, timeoutMs = 15000, retries = 2 } = {}) {
  const startedAt = Date.now()
  const attempts = []
  let last
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt)
    last = await probeProxyOnce({ url, proxy, timeoutMs })
    attempts.push({ attempt: attempt + 1, ...last })
    if (last.ok === true) break
    if (!isRetryable(last.category)) break
  }
  return {
    ...last,
    attempts,
    elapsedMs: Date.now() - startedAt,
    // 重试过才成功，说明网络不稳；调用方要把这件事说出来，而不是当成完全正常。
    flaky: last.ok === true && attempts.length > 1,
  }
}

/**
 * 发一次请求判断网络可用性。
 *
 * @param options - 目标 URL、代理、超时。
 * @returns `{ ok, status, category, message, elapsedMs }`。
 */
async function probeProxyOnce({ url = DEFAULT_PROBE_URL, proxy, timeoutMs = 15000 } = {}) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Node 的 fetch 不读 HTTP_PROXY，代理必须通过 undici 的 dispatcher 或这里显式构造。
    // 为了零依赖，我们自己实现「经代理的 HTTPS 请求」：对 http 代理发 CONNECT，
    // 对直连直接 fetch。这一小段代码换来的是不引入 undici 依赖。
    const response = proxy === undefined
      ? await globalThis.fetch(url, { method: 'GET', signal: controller.signal, headers: { 'user-agent': 'dsh-npm-release' } })
      : await fetchViaProxy(url, proxy, controller.signal)
    // 4xx 也算「网络通」：能拿到业务状态码就说明链路没问题。
    return {
      ok: response.ok === true || (response.status >= 200 && response.status < 500),
      status: response.status,
      category: 'ok',
      message: undefined,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    const code = error?.cause?.code ?? error?.code
    if (error?.name === 'AbortError') {
      return { ok: false, status: undefined, category: 'timeout', message: `请求在 ${timeoutMs} ms 内没有完成`, elapsedMs }
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return { ok: false, status: undefined, category: 'dns', message: `域名解析失败（${code}）`, elapsedMs }
    }
    if (code === 'ECONNREFUSED') {
      return { ok: false, status: undefined, category: 'refused', message: `连接被拒绝（${code}）：代理端口没有在监听`, elapsedMs }
    }
    // ECONNRESET 是「连接被对端重置」，可能是代理抖动，也可能是 fake-ip 黑洞。
    // 它和 TLS 证书/协议错误是两回事，归到一处会让修复方向出错。
    if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/i.test(String(error?.message))) {
      return {
        ok: false,
        status: undefined,
        category: 'reset',
        message: `连接被重置（${code}）：代理接受了连接但随即断开`,
        elapsedMs,
      }
    }
    if (code === 'EPROTO' || code === 'CERT_HAS_EXPIRED' || /certificate|SSL|TLS handshake/i.test(String(error?.message))) {
      return {
        ok: false,
        status: undefined,
        category: 'tls',
        message: `TLS 握手失败（${code ?? error?.message}）：端口在监听但代理不可用`,
        elapsedMs,
      }
    }
    return { ok: false, status: undefined, category: 'other', message: error?.message ?? String(error), elapsedMs }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 等待若干毫秒。
 * @param ms - 毫秒。
 * @returns Promise。
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 经 HTTP 代理探测目标可达性。
 *
 * 复用 `lib/http.js` 的隧道实现：代理的 CONNECT 逻辑只应存在一处，
 * 两处各写一份会在某天只修好其中一处。
 *
 * @param url - 目标 HTTPS URL。
 * @param proxy - 代理 URL。
 * @param signal - 中止信号。
 * @returns 形如 `{ ok, status }` 的最小响应。
 */
async function fetchViaProxy(url, proxy, signal) {
  const response = await probeFetch(url, { proxy, timeoutMs: 20000, headers: { 'user-agent': 'dsh-npm-release' } })
  if (response.status === undefined) {
    throw Object.assign(new Error(response.error ?? '代理请求失败'), { code: 'EPROXYFAIL' })
  }
  if (signal?.aborted === true) {
    throw Object.assign(new Error('已中止'), { name: 'AbortError' })
  }
  return { ok: response.ok, status: response.status }
}

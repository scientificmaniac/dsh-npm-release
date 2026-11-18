/**
 * 最小 HTTP 客户端：直连或用 HTTP 代理，零依赖。
 *
 * Node 的 `fetch` 不读 `HTTP_PROXY` / `HTTPS_PROXY`，而本机真实情况是
 * 「系统代理开关为 0、Clash 在跑、域名被解析进 198.18.0.0/15」——直连与走代理
 * 得到的结论完全不同。所以这里把「走不走代理」做成显式参数，而不是靠环境变量碰运气。
 *
 * @module dsh-npm-release/lib/http
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

/** 单次请求允许读取的最大响应体。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * 发一次 GET 并读取响应体。
 *
 * 与 `fetch` 的差别只有两点：接受显式代理，且不抛异常——HTTP 层失败也返回结果对象，
 * 让调用方自己决定「多大程度上算失败」。
 *
 * @param url - 目标 URL。
 * @param options - 代理、超时、额外头。
 * @returns `{ ok, status, body, headers, error }`。
 */
export async function probeFetch(url, { proxy, timeoutMs = 20000, headers = {} } = {}) {
  try {
    const result = proxy === undefined
      ? await directGet(url, { timeoutMs, headers })
      : await proxiedGet(url, proxy, { timeoutMs, headers })
    return result
  } catch (error) {
    return {
      ok: false,
      status: undefined,
      body: '',
      headers: {},
      error: error?.message ?? String(error),
    }
  }
}

/**
 * 发一次 GET，代理失败时**自动回退直连**。
 *
 * 这是从真实环境学到的：同一台机器上，代理端口时通时断（同一分钟内成功、失败、
 * 成功），而直连一直稳定——因为 DNS 把域名解析到 fake-ip 段并不妨碍直连本身工作。
 * 单次探测就断言「网络不可用」会把能用的环境判死，所以这里两条路都试。
 *
 * @param url - 目标 URL。
 * @param options - 代理、超时、额外头、是否允许回退。
 * @returns `{ ...结果, via }`，`via` 说明最终走成了哪条路。
 */
export async function fetchWithFallback(url, { proxy, timeoutMs = 20000, headers = {}, allowDirectFallback = true } = {}) {
  if (proxy === undefined) {
    const direct = await probeFetch(url, { timeoutMs, headers })
    return { ...direct, via: 'direct', attempts: [{ via: 'direct', ...summarize(direct) }] }
  }
  const attempts = []
  const viaProxy = await probeFetch(url, { proxy, timeoutMs, headers })
  attempts.push({ via: 'proxy', ...summarize(viaProxy) })
  if (viaProxy.status !== undefined) return { ...viaProxy, via: 'proxy', attempts }
  if (allowDirectFallback !== true) return { ...viaProxy, via: 'proxy', attempts }

  const direct = await probeFetch(url, { timeoutMs, headers })
  attempts.push({ via: 'direct', ...summarize(direct) })
  return { ...direct, via: 'direct', fellBack: true, attempts, proxyError: viaProxy.error }
}

/**
 * 把一次结果压成可记录的摘要（不含正文）。
 * @param result - {@link probeFetch} 的结果。
 * @returns 摘要。
 */
function summarize(result) {
  return {
    status: result.status,
    ok: result.ok,
    error: result.error === undefined ? undefined : String(result.error).slice(0, 120),
  }
}

/**
 * 直连 GET。
 * @param url - 目标 URL。
 * @param options - 超时与头。
 * @returns 结果对象。
 */
function directGet(url, { timeoutMs, headers }) {
  return requestGet(url, { timeoutMs, headers })
}

/**
 * 经 HTTP 代理 GET：CONNECT 建隧道后在该 socket 上做 TLS。
 * @param url - 目标 URL。
 * @param proxy - 代理 URL。
 * @param options - 超时与头。
 * @returns 结果对象。
 */
async function proxiedGet(url, proxy, { timeoutMs, headers }) {
  const target = new URL(url)
  const proxyUrl = new URL(proxy)
  if (proxyUrl.protocol.startsWith('socks')) {
    throw new Error('不支持 SOCKS 代理（需要额外依赖）；请填写 HTTP 代理端口')
  }
  if (target.protocol !== 'https:') {
    throw new Error(`经代理访问仅支持 https，收到 ${target.protocol}`)
  }

  const port = target.port === '' ? 443 : Number(target.port)
  const authority = `${target.hostname}:${port}`
  const socket = await new Promise((resolve, reject) => {
    const request = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port === '' ? 80 : Number(proxyUrl.port),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      timeout: timeoutMs,
      ...(proxyUrl.username === '' ? {} : {
        auth: `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
      }),
    })
    request.once('connect', (response, tunnel) => {
      if (response.statusCode !== 200) {
        tunnel.destroy()
        reject(new Error(`代理 CONNECT 返回 ${response.statusCode}`))
        return
      }
      resolve(tunnel)
    })
    request.once('timeout', () => { request.destroy(new Error(`代理连接超时（${timeoutMs} ms）`)) })
    request.once('error', reject)
    request.end()
  })

  return await new Promise((resolve, reject) => {
    const request = https.request({
      host: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { host: target.hostname, ...headers },
      servername: target.hostname,
      socket,
      agent: false,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      let total = 0
      response.on('data', (chunk) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          response.destroy(new Error('响应体超过上限'))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
        })
      })
      response.once('error', reject)
    })
    request.once('timeout', () => { request.destroy(new Error(`请求超时（${timeoutMs} ms）`)) })
    request.once('error', reject)
    request.end()
  })
}

/**
 * 直连 GET 的通用实现（http 与 https 都走这里）。
 * @param url - 目标 URL。
 * @param options - 超时与头。
 * @returns 结果对象。
 */
function requestGet(url, { timeoutMs, headers }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'http:' ? http : https
    const request = transport.request({
      host: target.hostname,
      port: target.port === '' ? (target.protocol === 'http:' ? 80 : 443) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { host: target.hostname, ...headers },
      servername: target.protocol === 'https:' ? target.hostname : undefined,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      let total = 0
      response.on('data', (chunk) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          response.destroy(new Error('响应体超过上限'))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
        })
      })
      response.once('error', reject)
    })
    request.once('timeout', () => { request.destroy(new Error(`请求超时（${timeoutMs} ms）`)) })
    request.once('error', reject)
    request.end()
  })
}

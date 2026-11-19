/**
 * 对照实验：判断 `npm profile get` 的 403 到底是「token 权限问题」还是「网络问题」。
 *
 * 判据设计：
 * - 若**不带任何凭据**发请求也能拿到 401/403（而不是超时/DNS 失败），说明链路是通的，
 *   状态码来自 registry 本身 → 403 是真实的鉴权结论。
 * - 若直连因 fake-ip 黑洞而超时，而走代理能拿到状态码，则必须用代理的结论。
 * - 再带真实 token，看是否从 403 变成 200 → 确认是 token 权限而非账号问题。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { probeFetch } from '../lib/http.js'

// 代理端口从环境变量读，不写死：这是本机配置，不是项目约定。
// 用法：PROBE_PROXY=http://127.0.0.1:9999 node scripts/probe-2fa.mjs
// 不设时走直连，脚本会如实报告实际走成的路径。
const PROXY = process.env.PROBE_PROXY
const URL_USER = 'https://registry.npmjs.org/-/npm/v1/user'
const URL_TOKENS = 'https://registry.npmjs.org/-/npm/v1/tokens'
const URL_PING = 'https://registry.npmjs.org/-/ping'

/** 从 ~/.npmrc 取官方源的 token。 */
function readToken () {
  const text = readFileSync(path.join(homedir(), '.npmrc'), 'utf8')
  const match = /^\s*\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(.+)$/m.exec(text)
  return match === null ? undefined : match[1].trim()
}

const token = readToken()
console.log('本地 token：', token === undefined ? '未找到' : `${token.slice(0, 4)}…（长度 ${token.length}）`)
console.log('代理：', PROXY ?? '（未设置 PROBE_PROXY，走直连）')

// 代理相关场景在未配置代理时跳过：把「没设代理」当成「走了代理」来对照，
// 会得到一份自己骗自己的实验结果。
const proxyLabel = PROXY === undefined ? '直连' : '走代理'
const scenarios = [
  { label: '直连 /-/ping（无凭据）', url: URL_PING, proxy: undefined },
  ...(PROXY === undefined ? [] : [{ label: `${proxyLabel} /-/ping（无凭据）`, url: URL_PING, proxy: PROXY }]),
  { label: '直连 /-/npm/v1/user（无凭据）', url: URL_USER, proxy: undefined },
  ...(PROXY === undefined ? [] : [{ label: `${proxyLabel} /-/npm/v1/user（无凭据）`, url: URL_USER, proxy: PROXY }]),
  ...(PROXY === undefined ? [] : [
    { label: `${proxyLabel} /-/npm/v1/user（带 token）`, url: URL_USER, proxy: PROXY, auth: true },
    { label: `${proxyLabel} /-/npm/v1/tokens（带 token）`, url: URL_TOKENS, proxy: PROXY, auth: true },
  ]),
  { label: '直连 /-/npm/v1/user（带 token）', url: URL_USER, proxy: undefined, auth: true },
]

for (const scenario of scenarios) {
  const headers = {
    'user-agent': 'npm/11.20.0 node/v26.13.0 win32 x64',
    accept: 'application/json',
  }
  if (scenario.auth === true && token !== undefined) {
    headers.authorization = `Bearer ${token}`
  }
  const started = Date.now()
  const result = await probeFetch(scenario.url, { proxy: scenario.proxy, timeoutMs: 20000, headers })
  const elapsed = Date.now() - started
  const status = result.status === undefined ? `失败(${result.error ?? '?'})` : `HTTP ${result.status}`
  const body = String(result.body ?? '').replace(/\s+/g, ' ').slice(0, 150)
  console.log(`\n【${scenario.label}】${status}  ${elapsed} ms`)
  if (body.length > 0) console.log(`  body: ${body}`)
}

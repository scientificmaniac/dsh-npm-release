/**
 * 跑 npm 命令：隔离 userconfig、工作区内缓存、正确的代理变量。
 *
 * 这个模块把三个真实事故固化成了默认行为：
 *
 * 1. **隔离 userconfig。** `_authToken` 是按 registry host 存**一条**的，不按包分。
 *    为了发 A 包去 `npm login`，会覆盖 B 包的登录态——本机发生过，代价是重新生成 token。
 *    所以插件用临时 userconfig，一次也不改写用户的 `~/.npmrc`。
 * 2. **工作区内缓存。** 沙箱下 `~/.npm/cache/_cacache` 不可写，连 `npm pack --dry-run`
 *    都会 `EPERM`，而且日志也落不了盘，只能看着 "operation not permitted" 猜。
 * 3. **四个代理变量一起设。** `HTTP_PROXY`/`HTTPS_PROXY` 之外还要
 *    `NPM_CONFIG_PROXY`/`NPM_CONFIG_HTTPS_PROXY`，否则部分请求仍走直连。
 *
 * @module dsh-npm-release/lib/npm-run
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 默认单条命令的超时。发布本身要等人在浏览器里确认，所以给得比较宽。 */
export const DEFAULT_TIMEOUT_MS = 240000

/** 输出保留上限（字符）。一次 npm publish 的 notice 约三四十行，远小于此。 */
const MAX_OUTPUT = 512 * 1024

/**
 * 找到 npm 的可执行入口。
 *
 * 不走 `npm.ps1` / `npm.cmd` 这类壳：它们会再套一层 shell，退出码与输出都可能被改写。
 * 直接用 `node <npm-cli.js>`，退出码就是 npm 的真实退出码。
 *
 * @param options - 显式指定或从环境推断。
 * @returns `{ command, prefixArgs, source }`。
 */
export async function locateNpm({ npmCliPath, nodePath } = {}) {
  const node = nodePath ?? process.execPath

  if (typeof npmCliPath === 'string' && npmCliPath.length > 0) {
    return { command: node, prefixArgs: [npmCliPath], source: 'configured' }
  }

  // 1) 从 node 的安装位置推断：<nodeDir>/node_modules/npm/bin/npm-cli.js
  const candidates = [
    path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: node, prefixArgs: [candidate], source: 'derived' }
  }

  // 2) 从环境变量里读 npm 的 execpath（npm 自己会设置）。
  const execPath = process.env.npm_execpath
  if (typeof execPath === 'string' && execPath.endsWith('.js') && existsSync(execPath)) {
    return { command: node, prefixArgs: [execPath], source: 'npm_execpath' }
  }
  if (typeof execPath === 'string' && execPath.length > 0 && existsSync(execPath)) {
    return { command: execPath, prefixArgs: [], source: 'npm_execpath' }
  }

  // 3) 交给 PATH 上的 npm。仍然可用，但退出码与输出会经过一层壳。
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [], source: 'path' }
}

/**
 * 建一个隔离的运行环境。
 *
 * **凭据必须被继承**：隔离 `npm_config_userconfig` 的代价是会连同用户 `.npmrc` 里的
 * `_authToken` 一起隔离掉。若只隔离不继承，npm 的每个请求都不带凭据，得到的 401/403
 * 与「token 没有权限」在文案上无法区分——本插件自己踩过这个坑。
 *
 * 所以顺序是：显式传入的 token 优先，否则从用户 `.npmrc` 里把**目标 registry** 的那一行
 * 抄进临时文件。抄的是凭据本身，不是整个文件，因此用户其它 registry 的登录态仍被隔离。
 *
 * @param options - 包目录、registry、代理、缓存目录、显式 token。
 * @returns `{ env, userconfigPath, cleanup, tokenSource }`。
 */
export async function createRunEnv({ cwd, registry, proxy, cacheDir, token, inheritUserToken = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-npm-release-'))
  const userconfigPath = path.join(root, 'npmrc')
  // 指向工作区内的缓存：沙箱下用户级缓存不可写，EPERM 会让 npm 连日志都写不出来。
  const resolvedCache = cacheDir ?? path.join(cwd ?? root, '.npm-cache')
  const lines = [`registry=${registry}`, `cache=${resolvedCache}`]

  let resolvedToken = typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined
  let tokenSource = resolvedToken === undefined ? undefined : 'argument'
  if (resolvedToken === undefined && inheritUserToken === true) {
    const inherited = await readUserTokenFor(registry)
    if (inherited !== undefined) {
      resolvedToken = inherited
      tokenSource = 'user-npmrc'
    }
  }
  if (resolvedToken !== undefined) {
    // 凭据只进这个临时文件，绝不写用户的 .npmrc。
    const parsed = new URL(registry)
    const host = parsed.host
    const pathPart = parsed.pathname.replace(/\/$/, '')
    lines.push(`//${host}${pathPart}/:_authToken=${resolvedToken}`)
  }
  await writeFile(userconfigPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })

  const env = { ...process.env }
  // 隔离这两个变量，否则 npm 仍会去读用户与全局 npmrc 里的 _authToken。
  env.npm_config_userconfig = userconfigPath
  env.NPM_CONFIG_USERCONFIG = userconfigPath
  env.npm_config_cache = resolvedCache
  env.NPM_CONFIG_CACHE = resolvedCache
  // 关掉更新检查：发布过程里多一次网络请求只会多一个失败点。
  env.npm_config_update_notifier = 'false'
  env.NO_UPDATE_NOTIFIER = '1'
  if (proxy !== undefined) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
    env.NPM_CONFIG_PROXY = proxy
    env.NPM_CONFIG_HTTPS_PROXY = proxy
  } else {
    // 明确清掉，避免继承到别处的代理而让「直连」名不副实。
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY']) {
      delete env[key]
    }
  }

  return {
    env,
    userconfigPath,
    cacheDir: resolvedCache,
    tokenSource,
    hasToken: resolvedToken !== undefined,
    async cleanup() {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/**
 * 从用户 `.npmrc` 里取出目标 registry 的 `_authToken`。
 *
 * @param registry - 目标 registry URL。
 * @returns token 原文；没有时返回 undefined。
 */
export async function readUserTokenFor(registry) {
  const { homedir } = await import('node:os')
  const candidates = [path.join(homedir(), '.npmrc')]
  if (typeof process.env.npm_config_userconfig === 'string') candidates.unshift(process.env.npm_config_userconfig)
  let host
  try {
    host = new URL(registry).host
  } catch {
    return undefined
  }
  for (const file of candidates) {
    const text = await readIfExists(file)
    if (text === undefined) continue
    // 键形是 //host/:_authToken 或 //host/path/:_authToken。
    const pattern = new RegExp(`^\\s*//${escapeRegExp(host)}[^\\s=]*:_authToken\\s*=\\s*(.+)$`, 'm')
    const match = pattern.exec(text)
    if (match !== null) {
      const value = match[1].trim()
      if (value.length > 0) return value
    }
  }
  return undefined
}

/**
 * 转义正则元字符。
 * @param value - 原文。
 * @returns 转义后的字符串。
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 跑一条命令并收集输出。
 *
 * stdout 与 stderr 分别保留：npm 的 tarball 清单与授权链接全在 stderr，
 * 而真实的失败原因常常在 stdout 之外。
 *
 * @param options - 可执行、参数、工作目录、环境、超时。
 * @returns `{ exitCode, stdout, stderr, combined, timedOut, signal, elapsedMs }`。
 */
export function runCommand({ command, args, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const onAbort = () => { child.kill('SIGKILL') }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk
    })

    const finish = (exitCode, failure) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
      resolve({
        exitCode,
        stdout,
        stderr,
        combined: `${stdout}\n${stderr}`.trim(),
        timedOut,
        signal: failure,
        elapsedMs: Date.now() - startedAt,
      })
    }

    child.once('error', (error) => finish(-1, error?.message ?? String(error)))
    child.once('close', (code, signalName) => finish(code === null ? -1 : code, signalName ?? undefined))
  })
}

/**
 * 读取一个文件，失败时返回 undefined。
 * @param file - 绝对路径。
 * @returns 文本或 undefined。
 */
export async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

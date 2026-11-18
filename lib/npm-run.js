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
 * **为什么不能把 `npm.cmd` 当兜底**：Node 从 18.20 / 20.12 起（CVE-2024-27980）拒绝在
 * `shell: false` 下执行 `.cmd` / `.bat`，`spawn('npm.cmd')` 会**同步抛出 EINVAL**，
 * 而不是返回一个失败的结果。这不是理论问题：DSH Desktop 的 Host 进程用的是自带
 * 运行时（`.dsh/dsh-runtimes/.../node/bin/node.exe`，其中**没有 npm**），
 * 而它又不是 npm 启动的（`npm_execpath` 为空）。于是四条推断全部落空，
 * 兜底路径 `npm.cmd` 被同步抛错，整个 `check` 动作在第一次执行 npm 之前就崩了。
 *
 * 所以这里补两层：先扫 `PATH` 找真实存在的 `npm-cli.js`（并配对的 `node.exe`），
 * 实在找不到才退到 `cmd /c npm`，并如实报告「退出码经过一层壳」。
 *
 * @param options - 显式指定或从环境推断。
 * @returns `{ command, prefixArgs, source, viaShell? }`。
 */
export async function locateNpm({ npmCliPath, nodePath } = {}) {
  const configuredCli = npmCliPath ?? process.env.DSH_NPM_RELEASE_NPM_CLI
  const node = nodePath ?? process.env.DSH_NPM_RELEASE_NODE ?? process.execPath

  if (typeof configuredCli === 'string' && configuredCli.length > 0) {
    return { command: node, prefixArgs: [configuredCli], source: 'configured' }
  }
  if (cachedNpm !== undefined) return cachedNpm

  const found = await detectNpm({ node })
  cachedNpm = found
  return found
}

/** 进程内缓存：一次会话里 npm 的位置不会变，重复扫 PATH 纯属浪费。 */
let cachedNpm

/**
 * 实际执行探测的几条路径，按可靠性从高到低排列。
 *
 * @param options - 候选 node 可执行文件。
 * @returns npm 入口描述。
 */
async function detectNpm({ node }) {
  // 1) 从 node 的安装位置推断：<nodeDir>/node_modules/npm/bin/npm-cli.js
  const candidates = [
    path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: node, prefixArgs: [candidate], source: 'derived' }
  }

  // 2) 从环境变量里读 npm 的 execpath（npm 自己启动子进程时会设置）。
  const execPath = process.env.npm_execpath
  if (typeof execPath === 'string' && execPath.endsWith('.js') && existsSync(execPath)) {
    return { command: node, prefixArgs: [execPath], source: 'npm_execpath' }
  }
  if (typeof execPath === 'string' && execPath.length > 0 && existsSync(execPath)) {
    return { command: execPath, prefixArgs: [], source: 'npm_execpath' }
  }

  // 3) 扫 PATH：这才是 Host 进程里真正管用的一条。
  //    真实形态是：PATH 里有 Node 的安装目录（含 node.exe 与 node_modules\npm），
  //    而 process.execPath 指向 DSH 自带的不带 npm 的 node。
  const scanned = scanPathForNpmCli()
  if (scanned !== undefined) return scanned

  // 4) 最后一个兜底：只能经过一层 cmd。**不能**直接 spawn npm.cmd（EINVAL）。
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
    return { command: comspec, prefixArgs: ['/d', '/c', 'npm'], source: 'comspec', viaShell: true }
  }
  return { command: 'npm', prefixArgs: [], source: 'path' }
}

/**
 * 在 `PATH` 里找一个真实存在的 `npm-cli.js`，并找到能跑它的 `node.exe`。
 *
 * 只看「目录里有没有 node_modules/npm/bin/npm-cli.js」，因为这是 npm 的标准布局，
 * 且能直接给出 `node <cli>` 的组合，不经过任何 shell。
 *
 * @returns `{ command, prefixArgs, source, dir }`；没找到时返回 undefined。
 */
function scanPathForNpmCli() {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  const dirs = raw.split(path.delimiter).map((entry) => entry.trim().replace(/^"(.*)"$/, '$1')).filter((entry) => entry.length > 0)
  const seen = new Set()
  for (const dir of dirs) {
    const key = dir.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(cli)) continue
    const localNode = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    const command = existsSync(localNode) ? localNode : process.execPath
    return { command, prefixArgs: [cli], source: 'path-scan', dir }
  }
  return undefined
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
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      // 关键修正：spawn 对某些入参是**同步抛错**的（Windows 上 shell:false 跑 .cmd 就是
      // EINVAL），旧实现让它直接冒泡成工具层的「Error: spawn EINVAL」，
      // 连是哪个命令、什么原因都没留下。这里统一翻成可解释的失败结果。
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: '',
        combined: '',
        timedOut: false,
        signal: error?.code ?? 'spawn-failed',
        spawnError: describeSpawnError(error, command, args),
        elapsedMs: Date.now() - startedAt,
      })
      return
    }
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

    const finish = (exitCode, failure, spawnError) => {
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
        ...(spawnError === undefined ? {} : { spawnError }),
        elapsedMs: Date.now() - startedAt,
      })
    }

    // ENOENT / EACCES 这类是**异步**的 error 事件（进程启动失败），
    // 而 EINVAL 是上面那条同步 throw。两者都要翻成同一份可解释的结果，
    // 否则「命令根本没起来」会伪装成「命令跑了但输出为空」。
    child.once('error', (error) => finish(-1, error?.message ?? String(error), describeSpawnError(error, command, args)))
    child.once('close', (code, signalName) => finish(code === null ? -1 : code, signalName ?? undefined))
  })
}

/**
 * 把 spawn 的同步异常翻成人能读的一句话。
 *
 * @param error - 抛出的异常。
 * @param command - 尝试执行的命令。
 * @param args - 参数。
 * @returns 解释文本。
 */
export function describeSpawnError(error, command, args = []) {
  const code = error?.code ?? 'unknown'
  const rendered = [command, ...(Array.isArray(args) ? args : [])].join(' ')
  if (code === 'EINVAL' && process.platform === 'win32') {
    return `无法执行 ${rendered}：EINVAL。在 Windows 上这几乎总是「用 shell:false 去跑 .cmd / .bat」——`
      + 'Node 从 18.20/20.12 起为 CVE-2024-27980 直接拒绝这种调用。应改为 `node <npm-cli.js>`，'
      + '找不到 npm-cli.js 时也只经 `cmd /d /c`，不要直接 spawn npm.cmd。'
  }
  if (code === 'ENOENT') return `找不到可执行文件：${command}。安装位置没在 PATH 里，或路径拼错了。`
  if (code === 'EACCES') return `没有执行 ${command} 的权限。`
  return `启动 ${rendered} 失败：${error?.message ?? String(error)}`
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

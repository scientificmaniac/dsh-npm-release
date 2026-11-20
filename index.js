/**
 * npm 发布插件 —— 把「本机真实踩过的坑」变成缺省行为。
 *
 * 暴露一个模型面向的工具 `npm_release`，一个动作参数区分五个操作：
 *
 * - `check`   十项发布前检查（版本、凭据形态、token 包级 scope、注册源、代理、缓存、打包内容、包名占用、2FA 可查性、内容泄露）
 * - `pack`    真实的打包预览，给回结构化的文件数与体积
 * - `publish` 发布；需要 2FA 时把授权链接交给人，**以 registry 的 versions 里出现该版本判定成功**
 * - `verify`  只查 registry，不发布——用于「已经发过、只是还没传播完」
 * - `status`  只读地报告环境（npm、registry、代理、凭据形态），不跑任何 npm 写操作
 *
 * 三条设计约束来自事故，而不是偏好：
 *
 * 1. **不替人完成 2FA。** 授权链接交出去，人在浏览器里确认；插件不保存长期 token。
 * 2. **202 不是成功。** 唯一的成功判据是 registry 上真的出现了这个版本。
 * 3. **超时不是失败。** 轮询不到返回 `not-visible`，此时重发会撞 E409。
 *
 * @module dsh-npm-release
 */

import { access } from 'node:fs/promises'
import path from 'node:path'
import { runChecks, previewPack } from './lib/check-runner.js'
import { OFFICIAL_REGISTRY, diagnoseCredentials } from './lib/credentials.js'
import { locateNpm } from './lib/npm-run.js'
import { probeProxy, resolveProxy } from './lib/proxy.js'
import { fetchPackageState, inspectVersion } from './lib/registry.js'
import { runPublish } from './lib/publish-runner.js'
import { renderCheckReport, renderPackSummary, renderPublishResult, renderVerifyResult } from './lib/render.js'

/** 插件名（同时是 Loader 行的 id）。 */
export const name = 'npm-release'
/** 依赖的 Host 服务：没有工具注册表就无法工作。 */
export const inject = ['tools']

/** 默认 registry：发布只能走官方源。 */
const DEFAULT_REGISTRY = OFFICIAL_REGISTRY

/**
 * 把字符串结果包装成最小可用的工具定义。
 * @param options - 工具名、描述、参数与执行函数。
 * @returns 可直接注册的工具定义。
 */
function textTool({ name: toolName, description, parameters, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
    },
    execute,
  }
}

/**
 * 插件入口。
 * @param ctx - 插件上下文。
 * @param config - Loader 行中的配置。
 */
export function apply(ctx, config = {}) {
  const defaultRegistry = typeof config.registry === 'string' && config.registry.length > 0 ? config.registry : DEFAULT_REGISTRY
  const defaultTimeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 240000
  const defaultWaitTimeoutMs = Number.isFinite(config.verifyTimeoutMs) ? config.verifyTimeoutMs : 300000
  const proxyConfig = typeof config.proxy === 'object' && config.proxy !== null ? config.proxy : {}
  const configuredProxy = typeof config.proxy === 'string' && config.proxy.length > 0 ? config.proxy : undefined
  const allowPublish = config.permissions === undefined || config.permissions?.publish !== false

  /** 解析工作目录：显式参数优先，否则回退到当前进程目录。 */
  const resolveDir = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) return path.resolve(value.trim())
    return process.cwd()
  }

  /** 解析 registry：参数 → 配置 → 官方源。 */
  const resolveRegistry = (value) => {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim().replace(/\/+$/, '')
    return defaultRegistry.replace(/\/+$/, '')
  }

  /**
   * 解析代理：参数 → 配置 → 环境/系统。
   *
   * `off` 是显式关闭——想直连时不能靠「什么都不传」，
   * 因为环境里可能正有一个坏代理。
   */
  const resolveProxyOption = async (value) => {
    if (value === 'off') return { url: undefined, source: 'disabled' }
    if (typeof value === 'string' && value.trim().length > 0) return { url: value.trim(), source: 'argument' }
    if (configuredProxy !== undefined) return { url: configuredProxy, source: 'config' }
    const resolved = await resolveProxy({})
    return { url: resolved.url, source: resolved.source }
  }

  /** 组装一次操作所需的公共上下文。 */
  const contextFor = async (args) => {
    const dir = resolveDir(args.package_dir)
    const registry = resolveRegistry(args.registry)
    const proxy = await resolveProxyOption(args.proxy)
    return { dir, registry, proxy }
  }

  /**
   * 确认目录里确实有 package.json，否则给出可执行的提示而不是让 npm 报一个 ENOENT。
   */
  const requirePackageDir = async (dir) => {
    try {
      await access(path.join(dir, 'package.json'))
    } catch {
      throw new Error(`${dir} 里没有 package.json。package_dir 必须是包含 package.json 的包目录（不是仓库根，也不是父目录）。`)
    }
  }

  // —— 服务方法：工具与将来的 UI 共用同一份逻辑 ——
  //
  // 按 user-actions.md 的要求，操作只实现一次。现在只有工具这一个调用者，
  // 但把实现放在这里，设置页或命令以后接进来时不会出现「第二份逻辑」。
  const service = {
    /**
     * 只读地报告环境，不跑任何 npm 写操作。
     * @param args - `package_dir` / `registry` / `proxy`。
     * @returns 文本。
     */
    async status(args = {}) {
      const { dir, registry, proxy } = await contextFor(args)
      const npm = await locateNpm()
      const probe = await probeProxy({ proxy: proxy.url, timeoutMs: 15000 })
      const credentials = await diagnoseCredentials({ registry })
      const lines = []
      lines.push('npm 发布环境')
      lines.push(`工作目录：${dir}`)
      lines.push(`npm：${npm.command}${npm.prefixArgs.length > 0 ? ` ${npm.prefixArgs[0]}` : ''}（来源：${npm.source}）`)
      lines.push(`registry：${registry}${registry === OFFICIAL_REGISTRY ? '（官方源）' : ''}`)
      const proxyText = proxy.url === undefined
        ? '直连'
        : `${proxy.url}（${proxy.source === 'argument' ? '调用指定' : proxy.source === 'config' ? '插件配置' : proxy.source === 'disabled' ? '已关闭' : proxy.source === 'env' ? '环境变量' : '系统代理'}）`
      lines.push(`代理：${proxyText} → ${probe.ok === true ? '可用' : `不可用（${probe.category}）`}${probe.flaky === true ? '，重试后才通' : ''}`)
      if (probe.ok !== true) lines.push(`  ${probe.message}`)
      lines.push('')
      lines.push('用户 npmrc：' + `${credentials.npmrcPath}${credentials.readable ? '' : '（读不到）'}`)
      lines.push(`  其中的 registry：${credentials.configuredRegistry ?? '（未设置，用默认值）'}`)
      if (credentials.tokenReports.length === 0) {
        lines.push('  没有该 registry 的 _authToken')
      } else {
        for (const token of credentials.tokenReports) {
          lines.push(`  ${token.key} → ${token.ok ? `形态合法（${token.shape}）` : `不可用：${token.reason}`}`)
        }
      }
      for (const finding of credentials.findings) {
        if (finding.code === 'registry-mirror') lines.push(`  ! ${finding.message}`)
      }

      // —— 账号与 2FA ——
      // 这条查询需要真的带上凭据。插件早期版本因为隔离 userconfig 时没继承 token，
      // 把这里查不到误判成「接口没权限」，现在会如实区分两种失败。
      const { readUserTokenFor } = await import('./lib/npm-run.js')
      const { fetchAccountAuth } = await import('./lib/credentials.js')
      const token = await readUserTokenFor(registry)
      const auth = await fetchAccountAuth({ registry, token, proxy: proxy.url })
      lines.push('')
      if (auth.ok === true) {
        lines.push(`账号：${auth.username ?? '(未知)'}${auth.email === undefined ? '' : ` <${auth.email}>`}`)
        lines.push(`2FA 模式：${auth.mode ?? '未启用'}`)
        lines.push(`  ${auth.implication}`)
        if (auth.readOnly === true) lines.push('  账号处于只读状态（tfa.readonly），发布会被拒绝。')
      } else {
        lines.push('账号：查询失败')
        lines.push(`  ${auth.error}`)
      }
      lines.push('')
      lines.push('说明：凭据的形态可以本地验证；它的包级 scope 限制会在 check 里核对；'
        + '2FA 已按上面的模式查明。')
      return lines.join('\n')
    },

    /**
     * 十项发布前检查。
     * @param args - 目录、registry、代理、跳过项。
     * @returns 文本。
     */
    async check(args = {}) {
      const { dir, registry, proxy } = await contextFor(args)
      await requirePackageDir(dir)
      const report = await runChecks({
        dir,
        registry,
        proxy: proxy.url,
        timeoutMs: defaultTimeoutMs,
        skip: Array.isArray(args.skip) ? args.skip : [],
      })
      return renderCheckReport(report)
    },

    /**
     * 打包预览。
     * @param args - 目录、registry、代理。
     * @returns 文本。
     */
    async pack(args = {}) {
      const { dir, registry, proxy } = await contextFor(args)
      await requirePackageDir(dir)
      const result = await previewPack({ dir, registry, proxy: proxy.url, timeoutMs: defaultTimeoutMs })
      if (result.error !== undefined) {
        return `打包预览失败：${result.error}`
      }
      return renderPackSummary(result.summary, dir)
    },

    /**
     * 仅查询 registry，不发布。
     * @param args - 目录、registry、代理、是否轮询。
     * @returns 文本。
     */
    async verify(args = {}) {
      const { dir, registry, proxy } = await contextFor(args)
      const manifest = await tryReadManifest(dir)
      const packageName = typeof args.package_name === 'string' && args.package_name.length > 0
        ? args.package_name
        : manifest?.name
      const version = typeof args.version === 'string' && args.version.length > 0 ? args.version : manifest?.version
      if (packageName === undefined) {
        throw new Error('无法确定包名：package_dir 里没有 package.json，也没有传 package_name。')
      }
      const state = await fetchPackageState({ registry, name: packageName, proxy: proxy.url })
      const detail = version === undefined
        ? { visible: state.state === 'visible', latest: state.latest, inDistTag: false }
        : inspectVersion(state, version)
      const local = typeof args.compare_local === 'boolean' && args.compare_local === false
        ? undefined
        : await localIntegrity(dir)
      return renderVerifyResult({
        name: packageName,
        version,
        state: state.state,
        latest: state.latest,
        versionCount: state.versions.length,
        placeholderOnly: state.placeholderOnly === true,
        unpublishedAt: state.unpublishedAt,
        visible: detail.visible === true,
        inDistTag: detail.inDistTag,
        shasum: detail.shasum,
        integrity: detail.integrity,
        publishedAt: detail.publishedAt,
        local,
      })
    },

    /**
     * 发布。
     * @param args - 目录、registry、tag、access、代理、是否 dry-run。
     * @returns 文本。
     */
    async publish(args = {}) {
      if (allowPublish !== true) {
        return '发布能力在插件配置里被关闭（permissions.publish = false）。检查与打包仍然可用。'
      }
      const { dir, registry, proxy } = await contextFor(args)
      await requirePackageDir(dir)
      const manifest = await tryReadManifest(dir)
      if (manifest?.name === undefined || manifest?.version === undefined) {
        throw new Error(`${dir}/package.json 缺少 name 或 version，无法发布。`)
      }
      // 发布前跑一遍检查：把「版本已存在」这类必然失败挡在 npm 之前，
      // 省掉一次含 2FA 授权的完整流程。
      //
      // 注意这里**不能**跳过 pack：内容泄露扫描依赖真实打包清单（哪些文件真的会进 tgz）。
      // 曾经为了省几秒跳过它，结果 README 里的本机路径与账号名直接发到了公开 registry——
      // npm 不允许覆盖版本，泄露发出去只能 unpublish 或提版本补救。
      if (args.skip_check !== true) {
        const report = await runChecks({
          dir,
          registry,
          proxy: proxy.url,
          timeoutMs: defaultTimeoutMs,
          skip: [],
          verifyPackageName: true,
        })
        if (report.ok !== true) {
          return [
            '发布前检查未通过，已在调用 npm 之前中止。',
            '',
            renderCheckReport(report),
          ].join('\n')
        }
      }
      const result = await runPublish({
        dir,
        name: manifest.name,
        version: manifest.version,
        registry,
        tag: typeof args.tag === 'string' && args.tag.length > 0 ? args.tag : 'latest',
        accessLevel: typeof args.access === 'string' && args.access.length > 0 ? args.access : 'public',
        proxy: proxy.url,
        dryRun: args.dry_run === true,
        timeoutMs: defaultTimeoutMs,
        waitTimeoutMs: defaultWaitTimeoutMs,
        waitIntervalMs: Number.isFinite(config.verifyIntervalMs) ? config.verifyIntervalMs : 10000,
      })
      // dry-run 没有上传，渲染层需要知道本来要发的是哪一版。
      return renderPublishResult({ ...result, name: manifest.name, version: manifest.version })
    },
  }

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'npm_release',
    description: 'Check, pack, publish and verify an npm package in this workspace. '
      + 'A publish that requires two-factor authentication stops and hands the authorization link to the user; '
      + 'the plugin never completes the authorization itself. '
      + 'Success means the registry really lists the new version, not that the publish command exited zero. '
      + 'When the version is accepted but not yet visible, the result says so and must not be retried as a publish.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'pack', 'publish', 'verify', 'status'],
          description: 'check inspects before publishing and blocks on errors; pack previews the tarball; '
            + 'publish runs npm publish and then confirms against the registry; '
            + 'verify only reads the registry, for an earlier publish that may not have propagated yet; '
            + 'status reports the local npm, registry, proxy and credential setup without running npm writes.',
        },
        package_dir: {
          type: 'string',
          description: 'Absolute path of the package directory containing package.json. Defaults to the session working directory.',
        },
        registry: {
          type: 'string',
          description: 'Registry to use. Defaults to https://registry.npmjs.org. Mirrors cannot publish; they do not hold a login session.',
        },
        proxy: {
          type: 'string',
          description: 'HTTP proxy URL such as http://127.0.0.1:<port>, or "off" to force a direct connection. '
            + 'Defaults to the environment proxy, then the Windows system proxy.',
        },
        tag: {
          type: 'string',
          description: 'dist-tag to publish under. Defaults to latest.',
        },
        access: {
          type: 'string',
          enum: ['public', 'restricted'],
          description: 'Package access for the publish. Defaults to public; scoped packages default to restricted on npm and usually need public.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Run npm publish --dry-run without uploading, to see what npm would do.',
        },
        skip_check: {
          type: 'boolean',
          description: 'Publish without running the pre-publish checks first. Use only when the checks are known to be stale for this package.',
        },
        skip: {
          type: 'array',
          items: { type: 'string', enum: ['credentials', 'proxy', 'cache', 'pack', 'registry'] },
          description: 'Check groups to skip in the check action, for faster iterations when a group is known good.',
        },
        version: {
          type: 'string',
          description: 'Version to look for in the verify action. Defaults to the version in package.json.',
        },
        package_name: {
          type: 'string',
          description: 'Package name to look for in the verify action. Defaults to the name in package.json.',
        },
        compare_local: {
          type: 'boolean',
          description: 'In verify, also pack locally and compare integrity with the registry. Defaults to true.',
        },
      },
      required: ['action'],
    },
    execute: async (args) => {
      switch (args.action) {
        case 'check': return await service.check(args)
        case 'pack': return await service.pack(args)
        case 'publish': return await service.publish(args)
        case 'verify': return await service.verify(args)
        case 'status': return await service.status(args)
        default: throw new Error(`未知动作：${String(args.action)}`)
      }
    },
  })), 'npm-release: npm_release tool')

  // 服务本身也暴露出去：以后的设置页、命令或别的插件可以调用同一份实现，
  // 而不必再写一遍「检查 + 发布」的流程。
  ctx.provide?.('npmRelease', service)
}

/**
 * 读 package.json，失败时返回 undefined（调用方自己决定这是不是错误）。
 * @param dir - 目录。
 * @returns 清单或 undefined。
 */
async function tryReadManifest(dir) {
  try {
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 在本地打包一次，取出 integrity 用于和 registry 比对。
 *
 * 注意这里只比对 **integrity（sha512）**：registry 的 `dist.shasum` 是 SHA1，
 * 拿它和本地算的 SHA256 对照永远不可能相等——这个无用对照在真实发布里白跑过一次。
 *
 * @param dir - 包目录。
 * @returns `{ size, integrity }` 或 undefined。
 */
async function localIntegrity(dir) {
  try {
    const { readFile, mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { createRunEnv, locateNpm, runCommand } = await import('./lib/npm-run.js')
    const npm = await locateNpm()
    const runEnv = await createRunEnv({ cwd: dir, registry: DEFAULT_REGISTRY })
    try {
      const result = await runCommand({
        command: npm.command,
        args: [...npm.prefixArgs, 'pack', '--dry-run', '--json'],
        cwd: dir,
        env: runEnv.env,
        timeoutMs: 120000,
      })
      const payload = JSON.parse(result.stdout.trim().startsWith('[') || result.stdout.trim().startsWith('{')
        ? result.stdout
        : '[]')
      const record = Array.isArray(payload) ? payload[0] : payload
      if (record === null || record === undefined) return undefined
      return { size: record.size, integrity: record.integrity, fileCount: Array.isArray(record.files) ? record.files.length : undefined }
    } finally {
      await runEnv.cleanup()
    }
  } catch {
    return undefined
  }
}

/**
 * 判断目录是否为 npm 包（有 package.json）。
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

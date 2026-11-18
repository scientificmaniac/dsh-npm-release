/**
 * 包自身的一致性检查：版本、打包内容、以及「哪些文件真的会进 tgz」。
 *
 * 这里的每一条都对应一次真实的浪费：
 *
 * - 版本号在 **package.json / git tag / GitHub Release / npm dist-tag** 四处各有一份，
 *   回退时四处都要清；npm 的 unpublish 有 24 小时窗口，所以发布前拦一次远比发布后回退便宜。
 * - `files` 字段漏一个目录，包里就是缺文件（`RELEASE_NOTES/` 曾经整个没发出去）。
 *   反过来，宣传图进包会把 1.5 MB 的包撑到 1.5 MB 全花在一张 banner 上。
 *
 * 所以打包检查是**双向**的：必需文件在，非必需文件不在。
 *
 * @module dsh-npm-release/lib/package-check
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/** 一个 npm 包里应当存在的元数据文件。 */
const EXPECTED_METADATA = Object.freeze(['package.json'])

/**
 * 常见的「不该进 npm 包」的重资产。
 *
 * 判定标准不是「文件有用没用」，而是「README 渲染能不能从仓库拿到它」——
 * npm 的 README 图片走的是仓库 URL，包里再放一份纯属浪费下载量。
 */
const HEAVY_ASSET_PATTERN = /\.(png|jpe?g|gif|webp|mp4|mov|zip|7z|tar|tgz)$/i

/** 单个文件被视作「重资产」的阈值。 */
const HEAVY_ASSET_BYTES = 256 * 1024

/**
 * 读取 package.json。
 * @param dir - 包目录。
 * @returns 解析后的对象。
 */
export async function readManifest(dir) {
  const file = path.join(dir, 'package.json')
  const text = await readFile(file, 'utf8')
  try {
    return { manifest: JSON.parse(text), file }
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 校验版本号的形态与一致性。
 *
 * @param options - 目录、清单、CHANGELOG 存在性由调用方决定是否检查。
 * @returns `{ version, findings, ok }`。
 */
export async function checkVersion({ dir, manifest }) {
  const findings = []
  const version = manifest?.version
  if (typeof version !== 'string' || version.length === 0) {
    findings.push({ level: 'error', code: 'version-missing', message: 'package.json 缺少 version 字段。' })
  } else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    findings.push({ level: 'error', code: 'version-shape', message: `version "${version}" 不是合法语义化版本号。` })
  }
  if (manifest?.private === true) {
    findings.push({
      level: 'error',
      code: 'private',
      message: 'package.json 里 private 为 true，npm 会拒绝发布。若这个包只作为 DSH 插件本地安装，就不该走 npm 发布。',
    })
  }
  if (typeof manifest?.name !== 'string' || manifest.name.length === 0) {
    findings.push({ level: 'error', code: 'name-missing', message: 'package.json 缺少 name 字段。' })
  }

  // CHANGELOG 与 RELEASE_NOTES 的检查是「有就一致，没有不算错」——
  // 把格式强加给用户，会让人绕过整个检查。
  if (typeof version === 'string') {
    const changelog = await readOptional(path.join(dir, 'CHANGELOG.md'))
    if (changelog !== undefined && !changelog.includes(version)) {
      findings.push({
        level: 'warn',
        code: 'changelog-version',
        message: `CHANGELOG.md 里没有 ${version} 的条目。若本次是补丁版本可忽略，否则先补上。`,
      })
    }
    const notes = await readOptional(path.join(dir, 'RELEASE_NOTES', `v${version}.md`))
    if (notes === undefined) {
      findings.push({
        level: 'info',
        code: 'release-notes-absent',
        message: `没有 RELEASE_NOTES/v${version}.md。如果你的项目用这份文件记录发行说明，现在补；若不用，忽略这条。`,
      })
    }
  }

  return { version, findings, ok: findings.every((entry) => entry.level !== 'error') }
}

/**
 * 检查 `files` 白名单是否漏掉了运行时必需的东西。
 *
 * 只检查**本插件能可靠判断**的那几项：入口文件、exports 指向的文件、cordis patch。
 * 其余交给 `npm pack --dry-run` 的真实清单。
 *
 * @param options - 目录与清单。
 * @returns `{ findings, ok }`。
 */
export async function checkPacklist({ dir, manifest }) {
  const findings = []
  const entries = Array.isArray(manifest?.files) ? manifest.files : undefined

  const required = new Set(EXPECTED_METADATA)
  if (typeof manifest?.main === 'string') required.add(normalizeRel(manifest.main))
  if (manifest?.dsh?.bundle?.patch !== undefined) required.add(normalizeRel(manifest.dsh.bundle.patch))
  const exportsField = manifest?.exports
  if (typeof exportsField === 'string') required.add(normalizeRel(exportsField))
  else if (exportsField !== null && typeof exportsField === 'object') {
    for (const value of Object.values(exportsField)) {
      if (typeof value === 'string') required.add(normalizeRel(value))
      else if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) if (typeof nested === 'string') required.add(normalizeRel(nested))
      }
    }
  }

  // package.json 永远会进包，其余都要靠 files 覆盖或用默认白名单。
  const literalRequired = [...required].filter((entry) => entry !== 'package.json')
  if (entries !== undefined) {
    for (const entry of literalRequired) {
      // exports 里的通配路径（./locale/*.json）无法逐字比对，按目录前缀判断。
      const matched = entries.some((pattern) => {
        const clean = normalizeRel(pattern)
        if (clean === entry) return true
        if (clean.endsWith('/**') || clean.endsWith('/*')) return entry.startsWith(clean.slice(0, -1))
        if (entry === clean) return true
        return entry.startsWith(`${clean.replace(/\/$/, '')}/`)
      })
      if (!matched) {
        findings.push({
          level: 'error',
          code: 'files-missing',
          message: `files 里没有覆盖 ${entry}，这个文件不会进 tgz。`,
        })
      }
    }
  }

  // 反向：files 里显式点名的重资产，提醒它们会原样进包。
  if (entries !== undefined) {
    for (const entry of entries) {
      const clean = normalizeRel(entry)
      if (!HEAVY_ASSET_PATTERN.test(clean)) continue
      const full = path.join(dir, clean)
      try {
        const info = await stat(full)
        if (info.isFile() && info.size > HEAVY_ASSET_BYTES) {
          findings.push({
            level: 'warn',
            code: 'files-heavy-asset',
            message: `files 显式包含 ${clean}（${formatBytes(info.size)}）。README 里的图片可以从仓库地址加载，放进 npm 包只会让每次安装都多下一份。`,
          })
        }
      } catch {
        // 通配符或不存在都跳过；真实清单以 npm pack 为准。
      }
    }
  }

  return { findings, ok: findings.every((entry) => entry.level !== 'error') }
}

/**
 * 解析 `npm pack --dry-run --json` 的输出，得到结构化的打包预览。
 *
 * npm 把整份 tarball 清单（`npm notice` 前缀）打到 stderr，一次发布三四十行。
 * 这里把它压成「版本 / 体积 / 文件数 / 值得注意的几项」，原始行只在失败时保留。
 *
 * @param payload - `npm pack --json` 的解析结果。
 * @returns 结构化摘要。
 */
export function summarizePackList(payload) {
  const record = Array.isArray(payload) ? payload[0] : payload
  if (record === null || typeof record !== 'object') {
    return { error: 'npm pack 的输出不是预期的 JSON 结构' }
  }
  const files = Array.isArray(record.files) ? record.files : []
  const heavy = files
    .filter((entry) => typeof entry?.size === 'number' && entry.size > HEAVY_ASSET_BYTES)
    .map((entry) => ({ path: entry.path, size: entry.size }))
    .sort((left, right) => right.size - left.size)
  const missing = Array.isArray(record.missing) ? record.missing : []

  return {
    name: record.name,
    version: record.version,
    filename: record.filename,
    size: record.size,
    unpackedSize: record.unpackedSize,
    fileCount: files.length,
    integrity: record.integrity,
    shasum: record.shasum,
    files: files.map((entry) => ({ path: entry.path, size: entry.size })),
    heavy,
    missing,
    // npm 会把「发布时必须存在但没打包进去」的文件列在 missing 里。
    ok: missing.length === 0,
  }
}

/**
 * 可选读取一个文件。
 * @param file - 绝对路径。
 * @returns 内容；不存在时返回 undefined。
 */
async function readOptional(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 把清单里的相对路径规范化成 `a/b/c` 形式。
 * @param value - 原始路径。
 * @returns 规范化结果。
 */
function normalizeRel(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

/**
 * 人类可读的体积。
 * @param bytes - 字节数。
 * @returns 形如 `1.5 MB`。
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

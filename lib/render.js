/**
 * 把结构化结果渲染成有界的工具文本。
 *
 * 这里的取舍来自一条实测数据：一次 `npm publish` 的 tarball 清单约 27–32 行，
 * 全部塞给模型是纯浪费。所以默认只输出「版本 / 体积 / 文件数 / 值得注意的项」，
 * 原始行只在失败时附上尾部。
 *
 * @module dsh-npm-release/lib/render
 */

import { formatBytes } from './package-check.js'

/** 检查项等级的中文标签。 */
const LEVEL_LABEL = Object.freeze({ error: '✗', warn: '!', info: '·' })

/**
 * 渲染一份检查报告。
 *
 * @param report - {@link runChecks} 的返回值。
 * @returns 文本。
 */
export function renderCheckReport(report) {
  const lines = []
  const head = report.name === undefined
    ? '发布前检查'
    : `${report.name}${report.version === undefined ? '' : `@${report.version}`}`
  lines.push(`npm 发布前检查：${head}`)
  lines.push(`目录：${report.dir}`)
  lines.push(`registry：${report.registry}`)

  const errors = report.findings.filter((entry) => entry.level === 'error')
  const warns = report.findings.filter((entry) => entry.level === 'warn')
  const infos = report.findings.filter((entry) => entry.level === 'info')

  lines.push('')
  if (errors.length === 0 && warns.length === 0) {
    lines.push('结论：没有阻断项。')
  } else if (errors.length === 0) {
    lines.push('结论：没有阻断项，但有需要注意的地方。')
  } else {
    lines.push(`结论：有 ${errors.length} 项阻断，现在发布必然失败或发错内容。`)
  }

  for (const entry of report.findings) {
    lines.push(`${LEVEL_LABEL[entry.level] ?? '·'} [${entry.code}] ${entry.message}`)
  }

  // 打包摘要：这是唯一值得给出的「结构化替代品」。
  const pack = report.facts?.pack
  if (pack !== undefined && pack !== null && pack.error === undefined) {
    lines.push('')
    lines.push(`打包预览：${pack.fileCount ?? '?'} 个文件，压缩后 ${formatBytes(pack.size)}，展开后 ${formatBytes(pack.unpackedSize)}`)
    if (Array.isArray(pack.heavy) && pack.heavy.length > 0) {
      for (const item of pack.heavy.slice(0, 3)) {
        lines.push(`  · ${item.path}  ${formatBytes(item.size)}`)
      }
      if (pack.heavy.length > 3) lines.push(`  · 另有 ${pack.heavy.length - 3} 个大文件未列出`)
    }
  }

  const registry = report.facts?.registry
  if (registry !== undefined && registry !== null) {
    const latest = registry.latest === undefined ? '（无）' : registry.latest
    lines.push('')
    lines.push(`registry 现状：latest = ${latest}，已知版本 ${registry.versionCount} 个`)
  }

  const proxy = report.facts?.proxy
  if (proxy !== undefined && proxy !== null) {
    const source = proxy.url === undefined ? '直连' : `${proxy.url}（${proxy.source === 'argument' ? '调用指定' : proxy.source === 'env' ? '环境变量' : '系统代理'}）`
    const verdict = proxy.probe?.ok === true ? '可用' : '不可用'
    lines.push(`网络：${source} → ${verdict}${proxy.probe?.flaky === true ? '（重试后才通）' : ''}`)
  }

  lines.push('')
  lines.push(`用时 ${report.elapsedMs} ms`)
  return lines.join('\n')
}

/**
 * 渲染发布结果。
 *
 * @param result - {@link runPublish} 的返回值。
 * @returns 文本。
 */
export function renderPublishResult(result) {
  const lines = []

  if (result.dryRun === true) {
    // dry-run 没有上传任何东西，也没有可校验的 registry 状态。
    // 这里若走「已发布」分支，会给出一个完全没有发生过的成功。
    lines.push(`dry-run 完成：${result.name ?? '?'}@${result.version ?? '?'}（未上传）`)
    lines.push(`npm publish --dry-run 退出码 ${result.exitCode}，分类：${result.classification ?? '?'}`)
    lines.push('包内容已经验证过，但 registry 上没有任何变化——dry-run 不会发布。')
    if (Array.isArray(result.notices) && result.notices.length > 0) {
      lines.push('')
      for (const notice of result.notices) lines.push(`· ${notice}`)
    }
    if (result.exitCode !== 0 && result.output !== undefined) {
      lines.push('')
      lines.push('npm 输出（尾部）：')
      lines.push(result.output)
    }
    return lines.join('\n')
  }

  if (result.status === 'published') {
    lines.push(`已发布：${result.name}@${result.version}`)
    lines.push('判定依据：registry 的 versions 里真的出现了这一版（不是命令退出码）。')
    if (result.latest !== undefined) lines.push(`dist-tags.latest = ${result.latest}${result.inDistTag === true ? '（已指向本版）' : ''}`)
    if (result.shasum !== undefined) lines.push(`shasum = ${result.shasum}`)
    if (result.integrity !== undefined) lines.push(`integrity = ${result.integrity}`)
    if (result.tarball !== undefined) lines.push(`tarball = ${result.tarball}`)
  } else if (result.status === 'needs-authorization') {
    lines.push('需要你完成 2FA 授权。npm 已经准备好授权链接，但确认必须由人完成。')
    if (result.authorizationUrl !== undefined) {
      lines.push('')
      lines.push(`授权链接：${result.authorizationUrl}`)
      lines.push('')
      lines.push('在浏览器里打开它并确认后，用同样的参数再发布一次：旧的授权链接是一次性的，重发会拿到新链接。')
    } else if (result.redacted === true) {
      // 这是插件自己在真实发布里撞到的一幕：npm 在非 TTY 下把链接打码成 ***，
      // 旧文案说「没取到链接」，把人引向「再发一次就好了」，而再发永远是 ***。
      lines.push('')
      lines.push('npm 在非 TTY 环境（插件的管道形态）里把授权 URL 打码成了 `***`，真链接拿不到。')
      lines.push('这不是插件没抓到，也不是重发能解决的：重发只会再拿到一次 `***`。')
      lines.push('')
      lines.push('下一步：在本机终端里手动执行一次（那里有 TTY，npm 会打印真链接）：')
      lines.push('  npm publish --registry https://registry.npmjs.org')
      lines.push('完成授权后，再用 verify 动作确认 registry。')
    } else {
      lines.push('这次没有取到授权链接。请在本机终端里手动执行一次 npm publish 看提示。')
    }
  } else if (result.status === 'not-visible') {
    // 这一支是最容易被误判成失败的地方，措辞要足够强硬。
    lines.push(`已在 npm 提交，但 registry 上还看不到 ${result.name}@${result.version}。`)
    lines.push('**这不是失败。** npm 接受请求到 registry 生效之间有几十秒到两分钟的传播时间。')
    lines.push('此时重发会撞 E409（版本已存在），并可能产生不可预期的状态。')
    lines.push('下一步：稍后用 verify 动作复查 registry；不要重新 publish。')
    const attempts = result.wait?.attempts
    if (Array.isArray(attempts) && attempts.length > 0) {
      const last = attempts[attempts.length - 1]
      lines.push(`已轮询 ${attempts.length} 次，最后一次（${last.at}）：latest = ${last.latest ?? '（无）'}，共 ${last.versionCount} 个版本`)
    }
  } else {
    lines.push(`发布失败：${result.failure?.message ?? '原因未知'}`)
    if (result.failure?.hint !== undefined) {
      lines.push('')
      lines.push(`修复方向：${result.failure.hint}`)
    }
    if (result.classification !== undefined) lines.push(`分类：${result.classification}`)
  }

  if (Array.isArray(result.notices) && result.notices.length > 0) {
    lines.push('')
    for (const notice of result.notices) lines.push(`· ${notice}`)
  }

  if (result.output !== undefined && result.status !== 'published') {
    lines.push('')
    lines.push('npm 输出（尾部）：')
    lines.push(result.output)
  }

  return lines.join('\n')
}

/**
 * 渲染 registry 校验结果。
 *
 * @param result - {@link verifyVersion} 的返回值。
 * @returns 文本。
 */
export function renderVerifyResult(result) {
  const lines = []
  const target = `${result.name}${result.version === undefined ? '' : `@${result.version}`}`

  if (result.visible === true) {
    lines.push(`${target} 已在 registry 上可见。`)
    if (result.latest !== undefined) lines.push(`dist-tags.latest = ${result.latest}${result.inDistTag === true ? '（本版即 latest）' : '（本版不是 latest）'}`)
    if (result.shasum !== undefined) lines.push(`shasum = ${result.shasum}`)
    if (result.integrity !== undefined) lines.push(`integrity = ${result.integrity}`)
    if (result.publishedAt !== undefined) lines.push(`发布时间 = ${result.publishedAt}`)
    if (result.local !== undefined) {
      lines.push('')
      lines.push(`本地包对比：${formatBytes(result.local.size)}，integrity = ${result.local.integrity ?? '（未取到）'}`)
      // shasum 是 SHA1、本地算的是 sha512，两者永远不可能相等——这一条被真实对照过，
      // 白费过一步「验证」。所以这里只比对同一种算法。
      if (result.local.integrity !== undefined && result.integrity !== undefined) {
        lines.push(result.local.integrity === result.integrity
          ? '结论：本地 integrity 与 registry 一致，装到的就是这个包。'
          : '结论：本地 integrity 与 registry **不一致**。先确认本地是不是同一个版本的产物，再决定是否排查。')
      }
    }
  } else if (result.state === 'package-absent') {
    lines.push(`${target.split('@')[0]} 在 registry 上还不存在——这是首次发布，正常。`)
  } else if (result.placeholderOnly === true) {
    // 这个分支来自一次真实的误判：传播期间 registry 上只有 npm 的 0.0.0-stage stub，
    // latest 指向它，看起来像「包名被抢注」。必须当场讲清楚，否则会去抢注排查。
    lines.push(`registry 上目前只有一个占位版本（latest = ${result.latest ?? '0.0.0-stage'}）。`)
    lines.push('这是 npm 为正在传播的发布预建的 stub（Temporary package placeholder for staged publishing），')
    lines.push('**不是别人抢注了包名。** 稍后再查一次即可，不要重新发布。')
  } else {
    lines.push(`registry 上还看不到 ${target}。`)
    lines.push(`latest = ${result.latest ?? '（无）'}，已知 ${result.versionCount ?? 0} 个版本。`)
    lines.push('这是传播未完成，不是发布失败。稍后再查一次即可，不要重新发布。')
  }
  if (Array.isArray(result.attempts) && result.attempts.length > 1) {
    lines.push(`（轮询 ${result.attempts.length} 次，用时 ${result.elapsedMs} ms）`)
  }
  return lines.join('\n')
}

/**
 * 渲染打包预览。
 *
 * @param summary - {@link summarizePackList} 的结果。
 * @param dir - 包目录。
 * @returns 文本。
 */
export function renderPackSummary(summary, dir) {
  if (summary === undefined || summary.error !== undefined) {
    return `打包预览失败：${summary?.error ?? '没有结果'}`
  }
  const lines = []
  lines.push(`打包预览：${summary.name}@${summary.version}`)
  lines.push(`目录：${dir}`)
  lines.push(`文件：${summary.fileCount} 个，压缩后 ${formatBytes(summary.size)}，展开后 ${formatBytes(summary.unpackedSize)}`)
  if (summary.shasum !== undefined) lines.push(`shasum = ${summary.shasum}`)
  if (summary.integrity !== undefined) lines.push(`integrity = ${summary.integrity}`)
  if (summary.missing.length > 0) {
    lines.push('')
    lines.push(`缺失文件（npm 认为应当存在）：${summary.missing.join(', ')}`)
  }
  if (summary.heavy.length > 0) {
    lines.push('')
    lines.push('较大的文件：')
    for (const item of summary.heavy.slice(0, 8)) lines.push(`  ${formatBytes(item.size).padStart(9)}  ${item.path}`)
    if (summary.heavy.length > 8) lines.push(`  … 另有 ${summary.heavy.length - 8} 个`)
  }
  if (Array.isArray(summary.files) && summary.files.length > 0) {
    lines.push('')
    lines.push(`文件清单（${summary.files.length} 项）：`)
    for (const item of summary.files.slice(0, 40)) lines.push(`  ${formatBytes(item.size).padStart(9)}  ${item.path}`)
    if (summary.files.length > 40) lines.push(`  … 另有 ${summary.files.length - 40} 项`)
  }
  return lines.join('\n')
}

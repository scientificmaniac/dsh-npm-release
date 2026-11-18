/** 打包前的自检：与 npm 的实际打包结果对照，而不是凭 manifest 推断。 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

const problems = []
const report = []

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

// ——————————————————————————————
// 1. manifest 结构
// ——————————————————————————————
if (manifest.type !== 'module') problems.push('package.json 的 type 必须是 module（ESM 插件）')
if (manifest.dsh?.bundle?.patch === undefined) problems.push('package.json 缺少 dsh.bundle.patch，装的不会是 bundle')
if (manifest.exports?.['./locale/*.json'] === undefined) problems.push('exports 缺少 ./locale/*.json')
if (manifest.exports?.['./icon'] === undefined) problems.push('exports 缺少 ./icon')
if (manifest.repository === undefined) problems.push('package.json 缺少 repository，npm 与 GitHub 无法互相链接')
if (manifest.private === true) problems.push('package.json 的 private 为 true，npm 会拒绝发布')

const requiredFiles = [
  'index.js', 'lib', 'locale', 'cordis.patch.yml', 'icon.svg',
  'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE',
]
for (const entry of requiredFiles) {
  const covered = Array.isArray(manifest.files) && manifest.files.some((pattern) => entry === pattern || entry.startsWith(`${pattern}/`))
  if (!covered) problems.push(`files 里没有覆盖 ${entry}`)
}
report.push(`manifest：${manifest.name}@${manifest.version}`)

// —— 2. locale 的 meta ——
for (const locale of ['en', 'zh']) {
  const text = await readFile(path.join(root, 'locale', `${locale}.json`), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    problems.push(`locale/${locale}.json 不是合法 JSON：${error.message}`)
    continue
  }
  if (typeof parsed.meta?.title !== 'string' || parsed.meta.title.length === 0) problems.push(`locale/${locale}.json 缺少 meta.title`)
  if (typeof parsed.meta?.description !== 'string' || parsed.meta.description.length < 20) {
    problems.push(`locale/${locale}.json 的 meta.description 太短，说明不了能力`)
  }
  report.push(`locale/${locale}.json：title = ${parsed.meta?.title}`)
}

// —— 3. cordis.patch.yml 的行 id ——
const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('id: npm-release')) problems.push('cordis.patch.yml 没有插入 id: npm-release 的行')
if (!patch.includes("name: 'dsh-npm-release'")) problems.push('cordis.patch.yml 的行没有指向 dsh-npm-release')
report.push('cordis.patch.yml：插入 npm-release 行')

// —— 4. 每个 lib 模块都能被 import（语法之外还要真的加载） ——
const { readdir } = await import('node:fs/promises')
const { pathToFileURL } = await import('node:url')
const libDir = path.join(root, 'lib')
const libFiles = (await readdir(libDir)).filter((name) => name.endsWith('.js'))
for (const file of libFiles) {
  try {
    // Windows 上 import() 只接受 file: URL，绝对路径会被当成协议 e: 而失败。
    await import(pathToFileURL(path.join(libDir, file)).href)
  } catch (error) {
    problems.push(`lib/${file} 无法加载：${error.message}`)
  }
}
report.push(`lib：${libFiles.length} 个模块可加载`)

// —— 5. 真实打包清单 ——
// 不用 execFile('npm')：Windows 上 npm 是 npm.cmd，execFile 无法直接启动它（ENOENT）。
// 直接用插件自己的 locateNpm + runCommand，这也是它在真实发布里走的那条路径。
try {
  const { locateNpm, createRunEnv, runCommand } = await import(pathToFileURL(path.join(libDir, 'npm-run.js')).href)
  const npm = await locateNpm()
  const runEnv = await createRunEnv({ cwd: root, registry: 'https://registry.npmjs.org' })
  try {
    const result = await runCommand({
      command: npm.command,
      args: [...npm.prefixArgs, 'pack', '--dry-run', '--json', '--registry', 'https://registry.npmjs.org'],
      cwd: root,
      env: runEnv.env,
      timeoutMs: 180000,
    })
    const payload = JSON.parse(result.stdout)
    const record = Array.isArray(payload) ? payload[0] : payload
    const files = (record.files ?? []).map((entry) => entry.path)
    report.push(`npm pack：${files.length} 个文件，${(record.size / 1024).toFixed(1)} kB`)
    for (const required of ['package.json', 'index.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'README.md', 'SECURITY.md']) {
      if (!files.includes(required)) problems.push(`打包结果里缺 ${required}`)
    }
    for (const forbidden of files.filter((name) => name.startsWith('test/') || name.startsWith('scripts/') || name.startsWith('.npm-cache') || name.startsWith('.github/'))) {
      problems.push(`打包结果里不该有 ${forbidden}`)
    }
    if (record.missing !== undefined && record.missing.length > 0) {
      problems.push(`npm 报告缺失：${record.missing.join(', ')}`)
    }
  } finally {
    await runEnv.cleanup()
  }
} catch (error) {
  problems.push(`npm pack 失败：${error.message}`)
}

// —— 汇总 ——
console.log(report.join('\n'))
console.log('')
if (problems.length === 0) {
  console.log('打包自检通过。')
} else {
  console.log(`发现 ${problems.length} 个问题：`)
  for (const problem of problems) console.log(`  ✗ ${problem}`)
  process.exitCode = 1
}

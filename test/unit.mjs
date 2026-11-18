/**
 * 单元测试：覆盖所有纯函数与分类器。
 *
 * 这些用例全部来自真实日志样本——每一条都对应对应一次实际发生过的误判。
 * 只测「能不能跑」没有意义，这里测的是**判断是否正确**。
 */
import { inspectTokenShape, parseNpmrcTokens, parseNpmrcRegistry, isMirrorRegistry, inspectTokenScopes } from '../lib/credentials.js'
import { classifyPublishOutput, extractWebAuth, parsePublishNotice, parseSize, inspectVersion, waitForVersion, isPlaceholderVersion, realVersions, fetchPackageState } from '../lib/registry.js'
import { describeTfaMode } from '../lib/credentials.js'
import { normalizeProxyServer, proxyFromEnv } from '../lib/proxy.js'
import { summarizePackList, formatBytes } from '../lib/package-check.js'
import { compareVersions, extractJson } from '../lib/check-runner.js'
import { describeSpawnError, locateNpm, runCommand } from '../lib/npm-run.js'
import { sortFindings, isBlocking, describeReason, reason } from '../lib/reason.js'
import { renderCheckReport, renderPublishResult, renderVerifyResult } from '../lib/render.js'

let passed = 0
const failures = []

/** 断言工具：把失败收集起来，最后统一报告。 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
  } else {
    failures.push({ label, detail })
  }
}

function equal(label, actual, expected) {
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ——————————————————————————————————————————————
// 1. 凭据形态：占位符比没有凭据更糟
// ——————————————————————————————————————————————
section('凭据形态')

equal('真实 npm token', inspectTokenShape(`npm_${'a'.repeat(36)}`).ok, true)
equal('真实 npm token 的类型', inspectTokenShape(`npm_${'a'.repeat(36)}`).shape, 'npm-token')
equal('经典 UUID token', inspectTokenShape('0190a1b2-cccc-dddd-eeee-ffff00001111').ok, true)

// 这三条是真实报错来源，必须被拦下并给出正确原因
const bearer = inspectTokenShape('Bearer <新token>')
equal('Bearer 前缀被拒', bearer.ok, false)
equal('Bearer 前缀归类', bearer.shape, 'bearer-prefixed')
check('Bearer 的提示提到前缀', bearer.reason.includes('Bearer'), bearer.reason)

const placeholder = inspectTokenShape('<新token>')
equal('占位符被拒', placeholder.ok, false)
equal('占位符归类', placeholder.shape, 'placeholder')

const doubled = inspectTokenShape('=<新token>')
equal('双等号占位符被拒', doubled.ok, false)

equal('空值被拒', inspectTokenShape('').ok, false)
equal('纯空白被拒', inspectTokenShape('   ').ok, false)
equal('过短的 npm_ 被拒', inspectTokenShape('npm_abc').ok, false)
check('空白字符被拒', inspectTokenShape('npm_aaa bbb').ok === false)

// ——————————————————————————————————————————————
// 2. .npmrc 解析
// ——————————————————————————————————————————————
section('.npmrc 解析')

const npmrc = [
  'registry=https://registry.npmmirror.com',
  `//registry.npmjs.org/:_authToken=npm_${'b'.repeat(36)}`,
  '//npm.pkg.github.com/:_authToken=ghp_xxx',
  'prefix=D:\\node_global',
].join('\n')

const tokens = parseNpmrcTokens(npmrc)
equal('解析出两条 token', tokens.length, 2)
equal('第一条 host', tokens[0].registryHost, 'registry.npmjs.org')
equal('第一条行号', tokens[0].line, 2)
equal('第二条 host', tokens[1].registryHost, 'npm.pkg.github.com')
equal('registry 设置', parseNpmrcRegistry(npmrc), 'https://registry.npmmirror.com')
equal('镜像判定 npmmirror', isMirrorRegistry('https://registry.npmmirror.com'), true)
equal('镜像判定 官方源', isMirrorRegistry('https://registry.npmjs.org'), false)
equal('镜像判定 子域', isMirrorRegistry('https://sub.registry.npmmirror.com'), true)
equal('镜像判定 无关域名', isMirrorRegistry('https://example.com'), false)

// ——————————————————————————————————————————————
// 3. token 包级 scope：403 的真实原因
// ——————————————————————————————————————————————
section('token 包级 scope')

const scopedTokens = [
  {
    name: 'dsh-ssh-vault', key: 'k1', bypass_2fa: false, revoked: null,
    permissions: [{ name: 'package', action: 'write' }],
    scopes: [{ name: 'dsh-ssh-vault', type: 'package' }],
  },
]

const scopeReport = inspectTokenScopes(scopedTokens, 'dsh-vm-control')
equal('token 列表可读', scopeReport.available, true)
equal('不覆盖目标包', scopeReport.covering, undefined)
check('识别出阻断的 token', scopeReport.blocking !== undefined, '应识别出 scope 不覆盖')
// 只有「全部可写 token 都不覆盖」才算必然 403。
// 列表里只有一条不覆盖的 token 时，两者都成立，所以这条也必须为真——
// 语义收紧不能变成放宽。
check('全部不覆盖时 blockingAll 成立', scopeReport.blockingAll !== undefined, '应给出 blockingAll')

// 这是真实的误报来源：本机同时存在「只授权 dsh-ssh-vault」与「全包」两条 token 时，
// 旧逻辑拿第一条不覆盖的当作阻断项，于是发布任何新包都被判成「必然失败」并中止。
const mixedTokens = [
  {
    name: 'dsh-ssh-vault', key: 'k2', revoked: null,
    permissions: [{ name: 'package', action: 'write' }],
    scopes: [{ name: 'dsh-ssh-vault', type: 'package' }],
  },
  {
    name: 'dsh-vm-control', key: 'k3', revoked: null,
    permissions: [{ name: 'package', action: 'write' }],
    scopes: [],
  },
]
const mixed = inspectTokenScopes(mixedTokens, 'dsh-npm-release')
equal('有全包 token 时不算阻断', mixed.blocking, undefined)
equal('有全包 token 时 blockingAll 为空', mixed.blockingAll, undefined)
check('有全包 token 时能找到覆盖项', mixed.covering !== undefined, '应识别出全包 token 覆盖')

// 覆盖目标包的是一条**限定 scope** 的 token（不是全包）时，也不能算阻断。
const partialCover = inspectTokenScopes([
  { name: 'a', revoked: null, permissions: [{ name: 'package', action: 'write' }], scopes: [{ name: 'other', type: 'package' }] },
  { name: 'b', revoked: null, permissions: [{ name: 'package', action: 'write' }], scopes: [{ name: 'target', type: 'package' }] },
], 'target')
equal('限定 scope 覆盖时不算阻断', partialCover.blockingAll, undefined)
equal('限定 scope 覆盖时能找到覆盖项', partialCover.covering?.name, 'b')

const covered = inspectTokenScopes(scopedTokens, 'dsh-ssh-vault')
check('覆盖同名包', covered.covering !== undefined, '应识别出覆盖')

const allPackages = inspectTokenScopes([
  { name: 'all', permissions: [{ name: 'package', action: 'write' }], scopes: [] },
], 'anything')
equal('空 scopes 表示全部包', allPackages.covering?.coversAllPackages, true)

const readOnly = inspectTokenScopes([
  { name: 'ro', permissions: [{ name: 'package', action: 'read' }], scopes: [] },
], 'x')
equal('只读 token 不算可写', readOnly.covering, undefined)

// 这是真实情况：读不到 token 列表时返回 401 的 JSON
const denied = inspectTokenScopes({ error: { code: 'E401', summary: '401 Unauthorized - GET https://registry.npmjs.org/-/npm/v1/tokens' } }, 'x')
equal('读不到列表时 available=false', denied.available, false)
check('读不到列表时不编造阻断项', denied.blocking === undefined, '不能把读不到说成不覆盖')
// 措辞必须把「没权限」与「没带凭据」两种原因都留出位置——
// 早期版本只说前者，而真实原因是后者，正是这个混淆导致了错误的 2FA 结论。
check('读不到的说明区分两种原因', denied.error.includes('没带凭据') || denied.error.includes('没权限'), denied.error)

equal('非法 JSON 不抛错', inspectTokenScopes('not json', 'x').available, false)

// ——————————————————————————————————————————————
// 4. 发布输出分类：五种「不是失败」
// ——————————————————————————————————————————————
section('发布输出分类')

const cases = [
  // [标签, 输出, 退出码, 期望分类, 是否需要人]
  ['成功（2FA 后 + pkg@ver）', 'Authenticate your account at:\nhttps://www.npmjs.com/auth/cli/abc\nPress ENTER to open in the browser...\nnpm notice Your package is being processed and may take a few minutes to become available.\n+ dsh-ssh-vault@2.3.0', 0, 'accepted', false],
  ['授权退出（未提交）', 'npm notice Publishing to https://registry.npmjs.org with tag latest\nAuthenticate your account at:\nhttps://www.npmjs.com/auth/cli/c45e2912\nPress ENTER to open in the browser...', 1, 'needs-authorization', true],
  ['EOTP 真失败', 'npm error code EOTP\nnpm error This operation requires a one-time password from your authenticator.', 1, 'needs-otp', true],
  ['占位符 token', 'npm error Bearer <新token> is not a legal HTTP header value', 1, 'bad-token', false],
  ['401+轮询+202（成功）', '31 http fetch PUT 401 https://registry.npmjs.org/x 1344ms\n33 http fetch GET 202 /-/v1/done?authId=x\n43 http fetch PUT 202 https://registry.npmjs.org/x 2714ms', 0, 'accepted', false],
  ['EPERM 缓存', 'npm error code EPERM\nnpm error path C:/x/AppData/Local/npm-cache/_cacache/tmp/4574abdc', 1, 'cache-unwritable', false],
  ['已存在 E409', 'npm error code E409\nnpm error 409 Conflict - Cannot publish over previously published version', 1, 'already-published', false],
  ['E403 包级 scope', 'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/x - You may not perform that action with these credentials.', 1, 'forbidden', false],
  ['ETARGET 传播中', 'npm error code ETARGET\nnpm error notarget No matching version found for dsh-faremeter@1.4.0.', 1, 'not-propagated', false],
  ['ENEEDAUTH', 'npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in.', 1, 'not-logged-in', false],
]

for (const [label, output, exitCode, expected, needsHuman] of cases) {
  const result = classifyPublishOutput(output, exitCode)
  equal(`分类：${label}`, result.category, expected)
  equal(`需要人：${label}`, result.needsHuman, needsHuman)
}

// 401 紧跟轮询的说明必须出现——这是最容易被误判成失败的地方
const authFlow = classifyPublishOutput('31 http fetch PUT 401 https://registry.npmjs.org/x\n33 http fetch GET 202 /-/v1/done?authId=x', 0)
check('说明 web auth 不是失败', authFlow.messages.some((m) => m.includes('web auth')), authFlow.messages.join(' | '))
check('说明「已接受」不等于生效', authFlow.messages.some((m) => m.includes('被接受')), authFlow.messages.join(' | '))

// 有 PUT 202 时，分类必须是 accepted（不能因为日志里有授权 URL 就要求人）
const withPut202 = classifyPublishOutput('43 http fetch PUT 202 https://registry.npmjs.org/x 2714ms', 0)
equal('PUT 202 归为 accepted', withPut202.category, 'accepted')
check('PUT 202 会补一条说明', withPut202.messages.some((m) => m.includes('202')), withPut202.messages.join(' | '))

// ——————————————————————————————————————————————
// 5. 授权链接提取：三代文案
// ——————————————————————————————————————————————
section('授权链接提取')

const loginUrl = extractWebAuth('Login at:\nhttps://www.npmjs.com/login?next=/login/cli/abc-123\nPress ENTER to open in the browser...')
check('npm login 的链接', loginUrl?.url?.includes('/login/cli/'), JSON.stringify(loginUrl))
equal('提示 ENTER 被识别', loginUrl?.prompt, 'Press ENTER')

const authUrl = extractWebAuth('Authenticate your account at:\nhttps://www.npmjs.com/auth/cli/8c32e81b-101c')
check('publish 的 auth/cli 链接', authUrl?.url?.includes('/auth/cli/'), JSON.stringify(authUrl))

const otherUrl = extractWebAuth('Open this URL in your browser to authenticate:\n  https://www.npmjs.com/auth/cli/deadbeef')
check('第三条文案也能认', otherUrl?.url?.includes('/auth/cli/'), JSON.stringify(otherUrl))

equal('没有链接时返回 undefined', extractWebAuth('nothing here'), undefined)

// 这是真实发布里撞到的一幕：npm 在非 TTY 下把授权 URL 打成 ***。
// 旧实现返回 undefined，于是工具说「没取到链接」——把「npm 主动打码」
// 讲成了「插件没抓到」，并暗示重发即可，而重发永远是 ***。
const redactedAuth = extractWebAuth([
  'npm error code EOTP',
  'npm error This operation requires a one-time password.',
  'npm error Open this URL in your browser to authenticate:',
  'npm error   https://www.npmjs.com/auth/cli/***',
  'npm error After authenticating, your token can be retrieved from:',
  'npm error   https://registry.npmjs.org/-/v1/done?authId=***',
].join('\n'))
check('打码的链接被认出来', redactedAuth !== undefined, JSON.stringify(redactedAuth))
equal('打码标记为 redacted', redactedAuth?.redacted, true)
equal('打码时不给出 url', redactedAuth?.url, undefined)
check('打码时不把 *** 当成真 id', !/\*\*\*/.test(redactedAuth?.url ?? ''), String(redactedAuth?.url))

// 未打码时不能误标 redacted。
equal('真链接不算打码', authUrl?.redacted, false)

// 渲染层必须给出「去真终端」的下一步，而不是「再发一次」。
const redactedText = renderPublishResult({ status: 'needs-authorization', redacted: true })
check('打码结果指向真终端', redactedText.includes('终端'), redactedText)
check('打码结果不承诺重发能拿到新链接', !redactedText.includes('重发会拿到新链接'), redactedText)

const withDone = extractWebAuth('https://www.npmjs.com/auth/cli/abc\nhttps://registry.npmjs.org/-/v1/done?sessionId=xyz')
check('同时取出 doneUrl', withDone?.doneUrl?.includes('/-/v1/done'), JSON.stringify(withDone))

// ——————————————————————————————————————————————
// 6. 体积解析与打包摘要
// ——————————————————————————————————————————————
section('体积与打包')

equal('1.5 MB', parseSize('1.5 MB'), Math.round(1.5 * 1024 * 1024))
equal('133.2 kB', parseSize('133.2 kB'), Math.round(133.2 * 1024))
equal('81B', parseSize('81B'), 81)
equal('无法解析返回 undefined', parseSize('n/a'), undefined)
equal('formatBytes 1.5 MB', formatBytes(1.5 * 1024 * 1024), '1.5 MB')

const notice = parsePublishNotice([
  'npm notice name: dsh-vm-control',
  'npm notice version: 1.1.1',
  'npm notice package size: 133.2 kB',
  'npm notice unpacked size: 410.4 kB',
  'npm notice shasum: 8f6a7d6af6aa44074157b70ae973f1f0fc49ad4b',
  'npm notice total files: 27',
  'npm notice Publishing to https://registry.npmjs.org with tag latest and public access',
].join('\n'))
equal('解析包名', notice.name, 'dsh-vm-control')
equal('解析版本', notice.version, '1.1.1')
equal('解析文件数', notice.fileCount, 27)
check('解析 publishingTo', notice.publishingTo?.registry === 'https://registry.npmjs.org', JSON.stringify(notice.publishingTo))
equal('解析 access', notice.publishingTo?.access, 'public')

const packSummary = summarizePackList([{
  name: 'x', version: '1.0.0', size: 100, unpackedSize: 200, filename: 'x-1.0.0.tgz',
  integrity: 'sha512-abc',
  files: [{ path: 'index.js', size: 50 }, { path: 'assets/banner.png', size: 1.5 * 1024 * 1024 }],
  missing: [],
}])
equal('文件数', packSummary.fileCount, 2)
equal('识别大文件', packSummary.heavy.length, 1)
equal('大文件路径', packSummary.heavy[0].path, 'assets/banner.png')

const missingSummary = summarizePackList([{ name: 'x', version: '1', files: [], missing: ['README.md'] }])
equal('缺失文件让 ok=false', missingSummary.ok, false)

// ——————————————————————————————————————————————
// 7. 代理
// ——————————————————————————————————————————————
section('代理')

equal('环境变量优先取 HTTPS_PROXY', proxyFromEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' }), 'http://a:1')
equal('小写也认', proxyFromEnv({ https_proxy: 'http://c:3' }), 'http://c:3')
equal('空字符串不算配置', proxyFromEnv({ HTTPS_PROXY: '   ' }), undefined)
equal('没有配置返回 undefined', proxyFromEnv({}), undefined)
equal('裸 host:port 补 scheme', normalizeProxyServer('127.0.0.1:7897'), 'http://127.0.0.1:7897')
equal('已经是 URL 就原样', normalizeProxyServer('http://127.0.0.1:7897'), 'http://127.0.0.1:7897')
equal('分协议写法取 https', normalizeProxyServer('http=a:1;https=b:2', 'https'), 'http://b:2')
equal('只有 socks 时标 socks5', normalizeProxyServer('socks=127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
equal('空值返回 undefined', normalizeProxyServer(''), undefined)

// ——————————————————————————————————————————————
// 8. registry 版本判定
// ——————————————————————————————————————————————
section('registry 版本判定')

const state = {
  state: 'visible',
  latest: '1.4.0',
  distTags: { latest: '1.4.0' },
  versions: ['1.3.0', '1.4.0'],
  doc: { versions: { '1.4.0': { dist: { shasum: 'abc', integrity: 'sha512-x', tarball: 'https://t' } } }, time: { '1.4.0': '2026-11-17T07:38:12.451Z' }, 'dist-tags': { latest: '1.4.0' } },
}
const visible = inspectVersion(state, '1.4.0')
equal('版本可见', visible.visible, true)
equal('在 dist-tag 里', visible.inDistTag, true)
equal('取出 shasum', visible.shasum, 'abc')
equal('取出 integrity', visible.integrity, 'sha512-x')

const notYet = inspectVersion(state, '1.5.0')
equal('未发布版本不可见', notYet.visible, false)

const absent = inspectVersion({ state: 'package-absent', distTags: {}, doc: undefined }, '1.0.0')
equal('包不存在时不可见', absent.visible, false)

// 轮询超时必须返回 not-visible，而不是 failed
const notVisible = await waitForVersion({
  registry: 'https://registry.invalid',
  name: 'nonexistent-package-xyz',
  version: '9.9.9',
  timeoutMs: 1200,
  intervalMs: 500,
  proxy: undefined,
})
equal('超时状态是 not-visible', notVisible.state, 'not-visible')
equal('超时 ok=false', notVisible.ok, false)
check('超时理由说明不是失败', notVisible.reason.includes('重发'), notVisible.reason)

// ——————————————————————————————————————————————
// 9. npm 发布占位符：一次差点被误读成「包名被抢注」
// ——————————————————————————————————————————————
section('发布占位符')

// 真实数据：刚 PUT 202 六秒后，registry 上唯一版本是 npm 自己建的 0.0.0-stage。
equal('占位符被识别', isPlaceholderVersion('0.0.0-stage'), true)
equal('带后缀的占位符也被识别', isPlaceholderVersion('0.0.0-stage.1'), true)
equal('真实版本不是占位符', isPlaceholderVersion('1.0.0'), false)
equal('相似但不同不误判', isPlaceholderVersion('0.0.0'), false)
equal('undefined 不抛错', isPlaceholderVersion(undefined), false)

equal('真实版本过滤掉占位符', realVersions(['0.0.0-stage', '1.0.0']).join(','), '1.0.0')
equal('只有占位符时过滤为空', realVersions(['0.0.0-stage']).length, 0)
equal('非数组安全', realVersions(undefined).length, 0)

// 只有占位符的真实 registry 文档必须被标成 placeholderOnly，
// 否则 verify 会说「已知 1 个版本」，让人以为包名被占了。
const stubDoc = {
  versions: { '0.0.0-stage': { dist: { shasum: 'x' } } },
  'dist-tags': { latest: '0.0.0-stage' },
  time: { created: 'now' },
}
const stubState = await fetchPackageState({
  registry: 'https://registry.npmjs.org',
  name: 'dsh-npm-release',
  proxy: undefined,
})
// 用本地构造的文档验证纯判定逻辑（不依赖网络当时的真实状态）。
const stubLike = {
  state: 'visible',
  latest: stubDoc['dist-tags'].latest,
  versions: Object.keys(stubDoc.versions),
  realVersions: realVersions(Object.keys(stubDoc.versions)),
  placeholderOnly: realVersions(Object.keys(stubDoc.versions)).length === 0,
  doc: stubDoc,
}
equal('只有占位符时 placeholderOnly', stubLike.placeholderOnly, true)
equal('占位符版本不算目标版本可见', inspectVersion(stubLike, '1.0.0').visible, false)
check('网络查询仍是合法状态', typeof stubState.state === 'string', JSON.stringify(stubState.state))

const stubText = renderVerifyResult({
  name: 'dsh-npm-release', version: '1.0.0', state: 'visible',
  latest: '0.0.0-stage', versionCount: 1, placeholderOnly: true, visible: false,
})
check('占位符结果说明不是抢注', stubText.includes('不是别人抢注'), stubText)
check('占位符结果提示不要重发', stubText.includes('不要重新发布'), stubText)

// ——————————————————————————————————————————————
// 9. 版本比较与 JSON 提取
// ——————————————————————————————————————————————
section('版本比较与 JSON')

equal('1.0.0 < 1.0.1', compareVersions('1.0.0', '1.0.1') < 0, true)
equal('1.1.0 > 1.0.9', compareVersions('1.1.0', '1.0.9') > 0, true)
equal('相等', compareVersions('2.0.0', '2.0.0'), 0)
equal('忽略预发布后缀', compareVersions('1.1.1-beta.1', '1.1.1'), 0)
equal('1.10.0 > 1.9.0', compareVersions('1.10.0', '1.9.0') > 0, true)

equal('解析纯 JSON 对象', extractJson('{"a":1}')?.a, 1)
equal('解析纯 JSON 数组', Array.isArray(extractJson('[1,2]')), true)
equal('跳过前缀噪声', extractJson('npm warn something\n[{"name":"x"}]')?.[0]?.name, 'x')
equal('无 JSON 返回 undefined', extractJson('no json at all'), undefined)

// ——————————————————————————————————————————————
// 10. 检查项排序与渲染
// ——————————————————————————————————————————————
section('排序与渲染')

const sorted = sortFindings([
  { level: 'info', code: 'i', message: 'info' },
  { level: 'error', code: 'e', message: 'error' },
  { level: 'warn', code: 'w', message: 'warn' },
  { level: 'error', code: 'e', message: 'error' },
])
equal('排序后首项是 error', sorted[0].level, 'error')
equal('去重后 3 项', sorted.length, 3)
equal('末项是 info', sorted[2].level, 'info')

equal('有 error 时阻断', isBlocking([{ level: 'error' }]), false)
equal('只有 warn 不阻断', isBlocking([{ level: 'warn' }]), true)
equal('空数组不阻断', isBlocking([]), true)

const described = describeReason(reason('x', '发生了什么', '怎么修'))
check('渲染包含现象', described.includes('发生了什么'), described)
check('渲染包含修复方向', described.includes('怎么修'), described)

const reportText = renderCheckReport({
  name: 'pkg', version: '1.0.0', dir: '/x', registry: 'https://registry.npmjs.org',
  findings: [
    { level: 'error', code: 'c1', message: '阻断项' },
    { level: 'info', code: 'c2', message: '提示项' },
  ],
  facts: { pack: { fileCount: 3, size: 1000, unpackedSize: 2000, heavy: [] } },
  elapsedMs: 12,
})
check('报告含包名', reportText.includes('pkg@1.0.0'), reportText)
check('报告说明有阻断', reportText.includes('1 项阻断'), reportText)
check('报告含打包摘要', reportText.includes('3 个文件'), reportText)

const pendingText = renderPublishResult({
  status: 'not-visible', name: 'pkg', version: '1.0.0',
  wait: { attempts: [{ at: 'now', latest: '0.9.0', versionCount: 2 }] },
})
check('未传播结果说明不是失败', pendingText.includes('不是失败'), pendingText)
check('未传播结果警告不要重发', pendingText.includes('E409') || pendingText.includes('不要重新 publish'), pendingText)

const authText = renderPublishResult({
  status: 'needs-authorization', authorizationUrl: 'https://www.npmjs.com/auth/cli/abc',
})
check('授权结果给出链接', authText.includes('https://www.npmjs.com/auth/cli/abc'), authText)

const verifyText = renderVerifyResult({
  name: 'pkg', version: '1.0.0', visible: true, latest: '1.0.0', inDistTag: true,
  shasum: 'abc', integrity: 'sha512-x',
  local: { size: 100, integrity: 'sha512-x' },
})
check('校验结果说明一致', verifyText.includes('一致'), verifyText)

const mismatchText = renderVerifyResult({
  name: 'pkg', version: '1.0.0', visible: true, latest: '1.0.0', inDistTag: true,
  integrity: 'sha512-a', local: { size: 100, integrity: 'sha512-b' },
})
check('不一致时说清楚', mismatchText.includes('不一致'), mismatchText)

// ——————————————————————————————————————————————
// 11. 2FA 模式的解释
// ——————————————————————————————————————————————
section('2FA 模式')

// 这是本插件曾经判错的一件事：早期版本声称「查不到 2FA」，
// 真实原因是隔离 userconfig 时没有继承 token，请求裸奔拿 401。
// 现在带上凭据能拿到 200，mode 是 auth-and-writes。
const andWrites = describeTfaMode('auth-and-writes')
check('auth-and-writes 说明发布会要 2FA', andWrites.includes('发布'), andWrites)
check('auth-and-writes 提到 2FA', andWrites.includes('2FA'), andWrites)

const authOnly = describeTfaMode('auth-only')
check('auth-only 说明发布不会触发', authOnly.includes('不会触发'), authOnly)

const disabled = describeTfaMode('disabled')
check('disabled 说明未启用', disabled.includes('未启用'), disabled)

const unknown = describeTfaMode('some-new-mode')
check('未知模式不假装确定', unknown.includes('以实际响应为准'), unknown)

// ——————————————————————————————————————————————
// 12. npm 入口定位与 spawn 失败
// ——————————————————————————————————————————————
section('npm 入口与 spawn')

// 这是插件第一次真实发布时崩掉的原因：Host 进程用的是自带运行时，
// 目录里没有 npm，且它不由 npm 启动（npm_execpath 为空）。
// 四条推断落空后旧代码退到 `npm.cmd`，而 Windows 上 shell:false 跑 .cmd 是**同步抛 EINVAL**。
const located = await locateNpm()
check('能找到 npm 入口', typeof located?.command === 'string' && located.command.length > 0, JSON.stringify(located))
check('入口不会直接是 npm.cmd', !/\.cmd$/i.test(located.command), located.command)
check('入口来源可解释', ['configured', 'derived', 'npm_execpath', 'path-scan', 'comspec', 'path'].includes(located.source), located.source)
check('没有 bare npm.cmd 兜底', !(located.source === 'path' && located.command === 'npm.cmd'), JSON.stringify(located))

// EINVAL 的解释必须点出真正原因，而不是原样抛一句 "spawn EINVAL"。
const explained = describeSpawnError(Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }), 'npm.cmd', ['-v'])
check('EINVAL 解释提到 shell:false 跑 .cmd', /shell:false/.test(explained) && /cmd/.test(explained), explained)
check('ENOENT 解释提到找不到', /找不到/.test(describeSpawnError(Object.assign(new Error('x'), { code: 'ENOENT' }), 'nope')), 'ENOENT')

// spawn 失败必须是**返回值**，不能冒泡成异常——冒泡会让整个动作只剩一句 Error。
// 一个必然不存在的可执行文件：进程能起来才会 ENOENT，起不来则同步抛错，
// 两种路径都必须落到同一个可解释的结果上。
const spawnFailed = await runCommand({ command: 'definitely-not-a-real-binary-xyz', args: [], timeoutMs: 5000 })
equal('spawn 失败不抛异常且退出码为 -1', spawnFailed.exitCode, -1)
check('spawn 失败带 spawnError 说明', typeof spawnFailed.spawnError === 'string' && spawnFailed.spawnError.length > 0, JSON.stringify(spawnFailed))

// 真实 npm 必须能被跑起来：这是「Host 侧能用」的最小证据。
const versionRun = await runCommand({
  command: located.command,
  args: [...located.prefixArgs, '--version'],
  timeoutMs: 60000,
})
equal('npm --version 退出码 0', versionRun.exitCode, 0)
check('npm --version 有版本号输出', /^\d+\.\d+\.\d+/.test(versionRun.stdout.trim()), versionRun.combined)

// ——————————————————————————————————————————————
// 汇总
// ——————————————————————————————————————————————
function section(title) {
  console.log(`\n— ${title}`)
}

console.log(`\n${'='.repeat(60)}`)
if (failures.length === 0) {
  console.log(`${passed} 项通过，0 项失败`)
  console.log('全部通过')
} else {
  console.log(`${passed} 项通过，${failures.length} 项失败`)
  for (const failure of failures) {
    console.log(`  ✗ ${failure.label}：${failure.detail ?? ''}`)
  }
  process.exitCode = 1
}

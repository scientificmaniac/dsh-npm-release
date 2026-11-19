/**
 * 发布前的内容泄露扫描：包里有没有不该公开的东西。
 *
 * 这一项是**事后补的，代价很真实**：v1.0.0 与 v1.0.1 上线之后才发现，README 的示例输出里
 * 带着本机的主目录、项目绝对路径、代理端口、账号名与邮箱域名。九项检查一条都没覆盖这件事——
 * 而 npm 不允许覆盖已发布版本，泄露一旦发出去就只能靠 unpublish 或提版本重发来补救。
 *
 * 所以这里的取舍是：**宁可误报，不可漏报**。命中的每一条都带上文件名、行号和脱敏后的片段，
 * 让人能立刻判断「这是真实信息还是通用示例」。
 *
 * 三类信息分开处理：
 *
 * - `error`：真实个人身份与本机环境（主目录路径、邮箱、账号名、内网/回环地址）。
 *   这些出现在公开包里没有任何正当理由。
 * - `warn`：本机软件安装路径、特定端口。可能是通用示例，也可能是本机实况。
 * - `info`：其它包名等，仅供人工判断，不阻断。
 *
 * @module dsh-npm-release/lib/leak-check
 */

/** 单文件扫描上限：超大文件不参与扫描，避免拖慢发布。 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024

/** 每个类别最多报告多少条，避免刷屏。 */
const MAX_REPORTS_PER_RULE = 3

/**
 * 扫描规则。`level` 决定它是否阻断发布。
 *
 * 每条规则带一个 `why`：命中的时候要能立刻说清「为什么这算泄露」，
 * 否则使用者只会看到一堆正则匹配结果，反而学会忽略它。
 */
const RULES = Object.freeze([
  {
    code: 'leak-home-path',
    level: 'error',
    label: 'Windows 用户主目录',
    // 只匹配「真实的用户名」：占位形式（<user>、<name>、...）由 isPlaceholderPath 放过。
    // `i` 是必需的：c:\users\name 与 C:\Users\name 同样泄露，而漏掉小写形态等于漏报。
    pattern: /[A-Za-z]:\\{1,2}Users\\{1,2}([^\\\s'"`]+)/gi,
    why: '主目录路径会暴露本机用户名与机器上的目录结构。文档里应写成 C:\\Users\\<name> 这类占位形式。',
  },
  {
    code: 'leak-posix-home',
    level: 'error',
    label: 'POSIX 用户主目录',
    // 尾部**不能**要求必须是 `/` 或行尾：`/home/alice` 后面跟空格、逗号、`&&` 都是常见写法，
    // 旧实现要求 `(?:\/|$)`，于是 `/home/alice && ls` 这类完全漏报。
    // 用 `(?![\w.-])` 表示「用户名到此为止」，与 Windows 规则对齐。
    //
    // 用户名段必须**至少一个字符且不是占位符起始**：占位写法 `/home/<name>` 里
    // `<` 不属于 `[A-Za-z0-9._-]`，于是旧正则只匹配到 `/home/` 这个前缀，
    // 匹配文本不含 `<name>`，`isPlaceholderPath` 看不到尖括号 —— 文档里正确的占位
    // 写法反而被判成 error，把本该放行的说明拦了下来。
    //
    // 尾部用 `(?![\w.<>])`：不能吃进占位符的 `<`，但要允许后面紧跟 `/` 子路径。
    pattern: /\/(?:home|Users)\/([A-Za-z0-9._-]+)(?![\w.<>])/gi,
    why: '主目录路径会暴露本机用户名。文档里应写成 /home/<name> 这类占位形式。',
  },
  {
    code: 'leak-email',
    level: 'error',
    label: '邮箱地址',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: '邮箱属于个人身份信息。若确有联系方式需求，用项目公用的地址或干脆不写。',
    allow: [/@(?:example\.(?:com|org)|test\.local)$/i],
  },
  {
    code: 'leak-npm-token',
    level: 'error',
    label: 'npm 凭据',
    pattern: /npm_[A-Za-z0-9]{20,}/g,
    why: '这是真实凭据，发出去等于把发布权交出去。',
  },
  {
    code: 'leak-generic-token',
    level: 'error',
    label: '疑似令牌',
    pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
    why: '这是真实凭据的形态。即使已失效也不该进公开包。',
  },
  {
    code: 'leak-loopback',
    level: 'warn',
    label: '回环地址',
    pattern: /\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::(\d{2,5}))?/g,
    why: '回环地址常用于示例，一般可接受；但带着具体端口时可能暴露本机的代理或服务配置。',
  },
  {
    code: 'leak-private-ip',
    level: 'warn',
    label: '内网地址',
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    why: '内网地址会暴露本机所在网络结构，公开包里没有理由出现。',
  },
  {
    code: 'leak-abs-path',
    level: 'warn',
    label: '绝对路径',
    // 允许空格：`E:\\projects\\my-secret\\src` 若截断成 `E:\ai`，报告里看不出是哪个项目，
    // 告警就失去了可操作性——而 `why` 字段存在的意义正是让人能立刻判断。
    // 这里只排除真正会终止路径的字符（引号、反引号、冒号、通配符、重定向符）。
    // `(?!Users)` 改成大小写无关（`(?!users)` 配 i 标志），否则 c:\users\ 会重复报两条。
    pattern: /\b[A-Za-z]:\\{1,2}(?!users)[^'"`:*?<>|\r\n]+/gi,
    why: '绝对路径会暴露本机的安装布局与项目命名。文档示例应写成 <install-dir> 之类的占位形式。',
  },
])

/**
 * 不该被扫描的文件：检查器自己的规则定义。
 *
 * 这是真实撞到的自指问题：`lib/leak-check.js` 里写满了示例路径
 * （`C:\Users\<name>`、`/home/alice`、`c:\users\name`），它们是**规则的一部分**，
 * 不是泄露。扫描自己会稳定产生 3 条 error，把 `check` 判成「现在发布必然失败」——
 * 一个专门修泄露的插件，被自己的规则挡在发布之外。
 *
 * 单纯把它们改成占位写法不行：`/home/alice` 是「后跟空格也要命中」这条规则的
 * 活样本，改掉就失去了说明力。所以按文件排除，并把规则文本单独列出。
 */
const SELF_RULE_FILES = Object.freeze(['lib/leak-check.js'])

/**
 * 判断某个文件是否应跳过扫描。
 * @param file - 包内相对路径。
 * @returns true 表示跳过。
 */
export function isSelfRuleFile(file) {
  const normalized = String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  return SELF_RULE_FILES.includes(normalized)
}

/** 只扫这些后缀的文本文件；二进制文件跳过。 */
const TEXT_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.txt', '.yml', '.yaml', '.svg', '.html', '.css'])

/**
 * 扫描一批文件的内容，找出可能泄露的敏感信息。
 *
 * @param files - `Array<{ path, content }>`，path 为包内相对路径。
 * @returns 结构化扫描结果。
 */
export function scanForLeaks(files) {
  const findings = []
  const perRule = new Map()
  const list = Array.isArray(files) ? files : []

  for (const file of list) {
    if (typeof file?.content !== 'string') continue
    const relative = String(file.path ?? '?')
    // 检查器自己的规则文件跳过：那里面的路径是示例，不是泄露。
    if (isSelfRuleFile(relative)) continue
    // 二进制或无意义的大文件直接跳过。
    if (!isTextPath(relative)) continue
    if (file.content.length > MAX_SCAN_BYTES) continue

    const lines = file.content.split(/\r?\n/)
    for (const rule of RULES) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        // 重置 lastIndex：正则带 g 标志，跨行复用必须复位。
        rule.pattern.lastIndex = 0
        let match
        while ((match = rule.pattern.exec(line)) !== null) {
          const raw = match[0]
          if (isAllowed(rule, raw)) continue
          // 回看整行：127.0.0.1:<port> 这类写法单看命中片段判断不出来。
          if (isPlaceholderInLine(line, match.index, raw)) continue
          const count = perRule.get(rule.code) ?? 0
          if (count >= MAX_REPORTS_PER_RULE) break
          perRule.set(rule.code, count + 1)
          findings.push({
            level: rule.level,
            code: rule.code,
            message: `${relative}:${index + 1} 命中「${rule.label}」：${mask(raw)}`,
            file: relative,
            line: index + 1,
            rule: rule.code,
            label: rule.label,
            why: rule.why,
            // 片段一律脱敏：报告本身不能再成为一份泄露清单。
            snippet: mask(raw),
          })
          // 同一行同一条规则只报一次，避免把一行里的多个匹配刷成多条。
          break
        }
      }
    }
  }

  if (findings.length === 0) {
    return { ok: true, findings: [], summary: '没有在待发布文件里发现个人身份信息或本机路径。' }
  }

  const errors = findings.filter((entry) => entry.level === 'error')
  const warns = findings.filter((entry) => entry.level === 'warn')
  return {
    ok: errors.length === 0,
    findings,
    errorCount: errors.length,
    warnCount: warns.length,
    summary: errors.length > 0
      ? `发现 ${errors.length} 处不该公开的个人信息或凭据${warns.length > 0 ? `，另有 ${warns.length} 处需要人工判断` : ''}。npm 不允许覆盖已发布版本，这些内容一旦发出去只能用 unpublish 或提版本补救。`
      : `没有阻断级泄露，但有 ${warns.length} 处需要人工判断。`,
  }
}

/**
 * 判断某个匹配是否属于规则允许的例外。
 *
 * 两个考虑：
 * 1. 规则自带的 `allow` 白名单（例如 example.com 的邮箱）。
 * 2. **占位符不算泄露。** 文档里写 `C:\Users\<user>` 或 `E:\<project>` 时，
 *    正则照样会命中，但那是正确写法而不是实况。若不放过这些，
 *    规则会逼着人把文档改成不含路径的样子，反而降低可读性。
 *
 * @param rule - 规则。
 * @param raw - 命中的原文。
 * @returns true 表示可以放过。
 */
function isAllowed(rule, raw) {
  if (isPlaceholderPath(raw)) return true
  if (!Array.isArray(rule.allow)) return false
  return rule.allow.some((pattern) => pattern.test(raw))
}

/**
 * 判断一个路径片段是不是占位符而不是真实路径。
 *
 * @param raw - 命中的原文。
 * @returns true 表示是占位写法。
 */
export function isPlaceholderPath(raw) {
  const text = String(raw ?? '')
  // <user> / <name> / <project> 这类尖括号占位
  if (/[<>]/.test(text)) return true
  // C:\Users\... 这类省略写法
  if (/\\{1,2}\.\.\.$/.test(text)) return true
  // ${HOME} / %USERPROFILE% / ~ 这类变量写法
  if (/\$\{|%[A-Za-z_]+%|^~/.test(text)) return true
  // (user) / (name) 这类括号占位
  if (/\([a-z]+\)$/i.test(text)) return true
  // 主目录后紧跟占位段（C:\Users\ 后面是 <user> 时正则只吃到目录本身）。
  if (/[\\/](?:Users|home)[\\/]?$/i.test(text)) return true
  return false
}

/**
 * 判断一行里某个匹配附近的文本是否已经把端口写成占位符。
 *
 * `http://127.0.0.1:<port>` 的正则只匹配到 `127.0.0.1`（因为 `<` 不是数字），
 * 单看命中的片段无法判断它是不是示例，必须回看原文。
 *
 * @param line - 整行原文。
 * @param index - 命中位置。
 * @param raw - 命中的片段。
 * @returns true 表示是占位写法。
 */
function isPlaceholderInLine(line, index, raw) {
  const after = String(line ?? '').slice(index + String(raw ?? '').length)
  // 紧接着写的是 :<port> / :{port} / :PORT 这类占位。
  if (/^\s*:\s*(?:<[^>]*>|\$\{[^}]*\}|%[A-Za-z_]+%|[A-Z_]{2,})/.test(after)) return true
  return false
}

/**
 * 判断文件后缀是否值得扫描。
 * @param file - 包内相对路径。
 * @returns true 表示是文本文件。
 */
function isTextPath(file) {
  const lower = String(file ?? '').toLowerCase()
  const base = lower.split('/').pop() ?? ''
  // 无后缀的常见文本文件名。
  if (['license', 'licence', 'notice', 'readme', 'changelog', 'authors'].includes(base)) return true
  return TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * 把命中片段脱敏后再放进报告。
 *
 * 报告里如果原样保留邮箱或 token，就等于又生成了一份泄露清单——
 * 工具输出会被保存进会话历史、日志，也可能被贴到别处。
 *
 * @param raw - 原始片段。
 * @returns 脱敏后的片段。
 */
export function mask(raw) {
  const text = String(raw ?? '')
  if (text.length === 0) return ''
  // 邮箱：保留域名，隐去本地部分。
  const email = /^([^@\s]+)@([^@\s]+)$/.exec(text)
  if (email !== null) {
    const local = email[1]
    const head = local.slice(0, 1)
    return `${head}${'*'.repeat(Math.max(2, local.length - 1))}@${email[2]}`
  }
  // 令牌：只留前 4 位。
  //
  // 这里必须覆盖**所有** `leak-generic-token` 认得的前缀，包括 AWS 的 `AKIA`。
  // 曾经漏了它：规则能匹配 `AKIA[0-9A-Z]{16}`，但 mask 不认识这个前缀，
  // 于是走兜底的 `return text` 把密钥**原样**写进报告——
  // 一个专门修泄露的插件，自己又造了一处泄露。
  if (/^(?:npm_|ghp_|sk-|github_pat_|AKIA)/.test(text)) {
    return `${text.slice(0, 4)}${'*'.repeat(8)}（长度 ${text.length}）`
  }
  // 用户目录：隐去用户名。
  const winHome = /^([A-Za-z]:\\{1,2}Users\\{1,2})([^\\\s]+)(.*)$/.exec(text)
  if (winHome !== null) return `${winHome[1]}<user>${winHome[3]}`
  const posixHome = /^(\/(?:home|Users)\/)([^/]+)(.*)$/.exec(text)
  if (posixHome !== null) return `${posixHome[1]}<user>${posixHome[3]}`
  // 回环地址带具体端口：端口本身可能暴露本机跑的是哪个代理/服务，
  // 报告会被写进会话历史与日志，所以隐去端口。
  const loopback = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d{2,5})?$/.exec(text)
  if (loopback !== null) return loopback[2] === undefined ? text : `${loopback[1]}:<port>`
  // 其它保持原样即可：绝对路径本身不是秘密，秘密是用户名与项目名，
  // 但那两者只有在与主目录组合时才构成身份信息，这里保留上下文更有用。
  return text
}

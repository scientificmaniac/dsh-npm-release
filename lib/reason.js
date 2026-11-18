/**
 * 结构化失败：`category → message → hint`。
 *
 * 三段式不是格式偏好，而是这次发布事故里唯一真正省时间的东西：
 * 一句 `403 Forbidden` 能指三个完全不同的方向（token 的包级 scope、token 没写权限、
 * 账号没有该 scope），只有 `hint` 能把人直接送到修复动作上。
 *
 * @module dsh-npm-release/lib/reason
 */

/**
 * 构造一个带修复方向的原因对象。
 *
 * @param category - 机器可读的分类。
 * @param message - 发生了什么（可核对的事实）。
 * @param hint - 下一步该做什么。
 * @param extra - 需要一起带出的附加字段。
 * @returns 原因对象。
 */
export function reason(category, message, hint, extra = {}) {
  return { category, message, hint, ...extra }
}

/**
 * 把原因对象渲染成人类可读的一行（工具结果与失败信息共用）。
 * @param value - 原因对象。
 * @returns 文本。
 */
export function describeReason(value) {
  if (value === undefined || value === null) return ''
  const head = value.message ?? String(value)
  const hint = typeof value.hint === 'string' && value.hint.length > 0 ? `\n  修复方向：${value.hint}` : ''
  return `${head}${hint}`
}

/**
 * 一个检查项的等级排序，用于把最严重的问题排到前面。
 */
const LEVEL_ORDER = Object.freeze({ error: 0, warn: 1, info: 2 })

/**
 * 按等级排序并去重检查项。
 * @param findings - 检查项数组。
 * @returns 排序后的新数组。
 */
export function sortFindings(findings) {
  const seen = new Set()
  return [...findings]
    .filter((entry) => {
      const key = `${entry.level}|${entry.code}|${entry.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => (LEVEL_ORDER[left.level] ?? 9) - (LEVEL_ORDER[right.level] ?? 9))
}

/**
 * 汇总检查项：有没有阻断项。
 * @param findings - 检查项数组。
 * @returns true 表示可以继续。
 */
export function isBlocking(findings) {
  return !findings.some((entry) => entry.level === 'error')
}

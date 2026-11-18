/** 图标几何自检：确认坐标落在 viewBox 内、没有禁用元素。 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8')
const stripped = source
  .replace(/#[0-9a-fA-F]{3,8}/g, ' ')
  .replace(/\b(width|height|viewBox|id|version|xmlns|role|aria-label)="[^"]*"/g, ' ')

const numbers = [...stripped.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]))
const min = Math.min(...numbers)
const max = Math.max(...numbers)

const forbidden = [
  ['<text', /<text[\s>]/i],
  ['<image', /<image[\s>]/i],
  ['foreignObject', /<foreignObject/i],
  ['<script', /<script[\s>]/i],
  ['<style', /<style[\s>]/i],
  ['animation', /<animate/i],
  ['event handler', /\son[a-z]+\s*=/i],
  ['remote reference', /(?:href|src)\s*=\s*"(?:https?:)?\/\//i],
]

const problems = []
for (const [label, pattern] of forbidden) {
  if (pattern.test(source)) problems.push(`含禁用项：${label}`)
}
if (min < 0 || max > 36) problems.push(`坐标越界：${min}..${max}，viewBox 是 0 0 36 36`)
if (Buffer.byteLength(source) > 256 * 1024) problems.push('超过 256 KiB 上限')
// 每个 id 引用都要有对应定义，否则渐变会静默失效（渲染成黑色或透明）。
const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
const refs = [...source.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1])
for (const ref of refs) {
  if (!ids.includes(ref)) problems.push(`url(#${ref}) 没有对应的 id 定义`)
}

console.log(`文件：icon.svg`)
console.log(`体积：${Buffer.byteLength(source)} 字节`)
console.log(`几何坐标：${min} .. ${max}`)
console.log(`渐变引用：${refs.length === 0 ? '无' : refs.join(', ')}（已定义 ${ids.length} 个 id）`)
if (problems.length === 0) {
  console.log('自检通过。')
} else {
  console.log('自检失败：')
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exitCode = 1
}

/**
 * 用假的 ctx 跑一遍插件：验证 apply 能注册工具，并真实执行各动作。
 *
 * 这不是 mock 测试——它调的是真实的 npm 与 registry，只是把 Host 上下文换成最小桩。
 */
import { apply, name, inject } from '../index.js'

const tools = new Map()
const provided = new Map()
const ctx = {
  effect(factory, label) {
    const disposer = factory()
    console.log(`[effect] ${label}`)
    return () => disposer?.()
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  },
  provide(key, value) {
    provided.set(key, value)
  },
}

apply(ctx, {})

console.log('\n插件名:', name, '| inject:', JSON.stringify(inject))
console.log('注册的工具:', [...tools.keys()].join(', '))
console.log('提供的服务:', [...provided.keys()].join(', '))

const tool = tools.get('npm_release')
if (tool === undefined) throw new Error('npm_release 没有注册')

const action = process.argv[2] ?? 'status'
const target = process.argv[3]
const extra = process.argv[4] === undefined ? {} : JSON.parse(process.argv[4])

console.log(`\n===== 执行 action=${action} dir=${target ?? '(cwd)'} =====`)
const text = await tool.execute({ action, ...(target === undefined ? {} : { package_dir: target }), ...extra })
console.log(text)

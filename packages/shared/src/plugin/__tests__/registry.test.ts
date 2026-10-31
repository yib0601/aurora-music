import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerPlugin,
  getPlugin,
  listPlugins,
  hasCapability,
  clearPluginsForTest,
} from '../registry'
import type { SourcePlugin } from '../types'

/**
 * 注册表是这个框架的唯一定位入口，它的语义错了会连带所有消费方。
 * 这里只断言契约，不碰任何真实插件实现。
 */

function makePlugin(id: string, extra?: Partial<SourcePlugin>): SourcePlugin {
  return {
    id,
    displayNameKey: 'core.platform.aurora',
    version: '1.0.0',
    capabilities: ['search'],
    ...extra,
  }
}

describe('插件注册表', () => {
  beforeEach(() => {
    clearPluginsForTest()
  })

  it('注册后可按 id 取回同一个实例', () => {
    const p = makePlugin('demo')
    registerPlugin(p)
    expect(getPlugin('demo')).toBe(p)
  })

  it('未注册的 id 返回 undefined（调用方据此降级，不抛错）', () => {
    expect(getPlugin('nope')).toBeUndefined()
    expect(getPlugin('')).toBeUndefined()
    // 非字符串入参同样不该炸：IPC 入参按不可信处理
    expect(getPlugin(undefined as unknown as string)).toBeUndefined()
  })

  it('listPlugins 按注册顺序返回，顺序稳定', () => {
    for (const id of ['alpha', 'beta', 'gamma']) registerPlugin(makePlugin(id))
    expect(listPlugins().map((p) => p.id)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('同 id 重复注册是「替换实现」且保留原位置', () => {
    registerPlugin(makePlugin('alpha'))
    registerPlugin(makePlugin('beta'))
    const replacement = makePlugin('alpha', { version: '2.0.0' })
    registerPlugin(replacement)

    // 位置不变（否则设置页列表会随插件热更新抖动），实现被换掉
    expect(listPlugins().map((p) => p.id)).toEqual(['alpha', 'beta'])
    expect(getPlugin('alpha')?.version).toBe('2.0.0')
  })

  it('非法 id 在注册这一关就被拒绝（它会成为凭证文件名）', () => {
    // 凭证落盘用 `${pluginId}.bin`，路径分隔符与 .. 必须挡在注册期
    for (const bad of ['', '../evil', 'a/b', '中文', 'x'.repeat(65)]) {
      expect(() => registerPlugin(makePlugin(bad))).toThrow(/invalid plugin id/)
    }
  })

  it('hasCapability 按声明判断（仅供展示，不替代方法存在性判定）', () => {
    const p = makePlugin('demo', { capabilities: ['search', 'auth'] })
    expect(hasCapability(p, 'search')).toBe(true)
    expect(hasCapability(p, 'auth')).toBe(true)
    expect(hasCapability(p, 'lyrics')).toBe(false)
  })
})

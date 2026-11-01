import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_STORAGE_PLUGIN_ID,
  clearStoragePluginsForTest,
  getStoragePlugin,
  librarySourcePluginId,
  listStoragePluginMeta,
  listStoragePlugins,
  registerStoragePlugin,
  registeredStoragePluginIds,
  storagePluginOf,
} from '../registry'
import { storageCapabilitiesOf, type StoragePlugin } from '../types'

/**
 * 注册表是存储插件的唯一定位入口，语义错了会连带扫描管线与播放代理。
 * 这里只断言契约本身，不碰真实协议实现。
 */
function makePlugin(id: string, extra?: Partial<StoragePlugin>): StoragePlugin {
  return {
    id,
    displayNameKey: 'sources.webdav.title',
    version: '1.0.0',
    fields: [],
    ...extra,
  }
}

afterEach(() => {
  // 只清测试态：本文件不 import ../index（内置注册由 index.ts 的 import 期副作用完成），
  // 清空不会影响其它测试文件（vitest 每个文件独立模块图）
  clearStoragePluginsForTest()
})

describe('存储插件注册表', () => {
  it('注册后可按 id 取回同一个实例', () => {
    const p = makePlugin('demo')
    registerStoragePlugin(p)
    expect(getStoragePlugin('demo')).toBe(p)
  })

  it('未注册的 id 返回 undefined（调用方据此降级，不抛错）', () => {
    expect(getStoragePlugin('nope')).toBeUndefined()
    expect(getStoragePlugin('')).toBeUndefined()
    // 非字符串入参不该炸：IPC 入参按不可信处理
    expect(getStoragePlugin(undefined as unknown as string)).toBeUndefined()
  })

  it('listStoragePlugins 按注册顺序返回，顺序稳定', () => {
    for (const id of ['alpha', 'beta', 'gamma']) registerStoragePlugin(makePlugin(id))
    expect(listStoragePlugins().map((p) => p.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(registeredStoragePluginIds()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('同 id 重复注册是「替换实现」且保留原位置（幂等注册）', () => {
    registerStoragePlugin(makePlugin('alpha'))
    registerStoragePlugin(makePlugin('beta'))
    const replacement = makePlugin('alpha', { version: '2.0.0' })
    registerStoragePlugin(replacement)

    // 位置不变（否则 UI 列表会随插件热更新抖动），实现被换掉
    expect(listStoragePlugins().map((p) => p.id)).toEqual(['alpha', 'beta'])
    expect(getStoragePlugin('alpha')?.version).toBe('2.0.0')
    // 幂等：重复注册同一个对象不会产生重复条目
    registerStoragePlugin(replacement)
    expect(listStoragePlugins()).toHaveLength(2)
  })

  it('非法 id 在注册这一关就被拒绝', () => {
    for (const bad of ['', 'WebDAV?', '-lead', 'a b', 'x'.repeat(65)]) {
      expect(() => registerStoragePlugin(makePlugin(bad))).toThrow(/invalid plugin id/)
    }
    // 合法形状：小写字母数字开头，允许 . _ -
    expect(() => registerStoragePlugin(makePlugin('my-nas.smb_2'))).not.toThrow()
  })

  it('缺少声明式字段的插件在注册期被拦下（UI 会渲染出空表单而不报错）', () => {
    const broken = makePlugin('broken', { fields: undefined as never })
    expect(() => registerStoragePlugin(broken)).toThrow(/must declare a fields array/)
  })
})

describe('配置 → 插件判定', () => {
  it('显式 pluginId 优先于 kind', () => {
    expect(librarySourcePluginId({ kind: 'webdav', pluginId: 'smb' })).toBe('smb')
    // 空白串按缺失处理
    expect(librarySourcePluginId({ kind: 'webdav', pluginId: '   ' })).toBe('webdav')
  })

  it('老配置只有 kind 时按 kind 推导（零迁移可读）', () => {
    expect(librarySourcePluginId({ kind: 'webdav' })).toBe('webdav')
  })

  it('两者都缺时回落默认插件', () => {
    expect(librarySourcePluginId({ kind: '' })).toBe(DEFAULT_STORAGE_PLUGIN_ID)
    expect(librarySourcePluginId(null)).toBe(DEFAULT_STORAGE_PLUGIN_ID)
    expect(librarySourcePluginId(undefined)).toBe(DEFAULT_STORAGE_PLUGIN_ID)
  })

  it('storagePluginOf 是「配置 → 插件」的单一入口', () => {
    const p = makePlugin('webdav')
    registerStoragePlugin(p)
    expect(storagePluginOf({ kind: 'webdav' })).toBe(p)
    expect(storagePluginOf({ kind: 'local', pluginId: 'webdav' })).toBe(p)
    // 未注册的 pluginId 不回落默认插件：配置错误要显式降级，不能悄悄换协议
    expect(storagePluginOf({ kind: 'nfs' })).toBeUndefined()
  })
})

describe('listStoragePluginMeta（纯数据，可过 IPC）', () => {
  it('字段与能力齐备，且顺序与 listStoragePlugins 一致', () => {
    registerStoragePlugin(
      makePlugin('alpha', {
        displayNameKey: 'sources.webdav.title',
        descriptionKey: 'sources.webdav.desc',
        fields: [{ key: 'baseUrl', labelKey: 'sources.webdav.baseUrlLabel', kind: 'url' }],
        probe: async () => ({ ok: true, message: 'x' }),
      })
    )
    registerStoragePlugin(makePlugin('beta'))
    const meta = listStoragePluginMeta()
    expect(meta.map((m) => m.id)).toEqual(listStoragePlugins().map((p) => p.id))
    expect(meta[0]).toEqual({
      id: 'alpha',
      displayNameKey: 'sources.webdav.title',
      descriptionKey: 'sources.webdav.desc',
      version: '1.0.0',
      fields: [{ key: 'baseUrl', labelKey: 'sources.webdav.baseUrlLabel', kind: 'url' }],
      capabilities: ['probe'],
      // 启停状态随 meta 一起下发：新增来源的类型选择据它过滤掉已停用的协议
      enabled: true,
    })
  })

  it('停用的插件仍出现在 meta 里，但 enabled 为 false（条目不能消失，否则开关就没了）', async () => {
    registerStoragePlugin(makePlugin('alpha', { probe: async () => ({ ok: true, message: 'x' }) }))
    const { setPluginEnabled } = await import('../../availability')
    setPluginEnabled('alpha', false)
    try {
      const meta = listStoragePluginMeta()
      // 条目仍在：删掉它会让用户没有任何入口把开关打开
      expect(meta.map((m) => m.id)).toContain('alpha')
      expect(meta.find((m) => m.id === 'alpha')?.enabled).toBe(false)
    } finally {
      // 启停表是模块级状态，必须还原，否则会影响同文件后续用例
      setPluginEnabled('alpha', true)
    }
  })

  it('meta 里不含函数（Electron IPC 走 structured clone，函数会抛 DataCloneError）', () => {
    registerStoragePlugin(
      makePlugin('alpha', {
        listAudio: async () => [],
        openRange: async () => new Response(''),
        openStream: async () => new Response(''),
        probe: async () => ({ ok: true, message: 'ok' }),
      })
    )
    const meta = listStoragePluginMeta()
    expect(() => structuredClone(meta)).not.toThrow()
    const walk = (v: unknown): void => {
      expect(typeof v).not.toBe('function')
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(meta)
    // 能力清单由方法存在性派生，四项齐全且顺序固定
    expect(meta[0].capabilities).toEqual(['listAudio', 'openRange', 'openStream', 'probe'])
  })

  it('meta 的字段数组是拷贝：调用方改动不会污染注册表里的插件', () => {
    registerStoragePlugin(
      makePlugin('alpha', {
        fields: [{ key: 'baseUrl', labelKey: 'sources.webdav.baseUrlLabel', kind: 'url' }],
      })
    )
    const meta = listStoragePluginMeta()
    ;(meta[0].fields as unknown as Array<{ key: string }>)[0].key = 'hacked'
    expect(getStoragePlugin('alpha')?.fields[0].key).toBe('baseUrl')
  })
})

describe('storageCapabilitiesOf：能力清单只有一份真源', () => {
  it('按方法存在性派生，不做形态判断', () => {
    expect(storageCapabilitiesOf(makePlugin('a'))).toEqual([])
    expect(
      storageCapabilitiesOf(makePlugin('b', { openRange: async () => new Response('') }))
    ).toEqual(['openRange'])
    expect(
      storageCapabilitiesOf(
        makePlugin('c', {
          listAudio: async () => [],
          probe: async () => ({ ok: true, message: 'ok' }),
        })
      )
    ).toEqual(['listAudio', 'probe'])
  })
})

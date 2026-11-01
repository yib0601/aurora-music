import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_AVAILABILITY_FILE_VERSION,
  clearPluginAvailabilityForTest,
  disabledPluginIds,
  isPluginEnabled,
  parseDisabledPluginIds,
  serializeDisabledPluginIds,
  setDisabledPluginIds,
  setPluginEnabled,
} from '../availability'
import { pluginForSource } from '../executor'
import { storagePluginOf } from '../storage/registry'
// 从 `../storage`（出口）取而不是 `../storage/registry`：内置存储插件的注册是
// **该出口的模块求值副作用**。直接引 registry 会拿到空表，联动用例会静默变成
// "未注册也是 undefined，断言照样通过"的假绿灯。
import { getStoragePlugin } from '../storage'
import type { OnlineSourceConfig } from '../../types'

/**
 * 启停表是**模块级单例内存态**（不是每实例一份），所以每个用例前后都必须清。
 * 少了这层清理，一个用例的停用会渗到下一个用例 —— 而症状是别处的断言偶发变红，
 * 排查成本远高于这里多写两行。
 */
beforeEach(() => {
  clearPluginAvailabilityForTest()
})
afterEach(() => {
  clearPluginAvailabilityForTest()
})

/** 一条最小的源配置：只声明由哪个插件执行，不碰真实网络 */
function sourceOf(pluginId: string): OnlineSourceConfig {
  return { id: `src-${pluginId}`, name: `Src ${pluginId}`, sourceUrl: '', pluginId }
}

describe('默认启用：没写过盘的 id 一律可用', () => {
  it('未知 id 是启用的', () => {
    expect(isPluginEnabled('never-touched')).toBe(true)
    expect(isPluginEnabled('aurora')).toBe(true)
    expect(disabledPluginIds()).toEqual([])
  })

  it('空 / 非字符串 id 返回 true（门禁不替注册表判"这个 id 不存在"）', () => {
    // 坏 id 该由"查注册表失败"那条既有分支回答；在这里回答"被停用"会让
    // 用户看到一个根本不存在的开关被关掉了。
    expect(isPluginEnabled('')).toBe(true)
    expect(isPluginEnabled('   ')).toBe(true)
    expect(isPluginEnabled(undefined)).toBe(true)
    expect(isPluginEnabled(null)).toBe(true)
    expect(isPluginEnabled(42)).toBe(true)
  })
})

describe('开关：设置、读回与返回值', () => {
  it('停用后 isPluginEnabled 为 false，重新启用后为 true', () => {
    expect(setPluginEnabled('demo', false)).toBe(true)
    expect(isPluginEnabled('demo')).toBe(false)
    expect(setPluginEnabled('demo', true)).toBe(true)
    expect(isPluginEnabled('demo')).toBe(true)
  })

  it('返回值表达"是否发生变化"，重复设置同一状态返回 false', () => {
    expect(setPluginEnabled('demo', false)).toBe(true)
    // 第二次停用已经是这个状态：没有变化，调用方据此跳过落盘与重渲染
    expect(setPluginEnabled('demo', false)).toBe(false)
    expect(setPluginEnabled('demo', true)).toBe(true)
    expect(setPluginEnabled('demo', true)).toBe(false)
  })

  it('只影响被拨动的那个 id', () => {
    setPluginEnabled('alpha', false)
    expect(isPluginEnabled('alpha')).toBe(false)
    expect(isPluginEnabled('beta')).toBe(true)
  })

  it('disabledPluginIds 按加入顺序给出，便于稳定落盘', () => {
    setPluginEnabled('beta', false)
    setPluginEnabled('alpha', false)
    expect(disabledPluginIds()).toEqual(['beta', 'alpha'])
    // 开回来就从列表里消失
    setPluginEnabled('beta', true)
    expect(disabledPluginIds()).toEqual(['alpha'])
  })

  it('返回的是快照，外部改动不污染内部状态', () => {
    setPluginEnabled('alpha', false)
    const ids = disabledPluginIds()
    ids.push('beta')
    expect(disabledPluginIds()).toEqual(['alpha'])
    expect(isPluginEnabled('beta')).toBe(true)
  })
})

describe('非法 / 空 id 静默忽略', () => {
  it('setPluginEnabled 对坏 id 返回 false 且不落任何状态', () => {
    for (const bad of ['', '   ', '../evil', 'a/b', '中文', 'x'.repeat(65)]) {
      expect(setPluginEnabled(bad, false)).toBe(false)
    }
    expect(disabledPluginIds()).toEqual([])
  })

  it('非字符串入参同样静默忽略（入参来自 UI 与落盘文件两条不可信来源）', () => {
    expect(setPluginEnabled(undefined, false)).toBe(false)
    expect(setPluginEnabled(null, false)).toBe(false)
    expect(setPluginEnabled(123, false)).toBe(false)
    expect(setPluginEnabled({ id: 'x' }, false)).toBe(false)
    expect(disabledPluginIds()).toEqual([])
  })

  it('id 前后空白按归一后的值记录', () => {
    expect(setPluginEnabled('  demo  ', false)).toBe(true)
    expect(isPluginEnabled('demo')).toBe(false)
    expect(disabledPluginIds()).toEqual(['demo'])
  })
})

describe('setDisabledPluginIds：启动时全量灌入', () => {
  it('全量替换而不是累加', () => {
    setDisabledPluginIds(['alpha', 'beta'])
    expect(disabledPluginIds()).toEqual(['alpha', 'beta'])
    setDisabledPluginIds(['gamma'])
    // 上一次的 alpha / beta 必须消失：这是"文件是唯一事实源"的语义
    expect(disabledPluginIds()).toEqual(['gamma'])
    expect(isPluginEnabled('alpha')).toBe(true)
  })

  it('空数组 = 全部启用', () => {
    setDisabledPluginIds(['alpha'])
    setDisabledPluginIds([])
    expect(disabledPluginIds()).toEqual([])
    expect(isPluginEnabled('alpha')).toBe(true)
  })

  it('坏条目逐条跳过，好条目照常生效（一条坏数据不该让所有插件消失）', () => {
    setDisabledPluginIds(['alpha', '', '../evil', 42, null, '中文', 'beta'])
    expect(disabledPluginIds()).toEqual(['alpha', 'beta'])
  })

  it('重复 id 去重，保持首次出现的位置', () => {
    setDisabledPluginIds(['beta', 'alpha', 'beta'])
    expect(disabledPluginIds()).toEqual(['beta', 'alpha'])
  })

  it('非数组入参视为空（清空而不是抛错）', () => {
    setDisabledPluginIds(['alpha'])
    setDisabledPluginIds(undefined as unknown as string[])
    expect(disabledPluginIds()).toEqual([])
    setDisabledPluginIds('alpha' as unknown as string[])
    expect(disabledPluginIds()).toEqual([])
  })
})

describe('parseDisabledPluginIds：三种形态归一', () => {
  it('形态一：完整对象 { version, disabled: [...] }', () => {
    expect(
      parseDisabledPluginIds({ version: PLUGIN_AVAILABILITY_FILE_VERSION, disabled: ['a', 'b'] })
    ).toEqual(['a', 'b'])
  })

  it('形态二：裸数组（用户手写最省事的形态）', () => {
    expect(parseDisabledPluginIds(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('形态三：坏数据 / 空值一律归一到空数组', () => {
    for (const bad of [undefined, null, 42, 'a', {}, { disabled: 'a' }, { disabled: null }]) {
      expect(parseDisabledPluginIds(bad)).toEqual([])
    }
  })

  it('坏条目与重复条目在解析这一层就被剔掉', () => {
    expect(parseDisabledPluginIds({ disabled: ['a', '', 'a', '../evil', 7, 'b'] })).toEqual([
      'a',
      'b',
    ])
  })

  it('version 不参与判定（本版只有一种形状，读旧文件不该因版本号抛错）', () => {
    expect(parseDisabledPluginIds({ version: 99, disabled: ['a'] })).toEqual(['a'])
  })
})

describe('serialize → parse 往返', () => {
  it('往返后 id 集合不变', () => {
    const ids = ['demo', 'aurora', 'a.b_c-d']
    const text = serializeDisabledPluginIds(ids)
    expect(parseDisabledPluginIds(JSON.parse(text))).toEqual(ids)
  })

  it('落盘形状带 version 且可被人工阅读', () => {
    const text = serializeDisabledPluginIds(['demo'])
    expect(text).toContain('\n') // 缩进过，不是压缩的一行
    const parsed = JSON.parse(text) as { version: number; disabled: string[] }
    expect(parsed.version).toBe(PLUGIN_AVAILABILITY_FILE_VERSION)
    expect(parsed.disabled).toEqual(['demo'])
  })

  it('序列化时也过滤坏 id（坏数据不进文件）', () => {
    const text = serializeDisabledPluginIds(['demo', '', '../evil'])
    expect((JSON.parse(text) as { disabled: string[] }).disabled).toEqual(['demo'])
  })

  it('空列表也能往返（首次使用的落盘形态）', () => {
    const text = serializeDisabledPluginIds([])
    expect((JSON.parse(text) as { disabled: string[] }).disabled).toEqual([])
    expect(parseDisabledPluginIds(JSON.parse(text))).toEqual([])
  })

  it('灌入 → 序列化 → 再灌入，状态等价', () => {
    setDisabledPluginIds(['alpha', 'beta'])
    const text = serializeDisabledPluginIds(disabledPluginIds())
    clearPluginAvailabilityForTest()
    setDisabledPluginIds(parseDisabledPluginIds(JSON.parse(text)))
    expect(disabledPluginIds()).toEqual(['alpha', 'beta'])
  })
})

describe('clearPluginAvailabilityForTest', () => {
  it('清空后全部恢复启用', () => {
    setPluginEnabled('alpha', false)
    setPluginEnabled('beta', false)
    clearPluginAvailabilityForTest()
    expect(disabledPluginIds()).toEqual([])
    expect(isPluginEnabled('alpha')).toBe(true)
    expect(isPluginEnabled('beta')).toBe(true)
  })
})

describe('联动：执行门禁真的吃这个开关', () => {
  it('停用 aurora 后 pluginForSource 返回 undefined，开回来又拿得到', () => {
    // 先用真实内置插件确认"默认可用"，否则后面的 undefined 可能只是没注册
    expect(pluginForSource(sourceOf('aurora'))?.id).toBe('aurora')

    setPluginEnabled('aurora', false)
    expect(pluginForSource(sourceOf('aurora'))).toBeUndefined()

    setPluginEnabled('aurora', true)
    expect(pluginForSource(sourceOf('aurora'))?.id).toBe('aurora')
  })

  it('停用某个插件不影响别的插件取用', () => {
    setPluginEnabled('lx', false)
    expect(pluginForSource(sourceOf('lx'))).toBeUndefined()
    expect(pluginForSource(sourceOf('aurora'))?.id).toBe('aurora')
  })

  it('门禁按插件 id 生效：源配置里的 kind 兼容分支也拦得住', () => {
    // 只给 kind 的老配置由 pluginIdOf 推导出 'aurora'，停用同样生效
    setPluginEnabled('aurora', false)
    expect(pluginForSource({ id: 'legacy', name: 'Legacy', sourceUrl: '' })).toBeUndefined()
  })

  it('停用 webdav 后 storagePluginOf 返回 undefined，开回来又拿得到', () => {
    expect(getStoragePlugin('webdav')).toBeDefined() // 内置已注册（口气来自 ../storage 的副作用）
    expect(storagePluginOf({ kind: 'webdav' })?.id).toBe('webdav')

    setPluginEnabled('webdav', false)
    expect(storagePluginOf({ kind: 'webdav' })).toBeUndefined()
    // 显式 pluginId 与 kind 推导两条路都该拦
    expect(storagePluginOf({ kind: 'local', pluginId: 'webdav' })).toBeUndefined()

    setPluginEnabled('webdav', true)
    expect(storagePluginOf({ kind: 'webdav' })?.id).toBe('webdav')
  })

  it('停用存储插件不影响音源插件（两张表、一套启停）', () => {
    setPluginEnabled('webdav', false)
    expect(storagePluginOf({ kind: 'webdav' })).toBeUndefined()
    expect(pluginForSource(sourceOf('aurora'))?.id).toBe('aurora')
  })
})

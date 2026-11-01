import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearPluginFailuresForTest,
  isolatePluginStep,
  notePluginFailure,
  pluginFailures,
  pluginStartupReport,
} from '../health'
import { ensureBuiltinsRegistered, resetBuiltinsRegistrationForTest } from '../builtins'
import { clearPluginsForTest, getPlugin, registerPlugin } from '../registry'
import { mountInstalled, clearInstalledForTest, installedManifests } from '../installed'
import { validatePluginManifest } from '../manifest/validate'
import { PLUGIN_MANIFEST_FORMAT, type PluginManifest } from '../manifest/types'
import type { SourcePlugin } from '../types'

/**
 * 插件加载隔离。
 *
 * 这一组断言的核心只有一句：**一条插件出错，绝不能把整批/整个启动带下去**。
 * 它同时也是"出错了要能告诉用户"的落点 —— 失败清单是 UI 提示的唯一数据源。
 */

function makePlugin(id: string): SourcePlugin {
  return {
    id,
    displayNameKey: 'core.platform.aurora',
    version: '1.0.0',
    capabilities: ['search'],
  }
}

function manifest(id: string, extra: Record<string, unknown> = {}): PluginManifest {
  const result = validatePluginManifest({
    format: PLUGIN_MANIFEST_FORMAT,
    id,
    name: `Demo ${id}`,
    version: '1.0.0',
    permissions: ['network'],
    hosts: ['api.example.com'],
    source: { search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } } },
    ...extra,
  })
  if (!result.ok) throw new Error(`invalid manifest: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

describe('失败登记表', () => {
  beforeEach(clearPluginFailuresForTest)

  it('起步为空（正常启动不该有任何人写它）', () => {
    expect(pluginFailures()).toEqual([])
  })

  it('记下 id / 阶段 / 原因', () => {
    notePluginFailure('installed', 'demo', new Error('boom'), 1000)
    const [failure] = pluginFailures()
    expect(failure).toMatchObject({ id: 'demo', stage: 'installed', reason: 'boom', at: 1000 })
  })

  it('非 Error 的抛出物也能取到可读原因（不能留空串）', () => {
    notePluginFailure('storage', 'x', 'plain text')
    notePluginFailure('builtin', 'y', undefined)
    expect(pluginFailures()[0].reason).toBe('plain text')
    // undefined 也要有一句话：UI 里空白原因等于"什么都没说"
    expect(pluginFailures()[1].reason.length).toBeGreaterThan(0)
  })

  it('id 不是字符串时记成空串（而不是 "undefined" 这种假 id）', () => {
    notePluginFailure('builtin', undefined, new Error('x'))
    expect(pluginFailures()[0].id).toBe('')
  })

  it('返回的清单是拷贝：调用方改它不该改到登记表', () => {
    notePluginFailure('builtin', 'a', new Error('x'))
    const copy = pluginFailures()
    copy[0].id = 'tampered'
    copy.push({ id: 'fake', stage: 'builtin', reason: '', at: 0 })
    expect(pluginFailures()).toHaveLength(1)
    expect(pluginFailures()[0].id).toBe('a')
  })
})

describe('isolatePluginStep：出错只记账，不抛出', () => {
  beforeEach(clearPluginFailuresForTest)

  it('正常执行时原样返回结果，且不留记录', () => {
    expect(isolatePluginStep('builtin', 'ok', () => 42)).toBe(42)
    expect(pluginFailures()).toEqual([])
  })

  it('抛错时返回 undefined 并记一条，调用方可以继续往下走', () => {
    const result = isolatePluginStep('installed', 'bad', () => {
      throw new Error('manifest exploded')
    })
    expect(result).toBeUndefined()
    expect(pluginFailures()).toHaveLength(1)
    expect(pluginFailures()[0]).toMatchObject({ id: 'bad', reason: 'manifest exploded' })
  })

  it('连续多个失败各自成条（不是只留最后一条）', () => {
    for (const id of ['a', 'b', 'c']) {
      isolatePluginStep('builtin', id, () => {
        throw new Error(id)
      })
    }
    expect(pluginFailures().map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('内置插件注册：一条坏了，其余照常注册', () => {
  beforeEach(() => {
    clearPluginsForTest()
    clearInstalledForTest()
    clearPluginFailuresForTest()
    resetBuiltinsRegistrationForTest()
  })

  it('正常路径：三个内置插件全部就位，且没有失败记录', () => {
    ensureBuiltinsRegistered()
    expect(getPlugin('aurora')).toBeDefined()
    expect(getPlugin('lx')).toBeDefined()
    expect(getPlugin('qishui')).toBeDefined()
    expect(pluginFailures()).toEqual([])
  })

  it('重复触发不会重新注册（失败也不会被反复重试刷屏）', () => {
    ensureBuiltinsRegistered()
    isolatePluginStep('builtin', 'noise', () => {
      throw new Error('noise')
    })
    ensureBuiltinsRegistered()
    // 第二次调用是 no-op：幂等标记仍然生效
    expect(pluginFailures()).toHaveLength(1)
  })
})

describe('mountInstalled：坏插件不拖垮其余插件', () => {
  beforeEach(() => {
    clearPluginsForTest()
    clearInstalledForTest()
    clearPluginFailuresForTest()
    resetBuiltinsRegistrationForTest()
  })

  it('构造阶段抛错的那条进 skipped(error)，同批其余照常挂载', () => {
    // 造一份"形状能过校验器、但读取字段时会炸"的清单：这是磁盘内容被手改/被截断后
    // 最接近的真实形态（校验器管的是**结构**，管不了某个字段读出来是否合法）。
    // 用 getter 抛错来稳定复现 `buildSourcePlugin` 里那条抛错路径。
    const broken = {
      ...manifest('broken'),
      get source(): never {
        throw new Error('corrupted manifest')
      },
    } as unknown as PluginManifest

    const result = mountInstalled({
      plugins: [
        { manifest: broken, record: { sha256: 'x' }, path: '/p/broken.json' },
        { manifest: manifest('good'), record: { sha256: 'y' }, path: '/p/good.json' },
      ],
      broken: [],
    })

    expect(result.mounted).toEqual(['good'])
    expect(result.skipped).toEqual([{ id: 'broken', reason: 'error' }])
    expect(getPlugin('good')).toBeDefined()
    // 坏的那条**不会**留在已安装表里：否则重装会被判成 duplicate，
    // 用户只能手动删目录才恢复（这是 registerInstalledPlugin 先构造后登记的理由）
    expect(installedManifests().map((m) => m.id)).not.toContain('broken')
    // 失败原因进了清单 —— UI 的提示与插件页的列表都只认这一份数据
    expect(pluginFailures()).toHaveLength(1)
    expect(pluginFailures()[0]).toMatchObject({ id: 'broken', stage: 'installed' })
  })

  it('全部正常时没有任何失败记录（隔离层不该产生噪音）', () => {
    const result = mountInstalled({
      plugins: [
        { manifest: manifest('a'), record: { sha256: '1' }, path: '/p/a.json' },
        { manifest: manifest('b'), record: { sha256: '2' }, path: '/p/b.json' },
      ],
      broken: [],
    })
    expect(result.mounted).toEqual(['a', 'b'])
    expect(pluginFailures()).toEqual([])
  })
})

describe('pluginStartupReport：喂给 UI 的形状', () => {
  beforeEach(clearPluginFailuresForTest)

  it('无参调用就是"什么都没发生"', () => {
    expect(pluginStartupReport()).toEqual({ mounted: [], broken: 0, failures: [] })
  })

  it('带着失败记录一起出（UI 据此提示用户）', () => {
    notePluginFailure('installed', 'demo', new Error('boom'))
    const report = pluginStartupReport({ mounted: ['ok'], broken: 2 })
    expect(report.mounted).toEqual(['ok'])
    expect(report.broken).toBe(2)
    expect(report.failures).toHaveLength(1)
  })

  it('坏的计数负数 / 非数字一律归零（不做"减掉一个"这种意外）', () => {
    expect(pluginStartupReport({ broken: -3 }).broken).toBe(0)
    expect(pluginStartupReport({ broken: Number.NaN }).broken).toBe(0)
  })

  it('清空后回到全好状态', () => {
    notePluginFailure('builtin', 'x', new Error('boom'))
    expect(pluginStartupReport().failures).toHaveLength(1)
    clearPluginFailuresForTest()
    expect(pluginStartupReport().failures).toEqual([])
  })
})

describe('注册表本身仍然严格（隔离只发生在调用处，不在注册表里）', () => {
  beforeEach(() => {
    clearPluginsForTest()
    resetBuiltinsRegistrationForTest()
  })

  it('直接调 registerPlugin 的非法 id 依然抛错', () => {
    let thrown = false
    try {
      registerPlugin(makePlugin(''))
    } catch {
      thrown = true
    }
    expect(thrown).toBe(true)
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  canInstall,
  clearInstalledForTest,
  guardedFetchOf,
  installedManifests,
  isInstalledPlugin,
  mountInstalled,
  pluginRegistered,
  registerInstalledPlugin,
  unregisterInstalledPlugin,
} from '../installed'
import { clearPluginsForTest, getPlugin, listPlugins } from '../registry'
import { resetBuiltinsRegistrationForTest } from '../builtins'
import { validatePluginManifest } from '../manifest/validate'
import { PLUGIN_MANIFEST_FORMAT, type PluginManifest } from '../manifest/types'

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
  if (!result.ok) throw new Error(`invalid: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

/** 每个用例前把注册表恢复到"只有内置插件"的状态 */
function resetRegistries(): void {
  clearPluginsForTest()
  clearInstalledForTest()
  resetBuiltinsRegistrationForTest()
}

describe('canInstall：安装期就该挡下的三种情况', () => {
  beforeEach(resetRegistries)

  it('全新 id 可以安装', () => {
    expect(canInstall({ id: 'brand-new' })).toEqual({ ok: true })
  })

  it('与内置插件撞名 → 拒绝（否则会悄悄覆盖官方实现）', () => {
    for (const id of ['aurora', 'lx', 'qishui']) {
      expect(canInstall({ id })).toEqual({ ok: false, code: 'builtin' })
    }
  })

  it('重复安装 → 拒绝（重装应走更新路径，不是悄悄换掉）', () => {
    expect(registerInstalledPlugin(manifest('demo'))).toBe(true)
    expect(canInstall({ id: 'demo' })).toEqual({ ok: false, code: 'duplicate' })
  })
})

describe('registerInstalledPlugin：装来的插件进同一个注册表', () => {
  beforeEach(resetRegistries)

  it('注册后 getPlugin 能拿到实现（上层不需要区分来源）', () => {
    registerInstalledPlugin(manifest('demo'))
    const plugin = getPlugin('demo')
    expect(plugin).toBeDefined()
    expect(typeof plugin!.search).toBe('function')
  })

  it('出现在 listPlugins 里（与内置插件同一份列表）', () => {
    registerInstalledPlugin(manifest('demo'))
    const ids = listPlugins().map((plugin) => plugin.id)
    expect(ids).toContain('demo')
    // 内置插件仍在（注册不会清表）
    expect(ids).toContain('aurora')
  })

  it('纯歌词清单不进音源注册表，但登记为"已安装"', () => {
    const lyricsOnly = manifest('lyrics-only', {
      source: undefined,
      lyrics: { url: 'https://api.example.com/l?t={track}' },
    })
    expect(registerInstalledPlugin(lyricsOnly)).toBe(false)
    expect(getPlugin('lyrics-only')).toBeUndefined()
    expect(isInstalledPlugin('lyrics-only')).toBe(true)
  })

  it('同名重复注册是幂等的（不产生两份）', () => {
    registerInstalledPlugin(manifest('demo'))
    registerInstalledPlugin(manifest('demo'))
    expect(listPlugins().filter((plugin) => plugin.id === 'demo')).toHaveLength(1)
  })
})

describe('unregisterInstalledPlugin：卸载必须真的摘掉实现', () => {
  beforeEach(resetRegistries)

  it('卸载后 getPlugin 取不到（不会出现"已卸载但音源还在工作"）', () => {
    registerInstalledPlugin(manifest('demo'))
    expect(getPlugin('demo')).toBeDefined()

    expect(unregisterInstalledPlugin('demo')).toBe(true)
    expect(getPlugin('demo')).toBeUndefined()
    expect(isInstalledPlugin('demo')).toBe(false)
  })

  it('卸载内置插件被拒绝且什么都不做（内置实现编译在应用里，没有"撤销"语义）', () => {
    // 先让内置注册发生
    registerInstalledPlugin(manifest('demo'))
    expect(unregisterInstalledPlugin('aurora')).toBe(false)
    expect(getPlugin('aurora')).toBeDefined()
  })

  it('卸载不存在的 id 返回 false（卸载流程不该因此失败）', () => {
    expect(unregisterInstalledPlugin('never-installed')).toBe(false)
  })

  it('卸载一个插件不影响其它已安装插件', () => {
    registerInstalledPlugin(manifest('a'))
    registerInstalledPlugin(manifest('b'))
    unregisterInstalledPlugin('a')
    expect(getPlugin('b')).toBeDefined()
    expect(installedManifests().map((item) => item.id)).toEqual(['b'])
  })
})

describe('mountInstalled：启动时批量挂载，坏一个不影响其他', () => {
  beforeEach(resetRegistries)

  it('正常挂载全部合法清单', () => {
    const scan = {
      plugins: [
        { manifest: manifest('a'), record: { sha256: 'x' }, path: '/p/a.json' },
        { manifest: manifest('b'), record: { sha256: 'y' }, path: '/p/b.json' },
      ],
      broken: [],
    }
    const result = mountInstalled(scan)
    expect(result.mounted).toEqual(['a', 'b'])
    expect(result.skipped).toEqual([])
    expect(getPlugin('a')).toBeDefined()
    expect(getPlugin('b')).toBeDefined()
  })

  it('与内置撞名的已安装插件被跳过并记录原因', () => {
    const result = mountInstalled({
      plugins: [{ manifest: manifest('aurora'), record: { sha256: 'x' }, path: '/p/x.json' }],
      broken: [],
    })
    expect(result.mounted).toEqual([])
    expect(result.skipped).toEqual([{ id: 'aurora', reason: 'builtin' }])
    // 内置实现没有被覆盖
    expect(getPlugin('aurora')).toBeDefined()
  })

  it('重复 id 的第二个被跳过（不会互相覆盖成随机结果）', () => {
    const result = mountInstalled({
      plugins: [
        { manifest: manifest('dup'), record: { sha256: '1' }, path: '/p/1.json' },
        { manifest: manifest('dup'), record: { sha256: '2' }, path: '/p/2.json' },
      ],
      broken: [],
    })
    expect(result.mounted).toEqual(['dup'])
    expect(result.skipped).toEqual([{ id: 'dup', reason: 'duplicate' }])
  })

  it('清单缺 id 的条目被跳过而不是让整批失败', () => {
    const result = mountInstalled({
      plugins: [
        { manifest: { id: '' } as PluginManifest, record: { sha256: 'x' }, path: '/p/bad.json' },
        { manifest: manifest('good'), record: { sha256: 'y' }, path: '/p/good.json' },
      ],
      broken: [],
    })
    expect(result.mounted).toEqual(['good'])
    expect(result.skipped).toEqual([{ id: '', reason: 'invalid' }])
  })
})

describe('guardedFetchOf：只有已安装插件受主机白名单约束', () => {
  beforeEach(resetRegistries)

  it('已安装插件拿到受约束的 fetch（越界请求被拒）', async () => {
    registerInstalledPlugin(manifest('demo'))
    const guarded = guardedFetchOf('demo')!
    expect(guarded).toBeTypeOf('function')
    await expect(guarded('https://evil.example.net/x')).rejects.toThrow()
  })

  it('内置插件没有受约束的 fetch（请求目标由我们审过）', () => {
    registerInstalledPlugin(manifest('demo'))
    expect(guardedFetchOf('aurora')).toBeUndefined()
  })

  it('卸载后不再提供受约束的 fetch', () => {
    registerInstalledPlugin(manifest('demo'))
    unregisterInstalledPlugin('demo')
    expect(guardedFetchOf('demo')).toBeUndefined()
  })
})

describe('pluginRegistered：诊断"注册失败"与"没注册"的区别', () => {
  beforeEach(resetRegistries)

  it('有音源能力的插件注册后为 true', () => {
    registerInstalledPlugin(manifest('demo'))
    expect(pluginRegistered('demo')).toBe(true)
  })

  it('纯歌词插件为 false（它本来就不该在音源表里，不是错误）', () => {
    registerInstalledPlugin(
      manifest('lyrics-only', { source: undefined, lyrics: { url: 'https://api.example.com/l?t={track}' } })
    )
    expect(pluginRegistered('lyrics-only')).toBe(false)
  })
})

describe('已安装清单的顺序（UI 列出顺序不随刷新抖动）', () => {
  beforeEach(resetRegistries)

  it('按注册顺序返回', () => {
    registerInstalledPlugin(manifest('c'))
    registerInstalledPlugin(manifest('a'))
    registerInstalledPlugin(manifest('b'))
    expect(installedManifests().map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('同名重新注册不改变位置', () => {
    registerInstalledPlugin(manifest('a'))
    registerInstalledPlugin(manifest('b'))
    registerInstalledPlugin(manifest('a'))
    expect(installedManifests().map((item) => item.id)).toEqual(['a', 'b'])
  })
})

afterEach(() => {
  resetRegistries()
})

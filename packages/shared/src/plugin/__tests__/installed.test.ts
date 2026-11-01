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
// 歌词候选与清单 hosts 走**登记表**读，不从 installed 直接取：
// 后者会让 `lyricsSource` 与 `installed` 成环（见 installedLyricsProvider 的说明）
import { installedLyricsSources, installedPluginHosts } from '../installedLyricsProvider'
import { clearPluginsForTest, getPlugin, listPlugins } from '../registry'
import { resetBuiltinsRegistrationForTest } from '../builtins'
import { clearPluginAvailabilityForTest, setPluginEnabled } from '../availability'
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

  /**
   * v15 修正：纯歌词插件**必须**进注册表。
   *
   * 改造前这里断言 `toBe(false)` + `getPlugin` 为 undefined，理由是"它不进音源列表"。
   * 但目录投影已经把它标成 `domain: 'lyrics'` 列给用户了 —— 注册表里却没有实现，
   * 结果就是个装得上、永远取不到歌词、还不报错的条目。歌词能力走的是
   * `lyricsSourceViaPlugin` → `getPlugin(id)`，不注册就等于这条链路必然断。
   */
  it('纯歌词清单进注册表（歌词链路要靠它取到实现），也登记为"已安装"', () => {
    const lyricsOnly = manifest('lyrics-only', {
      source: undefined,
      lyrics: { url: 'https://api.example.com/l?t={track}' },
    })
    expect(registerInstalledPlugin(lyricsOnly)).toBe(true)
    const plugin = getPlugin('lyrics-only')
    expect(plugin).toBeDefined()
    expect(typeof plugin!.lyricsSource).toBe('function')
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

  it('纯歌词插件为 true（它同样要进注册表，否则歌词链路取不到实现）', () => {
    registerInstalledPlugin(
      manifest('lyrics-only', { source: undefined, lyrics: { url: 'https://api.example.com/l?t={track}' } })
    )
    expect(pluginRegistered('lyrics-only')).toBe(true)
  })

  /**
   * 「注册失败」与「没注册」必须能区分。
   *
   * 纯歌词插件以前是 false，于是这个函数对两种完全不同的情况给同一个答案：
   * 真正没实现（配置错误）与「这类插件本来就不该注册」。现在两种合法形态都是 true，
   * 这个函数就只剩一个含义：注册表里有没有它的实现。
   *
   * 这里用**裸对象**绕过校验器：`no-capability` 在安装期已经挡掉了这种清单，
   * 但磁盘上的 manifest.json 可能被人手改过，`registerInstalledPlugin` 仍要能安全返回。
   */
  it('毫无能力声明的裸清单既不注册、也不抛错（读取期防御）', () => {
    const bare = {
      format: 'aurora-plugin/1',
      id: 'nothing',
      name: 'Nothing',
      version: '1.0.0',
      author: 'x',
      permissions: ['network'],
      hosts: ['api.example.com'],
    } as unknown as Parameters<typeof registerInstalledPlugin>[0]
    expect(registerInstalledPlugin(bare)).toBe(false)
    expect(pluginRegistered('nothing')).toBe(false)
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

/**
 * 纯歌词插件进入**歌词聚合候选**的那一步。
 *
 * 这一组是「注册了却永远没人调用」的防回归：v15 之前 `buildSourcePlugin` 对纯歌词
 * 清单返回 null，插件压根不注册；修好那一处之后，若聚合层仍然只遍历源配置
 * （`onlineSources`），这个插件依旧永远收不到一次调用 —— 列表里有、能启停、
 * 却没有一行生效证据。`installedLyricsSources()` 就是补那一步的入口。
 */
describe('installedLyricsSources：纯歌词插件必须真的被聚合器看见', () => {
  beforeEach(resetRegistries)

  function lyricsOnly(id: string, extra: Record<string, unknown> = {}) {
    return manifest(id, {
      source: undefined,
      lyrics: { url: 'https://api.example.com/l?t={track}' },
      ...extra,
    })
  }

  it('纯歌词插件交出一条歌词源，id 带 plugin: 前缀', () => {
    registerInstalledPlugin(lyricsOnly('lyr'))
    const sources = installedLyricsSources()
    expect(sources).toHaveLength(1)
    expect(sources[0].id).toBe('plugin:lyr')
    expect(sources[0].sourceUrl).toBe('https://api.example.com/l?t={track}')
    expect(sources[0].enabled).toBe(true)
  })

  it('声明 format: lrc 时把格式带进候选（否则执行器按 JSON 解析，必然落空）', () => {
    registerInstalledPlugin(
      lyricsOnly('lyr-lrc', {
        lyrics: { url: 'https://api.example.com/l?t={track}', format: 'lrc' },
      })
    )
    expect(installedLyricsSources()[0].format).toBe('lrc')
  })

  it('被停用的插件不进候选（停用了却还在取歌词是最难解释的那种故障）', () => {
    registerInstalledPlugin(lyricsOnly('lyr'))
    setPluginEnabled('lyr', false)
    expect(installedLyricsSources()).toEqual([])
  })

  it('带 source 块的插件不进候选：它的歌词走源配置那条路，重复会打两遍同一上游', () => {
    registerInstalledPlugin(
      manifest('both', { lyrics: { url: 'https://api.example.com/l?t={track}' } })
    )
    expect(installedLyricsSources().some((s) => s.id === 'plugin:both')).toBe(false)
  })

  it('带 script 块的插件同样不进候选（理由同上）', () => {
    registerInstalledPlugin(
      manifest('sc', {
        source: undefined,
        script: { url: 'https://api.example.com/s.js' },
        permissions: ['network', 'script'],
        lyrics: { url: 'https://api.example.com/l?t={track}' },
      })
    )
    expect(installedLyricsSources().some((s) => s.id === 'plugin:sc')).toBe(false)
  })

  it('卸载后立刻从候选里消失（不会"已卸载但歌词还在取"）', () => {
    registerInstalledPlugin(lyricsOnly('lyr'))
    expect(installedLyricsSources()).toHaveLength(1)
    unregisterInstalledPlugin('lyr')
    expect(installedLyricsSources()).toEqual([])
  })
})

describe('installedPluginHosts：歌词链路靠它拿清单白名单', () => {
  beforeEach(resetRegistries)

  it('已安装插件返回其清单 hosts（大小写与空白由校验器归一）', () => {
    registerInstalledPlugin(manifest('demo', { hosts: ['Lyrics.Example.COM'] }))
    expect(installedPluginHosts('demo')).toEqual(['lyrics.example.com'])
  })

  it('非已安装 id 返回 undefined（内置源与用户自填源不该受清单规则约束）', () => {
    expect(installedPluginHosts('aurora')).toBeUndefined()
    expect(installedPluginHosts('never-installed')).toBeUndefined()
  })
})

afterEach(() => {
  resetRegistries()
  clearPluginAvailabilityForTest()
})

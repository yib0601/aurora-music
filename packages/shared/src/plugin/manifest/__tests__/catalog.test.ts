import { describe, expect, it, beforeEach } from 'vitest'
import { buildPluginCatalog, catalogByDomain, entryHasCapability, entryUsableAsSource } from '../catalog'
import { validatePluginManifest } from '../validate'
import { PLUGIN_MANIFEST_FORMAT, type PluginManifest } from '../types'
import { clearPluginAvailabilityForTest, setPluginEnabled } from '../../availability'

function manifest(id: string, extra: Record<string, unknown> = {}): PluginManifest {
  const result = validatePluginManifest({
    format: PLUGIN_MANIFEST_FORMAT,
    id,
    name: { 'zh-CN': `演示-${id}`, en: `Demo ${id}` },
    description: { 'zh-CN': '说明文本', en: 'Description' },
    version: '1.2.3',
    permissions: ['network'],
    hosts: ['api.example.com'],
    source: { search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } } },
    ...extra,
  })
  if (!result.ok) throw new Error(`invalid: ${JSON.stringify(result.issues)}`)
  return result.manifest
}

const record = (sha = 'a'.repeat(64)) => ({ sha256: sha })

describe('buildPluginCatalog：内置 + 已安装的统一视图', () => {
  it('内置插件出现在目录里，且不可卸载', () => {
    const entries = buildPluginCatalog([])
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries.filter((item) => item.provenance === 'builtin')) {
      expect(entry.removable).toBe(false)
      // 内置插件的展示名是字典键，不是字面量
      expect(typeof entry.displayNameKey).toBe('string')
      expect(entry.displayName).toBeUndefined()
    }
  })

  it('内置音源插件（aurora / lx / qishui）都在 source 域', () => {
    const sources = catalogByDomain(buildPluginCatalog([]), 'source')
    const ids = sources.map((entry) => entry.id)
    expect(ids).toEqual(expect.arrayContaining(['aurora', 'lx', 'qishui']))
  })

  it('内置存储插件（webdav）在 storage 域，能力由方法存在性派生', () => {
    const storage = catalogByDomain(buildPluginCatalog([]), 'storage')
    const webdav = storage.find((entry) => entry.id === 'webdav')
    expect(webdav).toBeDefined()
    expect(webdav!.capabilities).toEqual(
      expect.arrayContaining(['listAudio', 'openRange', 'openStream', 'probe'])
    )
  })

  it('已安装插件出现在目录里，且可卸载、带哈希与权限', () => {
    const entries = buildPluginCatalog([{ manifest: manifest('demo'), record: record() }])
    const demo = entries.find((entry) => entry.id === 'demo')!
    expect(demo).toMatchObject({
      domain: 'source',
      version: '1.2.3',
      provenance: 'installed',
      removable: true,
      sha256: 'a'.repeat(64),
      permissions: ['network'],
      hosts: ['api.example.com'],
    })
    // 已安装插件的展示名是**字面量**（按当前语言解析），不是字典键
    expect(demo.displayNameKey).toBeUndefined()
    expect(typeof demo.displayName).toBe('string')
  })

  it('顺序：内置音源 → 内置存储 → 已安装（新用户先看到"本来就有这些"）', () => {
    const entries = buildPluginCatalog([{ manifest: manifest('demo'), record: record() }])
    const firstInstalled = entries.findIndex((entry) => entry.provenance === 'installed')
    const lastBuiltin = entries.map((entry) => entry.provenance).lastIndexOf('builtin')
    expect(firstInstalled).toBeGreaterThan(lastBuiltin)
  })

  it('能力清单由清单声明推导', () => {
    const full = manifest('full', {
      source: {
        search: { url: 'https://api.example.com/s?q={query}', map: { title: 't', audioUrl: 'u' } },
        resolveTrack: { url: 'https://api.example.com/t?id={id}', map: { audioUrl: 'u' } },
        playlistTracks: { url: 'https://api.example.com/p?id={playlistId}', map: { title: 't' } },
      },
      lyrics: { url: 'https://api.example.com/l?t={track}' },
    })
    const entry = buildPluginCatalog([{ manifest: full, record: record() }]).find((item) => item.id === 'full')!
    expect(entry.capabilities.sort()).toEqual(['lyrics', 'playlistParse', 'resolveTrack', 'search'].sort())
  })

  it('纯歌词插件的域是 lyrics', () => {
    const lyricsOnly = manifest('lyrics-only', {
      source: undefined,
      lyrics: { url: 'https://api.example.com/l?t={track}' },
    })
    const entry = buildPluginCatalog([{ manifest: lyricsOnly, record: record() }]).find(
      (item) => item.id === 'lyrics-only'
    )!
    expect(entry.domain).toBe('lyrics')
  })
})

describe('展示名解析：按语言选，永不为空', () => {
  it('zh-CN 取中文', () => {
    const entry = buildPluginCatalog([{ manifest: manifest('demo'), record: record() }], 'zh-CN').find(
      (item) => item.id === 'demo'
    )!
    expect(entry.displayName).toBe('演示-demo')
  })

  it('en 取英文', () => {
    const entry = buildPluginCatalog([{ manifest: manifest('demo'), record: record() }], 'en').find(
      (item) => item.id === 'demo'
    )!
    expect(entry.displayName).toBe('Demo demo')
  })

  it('未知语言回落到 en（而不是显示空白）', () => {
    const entry = buildPluginCatalog([{ manifest: manifest('demo'), record: record() }], 'ja').find(
      (item) => item.id === 'demo'
    )!
    expect(entry.displayName).toBe('Demo demo')
  })
})

describe('能力查询辅助', () => {
  it('entryHasCapability', () => {
    const entries = buildPluginCatalog([])
    const aurora = entries.find((entry) => entry.id === 'aurora')!
    expect(entryHasCapability(aurora, 'search')).toBe(true)
    expect(entryHasCapability(aurora, 'playlistParse')).toBe(true)
    // 未声明的能力一律 false（不算错）
    expect(entryHasCapability(aurora, 'userPlaylists')).toBe(false)
  })

  it('entryUsableAsSource：只有 source 域且有搜索或歌单能力才算', () => {
    const entries = buildPluginCatalog([])
    expect(entryUsableAsSource(entries.find((entry) => entry.id === 'aurora')!)).toBe(true)
    // 存储插件不是音源
    expect(entryUsableAsSource(entries.find((entry) => entry.domain === 'storage')!)).toBe(false)
  })

  it('只声明 resolveTrack 的插件不算可用音源（搜不到也导入不了歌单）', () => {
    const resolveOnly = manifest('resolve-only', {
      source: { resolveTrack: { url: 'https://api.example.com/t?id={id}', map: { audioUrl: 'u' } } },
    })
    const entry = buildPluginCatalog([{ manifest: resolveOnly, record: record() }]).find(
      (item) => item.id === 'resolve-only'
    )!
    expect(entryUsableAsSource(entry)).toBe(false)
  })
})

describe('目录是纯数据（必须能过 IPC structured clone）', () => {
  it('不含任何函数值', () => {
    const entries = buildPluginCatalog([{ manifest: manifest('demo'), record: record() }])
    // 模拟 structured clone：函数会抛 DataCloneError
    expect(() => structuredClone(entries)).not.toThrow()
  })

  it('catalogByDomain 不改原数组', () => {
    const entries = buildPluginCatalog([])
    const before = entries.length
    catalogByDomain(entries, 'source')
    expect(entries).toHaveLength(before)
  })
})

describe('启停投影：三条来源都带 enabled', () => {
  const entryOf = (id: string) => buildPluginCatalog([{ manifest: manifest('demo'), record: record() }]).find((item) => item.id === id)!

  it('默认全部 enabled=true', () => {
    for (const entry of buildPluginCatalog([])) expect(entry.enabled).toBe(true)
    expect(entryOf('demo').enabled).toBe(true)
  })

  it('内置音源插件停用后 enabled=false，开回来为 true', () => {
    setPluginEnabled('aurora', false)
    expect(entryOf('aurora').enabled).toBe(false)
    // 其它插件不受影响
    expect(entryOf('lx').enabled).toBe(true)

    setPluginEnabled('aurora', true)
    expect(entryOf('aurora').enabled).toBe(true)
  })

  it('内置存储插件停用后 enabled=false，且能力清单不被清空', () => {
    setPluginEnabled('webdav', false)
    const webdav = entryOf('webdav')
    expect(webdav.enabled).toBe(false)
    // 能力照旧全量投影：否则 UI 分不清"没这个能力"与"有但被关了"
    expect(webdav.capabilities).toEqual(
      expect.arrayContaining(['listAudio', 'openRange', 'openStream', 'probe'])
    )

    setPluginEnabled('webdav', true)
    expect(entryOf('webdav').enabled).toBe(true)
  })

  it('已安装插件停用后 enabled=false，但仍留在目录里（否则开关会跟着条目一起消失）', () => {
    setPluginEnabled('demo', false)
    const demo = entryOf('demo')
    expect(demo.enabled).toBe(false)
    // 仍可卸载：停用与卸载是两件事
    expect(demo.removable).toBe(true)
  })

  it('停用不改变可卸载性、展示名与域', () => {
    const before = entryOf('aurora')
    setPluginEnabled('aurora', false)
    const after = entryOf('aurora')
    expect(after).toMatchObject({
      domain: before.domain,
      displayNameKey: before.displayNameKey,
      removable: false,
      provenance: 'builtin',
    })
  })
})

// 目录本身不写注册表，但**会读**启停表这份模块级单例：一个用例停用了某个插件，
// 不清就会让后面的用例看到 enabled=false。这里清的是启停态，不是目录缓存。
beforeEach(() => {
  clearPluginAvailabilityForTest()
})

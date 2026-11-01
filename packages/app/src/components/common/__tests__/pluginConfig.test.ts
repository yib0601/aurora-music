import { describe, expect, it } from 'vitest'
import type { PluginCatalogEntry } from '@aurora/shared'
import type { LibrarySourceConfig, OnlineSourceConfig } from '@/types'
import type { PluginConfigBundle } from '../pluginConfig'
import {
  configSummaryOf,
  configsOfPlugin,
  hasPluginConfig,
  newConfigOwner,
  newSourceEnabled,
  pluginConfigSurfaces,
} from '../pluginConfig'

/** 目录条目工厂：只填必填项，其余按用例覆盖 */
function entry(overrides: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
  return {
    id: 'demo',
    domain: 'source',
    version: '1.0.0',
    capabilities: [],
    provenance: 'installed',
    removable: true,
    enabled: true,
    ...overrides,
  }
}

/** 在线音源配置工厂（fixture 用一眼可辨的假地址，不引真实服务） */
function onlineSource(overrides: Partial<OnlineSourceConfig> = {}): OnlineSourceConfig {
  return {
    id: 'src-1',
    name: '演示音源',
    sourceUrl: 'http://127.0.0.1:3201/?key=00000000-0000-0000-0000-000000000000',
    enabled: true,
    ...overrides,
  }
}

/** 网络存储配置工厂：老配置只有 `kind`，新配置才有 `pluginId`，两种都要能构造 */
function librarySource(overrides: Partial<LibrarySourceConfig> = {}): LibrarySourceConfig {
  return {
    id: 'lib-1',
    kind: 'webdav',
    name: '演示存储',
    enabled: true,
    ...overrides,
  }
}

describe('pluginConfigSurfaces：可配置面由域与 auth 能力共同决定', () => {
  it('source 域有一个 sources 面', () => {
    expect(pluginConfigSurfaces(entry({ domain: 'source' }))).toContain('sources')
  })

  it('storage 域有一个 storage 面', () => {
    expect(pluginConfigSurfaces(entry({ domain: 'storage' }))).toContain('storage')
  })

  it('声明 auth 能力就多一个 auth 面，与域无关（三个域都生效）', () => {
    // 防回归：曾经只有「音源域 + auth」被算进去，导致「存储插件要登录」时面板
    // 不显示登录段，用户以为这个插件不需要凭证。
    for (const domain of ['source', 'storage', 'lyrics'] as const) {
      expect(pluginConfigSurfaces(entry({ domain, capabilities: ['auth'] })), domain).toContain('auth')
    }
  })

  it('纯歌词插件（lyrics 域且无 auth）没有任何可配置面', () => {
    // 防回归：给纯歌词插件留一个空面板，点进去什么都配不了，用户会以为功能坏了。
    expect(pluginConfigSurfaces(entry({ domain: 'lyrics', capabilities: ['lyrics'] }))).toEqual([])
  })

  it('capabilities 不是数组（脏数据）时不抛错，也不假装有 auth 面', () => {
    // 防回归：目录条目来自外部清单，运行时可能缺字段；这里若直接 .includes 会整页崩。
    const malformed = entry({ capabilities: undefined as unknown as string[] })
    expect(() => pluginConfigSurfaces(malformed)).not.toThrow()
    expect(pluginConfigSurfaces(malformed)).not.toContain('auth')
  })
})

describe('hasPluginConfig 与 pluginConfigSurfaces().length > 0 口径一致', () => {
  const table: PluginCatalogEntry[] = [
    entry({ id: 'src', domain: 'source' }),
    entry({ id: 'src-auth', domain: 'source', capabilities: ['search', 'auth'] }),
    entry({ id: 'store', domain: 'storage' }),
    entry({ id: 'store-auth', domain: 'storage', capabilities: ['listAudio', 'auth'] }),
    entry({ id: 'lyrics-only', domain: 'lyrics', capabilities: ['lyrics'] }),
    entry({ id: 'lyrics-auth', domain: 'lyrics', capabilities: ['lyrics', 'auth'] }),
  ]

  it('任意域与能力组合下两者恒同假同真', () => {
    // 防回归：两处各自判一遍就可能分叉 —— 列表里显示「配置」按钮，点进去却是空面板。
    for (const item of table) {
      expect(hasPluginConfig(item), item.id).toBe(pluginConfigSurfaces(item).length > 0)
    }
  })

  it('有配置面时为 true', () => {
    expect(hasPluginConfig(entry({ domain: 'storage' }))).toBe(true)
  })

  it('没有任何配置面时为 false', () => {
    expect(hasPluginConfig(entry({ domain: 'lyrics', capabilities: ['lyrics'] }))).toBe(false)
  })
})

describe('configsOfPlugin：音源按 pluginIdOf 归属（含老配置 kind 兜底）', () => {
  const sources = [
    onlineSource({ id: 'explicit-aurora', pluginId: 'aurora' }),
    onlineSource({ id: 'explicit-someone', pluginId: 'someone' }),
    onlineSource({ id: 'legacy-lx', kind: 'lx' }),
    onlineSource({ id: 'legacy-aurora', kind: 'aurora' }),
    onlineSource({ id: 'legacy-none' }),
  ]

  const idsOf = (pluginId: string): string[] =>
    configsOfPlugin(entry({ id: pluginId, domain: 'source' }), sources, []).sources.map((item) => item.id)

  it('显式 pluginId 决定归属', () => {
    expect(idsOf('someone')).toEqual(['explicit-someone'])
    expect(idsOf('aurora')).toContain('explicit-aurora')
  })

  it('老配置只有 kind: lx 必须归 lx', () => {
    // 防回归：这是「设置里配好了但播放时不生效」的经典成因 —— 老配置若被默认成
    // aurora，lx 插件就永远看不到自己的源。
    expect(idsOf('lx')).toEqual(['legacy-lx'])
  })

  it('老配置只有 kind: aurora 归 aurora', () => {
    expect(idsOf('aurora')).toContain('legacy-aurora')
  })

  it('kind 与 pluginId 都缺省时归 aurora（历史缺省口径）', () => {
    expect(idsOf('aurora')).toContain('legacy-none')
  })

  it('aurora 不会因为 kind: lx 抢走 lx 的配置', () => {
    // 与上一条配对：兜底只能命中一个插件，不能两边都算。
    expect(idsOf('aurora')).not.toContain('legacy-lx')
    expect(idsOf('lx')).not.toContain('legacy-aurora')
  })
})

describe('configsOfPlugin：存储按 librarySourcePluginId 归属', () => {
  const librarySources = [
    librarySource({ id: 'by-plugin-id', kind: 'webdav', pluginId: 'smb' }),
    librarySource({ id: 'legacy-kind', kind: 'webdav' }),
    librarySource({ id: 'blank-plugin-id', kind: 'smb', pluginId: '   ' }),
    librarySource({ id: 'someone-else', pluginId: 'another' }),
  ]

  const idsOf = (pluginId: string): string[] =>
    configsOfPlugin(entry({ id: pluginId, domain: 'storage' }), [], librarySources).librarySources.map(
      (item) => item.id
    )

  it('显式 pluginId 优先（kind 不参与判定）', () => {
    expect(idsOf('smb')).toContain('by-plugin-id')
    expect(idsOf('webdav')).not.toContain('by-plugin-id')
  })

  it('老配置只有 kind: webdav 时归 webdav', () => {
    expect(idsOf('webdav')).toEqual(['legacy-kind'])
  })

  it('pluginId 为空白串时回落 kind（而不是回落到默认协议）', () => {
    // 防回归：空白串若被当成有效 id，这条配置会从「SMB 的那台 NAS」消失；
    // 若被当成缺省，则会误归到 webdav 名下。
    expect(idsOf('smb')).toContain('blank-plugin-id')
    expect(idsOf('webdav')).not.toContain('blank-plugin-id')
  })

  it('别的存储插件不会混进来', () => {
    expect(idsOf('webdav')).not.toContain('someone-else')
  })
})

describe('configsOfPlugin：非本域的配置不得混入', () => {
  it('source 域插件的 librarySources 恒为空数组', () => {
    // 防回归：配置只按 id 相等筛选、不按域收窄的话，同名 id 的音源插件会把
    // 存储配置也列出来，用户会在音源面板里看到 NAS 那一行。
    const bundle = configsOfPlugin(
      entry({ id: 'demo', domain: 'source' }),
      [onlineSource({ id: 's', pluginId: 'demo' })],
      [librarySource({ id: 'l', pluginId: 'demo' })]
    )
    expect(bundle.sources.map((item) => item.id)).toEqual(['s'])
    expect(bundle.librarySources).toEqual([])
  })

  it('storage 域插件的 sources 恒为空数组', () => {
    const bundle = configsOfPlugin(
      entry({ id: 'demo', domain: 'storage' }),
      [onlineSource({ id: 's', pluginId: 'demo' })],
      [librarySource({ id: 'l', pluginId: 'demo' })]
    )
    expect(bundle.librarySources.map((item) => item.id)).toEqual(['l'])
    expect(bundle.sources).toEqual([])
  })

  it('没有配置面的歌词插件两个数组都空（即使 id 撞上了）', () => {
    const bundle = configsOfPlugin(
      entry({ id: 'demo', domain: 'lyrics', capabilities: ['lyrics'] }),
      [onlineSource({ id: 's', pluginId: 'demo' })],
      [librarySource({ id: 'l', pluginId: 'demo' })]
    )
    expect(bundle.sources).toEqual([])
    expect(bundle.librarySources).toEqual([])
    expect(bundle.surfaces).toEqual([])
  })
})

describe('configsOfPlugin：返回值与入参隔离', () => {
  it('返回的数组是新数组，改动它不会写回入参', () => {
    // 防回归：若直接把入参数组切片/引用返回，面板里的「删除一条」会连带改掉
    // 配置 store 的那份快照，表现成刷新后配置莫名消失。
    const onlineSources = [onlineSource({ pluginId: 'demo' })]
    const storageSources = [librarySource({ pluginId: 'demo' })]
    const bundle = configsOfPlugin(entry({ id: 'demo', domain: 'source', capabilities: ['auth'] }), onlineSources, storageSources)

    expect(bundle.sources).not.toBe(onlineSources)
    bundle.sources.push(onlineSource({ id: 'pushed', pluginId: 'demo' }))
    bundle.librarySources.push(librarySource({ id: 'pushed-lib', pluginId: 'demo' }))

    expect(onlineSources.map((item) => item.id)).toEqual(['src-1'])
    expect(storageSources.map((item) => item.id)).toEqual(['lib-1'])
  })

  it('surfaces 每次都是新数组（调用方 push 不会污染后续调用）', () => {
    const item = entry({ domain: 'source', capabilities: ['auth'] })
    const first = pluginConfigSurfaces(item)
    first.length = 0
    expect(pluginConfigSurfaces(item)).toContain('sources')
  })

  it('list 域之外的空入参也不抛错（配置还没加载完）', () => {
    expect(configsOfPlugin(entry({ id: 'demo', domain: 'source' }), [], [])).toEqual({
      sources: [],
      librarySources: [],
      surfaces: ['sources'],
    })
  })
})


describe('configSummaryOf：给出列表页要用的三个准确值', () => {
  function bundleOf(overrides: Partial<PluginConfigBundle> = {}): PluginConfigBundle {
    return { sources: [], librarySources: [], surfaces: [], ...overrides }
  }

  it('三个字段都有且取值正确', () => {
    const bundle = bundleOf({
      sources: [onlineSource()],
      librarySources: [librarySource(), librarySource({ id: 'lib-2' })],
      surfaces: ['sources', 'storage', 'auth'],
    })
    expect(configSummaryOf(bundle)).toEqual({ sources: 1, librarySources: 2, auth: true })
  })

  it('没有 auth 面时 auth 为 false（不是 undefined）', () => {
    // 防回归：列表页会据此渲染「已登录」标记，undefined 会被当成"未知"多画一种状态。
    const summary = configSummaryOf(configsOfPlugin(entry({ id: 'demo', domain: 'source' }), [], []))
    expect(summary).toEqual({ sources: 0, librarySources: 0, auth: false })
  })

  it('auth 只反映能力声明，与配置条数无关', () => {
    const withAuth = configsOfPlugin(entry({ id: 'demo', domain: 'source', capabilities: ['auth'] }), [], [])
    expect(configSummaryOf(withAuth).auth).toBe(true)
    expect(configSummaryOf(withAuth).sources).toBe(0)
  })
})

describe('newConfigOwner：新建配置只写 pluginId', () => {
  it('对象上只有 pluginId 一个键', () => {
    // 防回归：同时写 kind 会让归属判定退回老配置兜底分支，而兜底只认 aurora / lx，
    // 第三方插件写 kind 等于把归属丢掉（配置存下去就找不回来了）。
    expect(Object.keys(newConfigOwner(entry({ id: 'someone' })))).toEqual(['pluginId'])
  })

  it('pluginId 取条目 id，而不是域或展示名', () => {
    expect(newConfigOwner(entry({ id: 'someone', domain: 'storage' }))).toEqual({ pluginId: 'someone' })
  })

  it('不含 kind 字段（既不是 undefined 值也不是空串键）', () => {
    const owner = newConfigOwner(entry({ id: 'someone' }))
    expect('kind' in owner).toBe(false)
    expect(JSON.parse(JSON.stringify(owner))).toEqual({ pluginId: 'someone' })
  })
})

/**
 * 端能力参与「有没有配置面」的判定。
 *
 * 背景：插件目录是跨域统一视图，**手机端的列表里同样有 WebDAV / SFTP / SMB**，
 * 但移动端没有主进程侧的存储代理与扫描，配不了也扫不了。若不把端能力算进来，
 * 那些卡片会带一个齿轮，点开是一个只有空态、没有新增按钮的分区 ——
 * 用户读到的结论是"功能坏了"，而真实原因是"这一端没有这个能力"。
 *
 * 这两条断言钉住的是「卡片齿轮与面板分区用同一份判据」——分开写就会漂移。
 */
describe('pluginConfigSurfaces：存储面受端能力约束', () => {
  it('storage 能力为 false 时，存储域没有可配置面（该端做不了，不是插件没有）', () => {
    const storageEntry = entry({ id: 'webdav', domain: 'storage' })
    expect(pluginConfigSurfaces(storageEntry, { storage: false })).toEqual([])
    expect(hasPluginConfig(storageEntry, { storage: false })).toBe(false)
  })

  it('存储面缺席不影响其它面：auth 能力仍然算数', () => {
    const bothEntry = entry({ id: 'nas', domain: 'storage', capabilities: ['auth'] })
    expect(pluginConfigSurfaces(bothEntry, { storage: false })).toEqual(['auth'])
  })

  it('缺省（不传 capability）按支持处理，纯逻辑单测无需关心端差异', () => {
    const storageEntry = entry({ id: 'webdav', domain: 'storage' })
    expect(pluginConfigSurfaces(storageEntry)).toEqual(['storage'])
  })

  it('storage 能力为 false 时，configsOfPlugin 也不收存储配置（与入口判定同源）', () => {
    // 防回归：入口藏了但数据照收，会出现"面板里看不到、却在后台工作"的错位。
    const storageEntry = entry({ id: 'webdav', domain: 'storage' })
    const bundle = configsOfPlugin(storageEntry, [], [librarySource()], { storage: false })
    expect(bundle.surfaces).toEqual([])
    expect(bundle.librarySources).toEqual([])
  })
})

/**
 * 「新建的音源该不该默认启用」—— 三种形态答案不同，其中脚本源看探测结果。
 *
 * 这条规则在改造中丢过一次：新增弹窗从设置页搬到插件面板时，四个保存分支各写了
 * 一遍 `enabled: true`，脚本源那档的 `lxProbe.ok === true` 被漏掉。后果是
 * **探测失败的脚本会被存成启用态**，之后每次在线搜索都要白等一轮脚本拉取失败
 * （改造前的代码注释已经写明这个后果）。当时没有任何单测覆盖保存动作，
 * 所以现在把它提成纯函数并在这里钉死。
 */
describe('newSourceEnabled：新建音源默认是否启用', () => {
  it('脚本源探测通过才算启用', () => {
    expect(newSourceEnabled('script', true)).toBe(true)
  })

  it('脚本源探测失败落停用（允许先存，但先别参与搜索）', () => {
    // 防回归：这里若返回 true，用户搜一次就要白等一轮必然失败的脚本拉取。
    expect(newSourceEnabled('script', false)).toBe(false)
  })

  it('脚本源未探测（undefined）同样落停用 —— 没验证过就不算可用', () => {
    expect(newSourceEnabled('script', undefined)).toBe(false)
  })

  it('协议源与歌单源不看探测结果，一律启用', () => {
    // 这两档存的就是用户明确填的地址 / 歌单 id，能存就是能用；
    // 传 false 也不该被降级，否则会把一条好源莫名存成停用。
    for (const kind of ['service', 'playlist'] as const) {
      expect(newSourceEnabled(kind, true)).toBe(true)
      expect(newSourceEnabled(kind, false)).toBe(true)
      expect(newSourceEnabled(kind, undefined)).toBe(true)
    }
  })
})

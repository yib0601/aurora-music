import { describe, expect, it } from 'vitest'
import { validatePluginManifest, supportedFormatsLabel } from '../validate'
import { PLUGIN_MANIFEST_FORMAT } from '../types'

/** 一份最小的合法清单（各用例在此基础上改字段） */
function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: PLUGIN_MANIFEST_FORMAT,
    id: 'demo-source',
    name: 'Demo Source',
    version: '1.0.0',
    permissions: ['network'],
    hosts: ['api.example.com'],
    source: {
      search: {
        url: 'https://api.example.com/search?q={query}',
        map: {
          id: 'id',
          title: 'title',
          artist: 'artist',
          audioUrl: 'url',
        },
      },
    },
    ...overrides,
  }
}

/** 取第一个 issue 的 code（"第一个错误是什么"是这个校验器最重要的可读性指标） */
function firstCode(input: unknown): string | undefined {
  return validatePluginManifest(input).issues[0]?.code
}

/** 全部 issue 的 path 列表 */
function issuePaths(input: unknown): string[] {
  return validatePluginManifest(input).issues.map((issue) => issue.path)
}

describe('格式标识', () => {
  it('缺 format 直接判格式错误，且不再报后续字段（避免误导性错误）', () => {
    const result = validatePluginManifest({ id: 'x' })
    expect(result.ok).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ path: 'format', code: 'invalid-format' })
  })

  it('别的格式标识同样在第一步就停下', () => {
    expect(firstCode(baseManifest({ format: 'lx-plugin/2' }))).toBe('invalid-format')
  })

  it('非对象输入给出 not-object', () => {
    expect(firstCode(null)).toBe('not-object')
    expect(firstCode('a string')).toBe('not-object')
    expect(firstCode([])).toBe('not-object')
  })

  it('支持的格式有可读名字（错误文案要能告诉用户"支持哪些"）', () => {
    expect(supportedFormatsLabel()).toBe(PLUGIN_MANIFEST_FORMAT)
  })
})

describe('插件 id', () => {
  it.each(['demo-source', 'a', 'a1', 'a.b_c-d', 'A-UPPER'])('接受 %s', (id) => {
    expect(validatePluginManifest(baseManifest({ id })).ok).toBe(true)
  })

  it.each([
    ['', '空串'],
    ['-lead', '以短横开头'],
    ['.dot', '以点开头'],
    ['has space', '含空格'],
    ['has/slash', '含斜杠'],
    ['中文 id', '非 ASCII'],
    ['a'.repeat(65), '超过 64 字符'],
  ])('拒绝 %s（%s）', (id) => {
    const result = validatePluginManifest(baseManifest({ id }))
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.path === 'id' && issue.code === 'invalid-id')).toBe(true)
  })
})

describe('版本号', () => {
  it.each(['1', '1.0', '1.0.0', '1.0.0-beta.1', '2.1.3+build'])('接受 %s', (version) => {
    expect(validatePluginManifest(baseManifest({ version })).ok).toBe(true)
  })

  it.each(['', 'v1.0.0', 'latest', '1.0.0.0'])('拒绝 %s', (version) => {
    expect(issuePaths(baseManifest({ version }))).toContain('version')
  })
})

describe('展示名：字符串或按语言的字面量（外部插件不能用字典键）', () => {
  it('字符串', () => {
    expect(validatePluginManifest(baseManifest({ name: 'Demo' })).ok).toBe(true)
  })

  it('语言映射', () => {
    expect(
      validatePluginManifest(baseManifest({ name: { 'zh-CN': '演示', en: 'Demo' } })).ok
    ).toBe(true)
  })

  it('缺 name 报 missing', () => {
    const input = baseManifest()
    delete input.name
    expect(firstCode(input)).toBe('missing')
  })

  it('空对象与空串都报 empty / invalid-type', () => {
    expect(firstCode(baseManifest({ name: {} }))).toBe('empty')
    expect(firstCode(baseManifest({ name: '   ' }))).toBe('empty')
    expect(firstCode(baseManifest({ name: 42 }))).toBe('invalid-type')
    expect(firstCode(baseManifest({ name: { en: '', 'zh-CN': 'X' } }))).toBe('invalid-type')
  })
})

describe('主机白名单：必须有限可枚举', () => {
  it('普通域名 / IP / 带端口 / IPv6 都接受', () => {
    for (const hosts of [
      ['api.example.com'],
      ['127.0.0.1'],
      ['10.0.0.5:8080'],
      ['[::1]:8080'],
      ['sub.domain.example.co.uk'],
    ]) {
      expect(validatePluginManifest(baseManifest({ hosts })).ok).toBe(true)
    }
  })

  it.each([
    ['*', '裸通配'],
    ['*.example.com', '子域通配'],
    ['example.*', '后缀通配'],
  ])('拒绝通配 %s（%s）—— 通配是硬拒绝，不降级为精确匹配', (host) => {
    const result = validatePluginManifest(baseManifest({ hosts: [host] }))
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'hosts[0]', code: 'wildcard-host' })
    )
  })

  it.each([
    ['https://api.example.com', '带协议头（作者想写 URL）'],
    ['api.example.com/v1', '带路径'],
    ['api.example.com?x=1', '带查询'],
    ['', '空串'],
    [' ', '纯空白'],
  ])('拒绝 %s（%s）', (host) => {
    const result = validatePluginManifest(baseManifest({ hosts: [host] }))
    expect(result.ok).toBe(false)
  })

  it('缺 hosts 或空数组报 missing（空 = 什么都不能访问，插件毫无意义）', () => {
    expect(issuePaths(baseManifest({ hosts: undefined }))).toContain('hosts')
    expect(issuePaths(baseManifest({ hosts: [] }))).toContain('hosts')
  })

  it('重复主机报 duplicate（大小写不敏感）', () => {
    const result = validatePluginManifest(
      baseManifest({ hosts: ['api.example.com', 'API.Example.com'] })
    )
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'hosts[1]', code: 'duplicate' })
    )
  })

  it('校验通过后主机名归一为小写（运行期比对不受书写习惯影响）', () => {
    const result = validatePluginManifest(baseManifest({ hosts: ['API.Example.COM'] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.hosts).toEqual(['api.example.com'])
  })
})

describe('权限', () => {
  it('network 与 credential 允许', () => {
    expect(validatePluginManifest(baseManifest({ permissions: ['network', 'credential'] })).ok).toBe(true)
  })

  it('filesystem 在 A 档判不支持（声明式插件没有文件能力）', () => {
    const result = validatePluginManifest(baseManifest({ permissions: ['network', 'filesystem'] }))
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'permissions[1]', code: 'unsupported-permission' })
    )
  })

  it('空权限清单报 missing（作者没想过"我要什么权限"）', () => {
    expect(issuePaths(baseManifest({ permissions: [] }))).toContain('permissions')
  })

  it('未知权限名与重复项都报出来', () => {
    const result = validatePluginManifest(baseManifest({ permissions: ['network', 'network', 'root'] }))
    expect(result.issues).toContainEqual(expect.objectContaining({ path: 'permissions[1]', code: 'duplicate' }))
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'permissions[2]', code: 'unsupported-permission' })
    )
  })
})

describe('能力域：至少声明一个', () => {
  it('既无 source 也无 lyrics 报 no-capability', () => {
    const input = baseManifest()
    delete input.source
    expect(firstCode(input)).toBe('no-capability')
  })

  it('source 是空对象同样报 no-capability（声���了域但没有能力）', () => {
    expect(firstCode(baseManifest({ source: {} }))).toBe('no-capability')
  })

  it('只有 lyrics 也算有能力的插件', () => {
    const input = baseManifest({ lyrics: { url: 'https://api.example.com/lrc?t={track}' } })
    delete input.source
    expect(validatePluginManifest(input).ok).toBe(true)
  })
})

describe('端点模板：占位符是硬校验（少了就静默失效）', () => {
  it('搜索模板缺 {query} 报 missing（否则搜什么都是同一个地址）', () => {
    const input = baseManifest({
      source: {
        search: {
          url: 'https://api.example.com/search',
          map: { title: 'title', audioUrl: 'url' },
        },
      },
    })
    expect(validatePluginManifest(input).issues).toContainEqual(
      expect.objectContaining({ path: 'source.search.url', code: 'missing', value: '{query}' })
    )
  })

  it('取址模板缺 {id} 报 missing', () => {
    const input = baseManifest({
      source: {
        resolveTrack: {
          url: 'https://api.example.com/track',
          map: { audioUrl: 'url' },
        },
      },
    })
    expect(validatePluginManifest(input).issues).toContainEqual(
      expect.objectContaining({ path: 'source.resolveTrack.url', code: 'missing' })
    )
  })

  it('歌单模板缺 {playlistId} 报 missing', () => {
    const input = baseManifest({
      source: {
        playlistTracks: {
          url: 'https://api.example.com/playlist',
          map: { title: 'title', audioUrl: 'url' },
        },
      },
    })
    expect(validatePluginManifest(input).issues).toContainEqual(
      expect.objectContaining({ path: 'source.playlistTracks.url', code: 'missing' })
    )
  })

  it('歌词模板既无 {track} 也无 {query} 报 missing', () => {
    const input = baseManifest({ lyrics: { url: 'https://api.example.com/lrc' } })
    expect(validatePluginManifest(input).issues).toContainEqual(
      expect.objectContaining({ path: 'lyrics.url', code: 'missing' })
    )
  })

  it('歌词模板有 {track} 即可（不强制 {query}）', () => {
    const input = baseManifest({ lyrics: { url: 'https://api.example.com/lrc?t={track}' } })
    expect(validatePluginManifest(input).ok).toBe(true)
  })

  it('未声明的占位符报错（运行期会原样留在 URL 里，请求一个错误地址）', () => {
    const input = baseManifest({
      source: {
        search: {
          url: 'https://api.example.com/search?q={query}&lang={locale}',
          map: { title: 'title', audioUrl: 'url' },
        },
      },
    })
    const result = validatePluginManifest(input)
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'source.search.url', value: '{locale}' })
    )
  })

  it('非 http(s) 地址报 invalid-url', () => {
    const input = baseManifest({
      source: {
        search: {
          url: 'file:///etc/passwd?q={query}',
          map: { title: 'title', audioUrl: 'url' },
        },
      },
    })
    expect(validatePluginManifest(input).issues).toContainEqual(
      expect.objectContaining({ path: 'source.search.url', code: 'invalid-url' })
    )
  })

  it('空模板报 missing', () => {
    const input = baseManifest({ source: { search: { url: '', map: { title: 't', audioUrl: 'u' } } } })
    expect(validatePluginManifest(input).issues).toContainEqual(
      expect.objectContaining({ path: 'source.search.url', code: 'missing' })
    )
  })
})

describe('字段映射', () => {
  it('title 与 audioUrl 是搜索/歌单端点的必填', () => {
    const input = baseManifest({
      source: {
        search: { url: 'https://api.example.com/s?q={query}', map: {} },
      },
    })
    const paths = issuePaths(input)
    expect(paths).toContain('source.search.map.title')
    expect(paths).toContain('source.search.map.audioUrl')
  })

  it('取址端点只要求 audioUrl（链路上不再需要标题）', () => {
    const input = baseManifest({
      source: {
        resolveTrack: { url: 'https://api.example.com/t?id={id}', map: {} },
      },
    })
    const paths = issuePaths(input)
    expect(paths).toContain('source.resolveTrack.map.audioUrl')
    expect(paths).not.toContain('source.resolveTrack.map.title')
  })

  it('路径语法非法报 invalid-type（表达式、可选链、$ 记号）', () => {
    for (const bad of ['a?.b', '$.data.title', "data['title']", 'a.b()']) {
      const input = baseManifest({
        source: {
          search: {
            url: 'https://api.example.com/s?q={query}',
            map: { title: bad, audioUrl: 'url' },
          },
        },
      })
      expect(issuePaths(input)).toContain('source.search.map.title')
    }
  })

  it('duration 与 durationMs 同时声明报 duplicate（一个字段不可能既是秒又是毫秒）', () => {
    const input = baseManifest({
      source: {
        search: {
          url: 'https://api.example.com/s?q={query}',
          map: { title: 'title', audioUrl: 'url', duration: 'dur', durationMs: 'dur_ms' },
        },
      },
    })
    expect(validatePluginManifest(input).issues).toContainEqual(
      expect.objectContaining({ path: 'source.search.map.durationMs', code: 'duplicate' })
    )
  })

  it('用 | 分隔多条路径是合法的（上游字段名不统一时的表达方式）', () => {
    const input = baseManifest({
      source: {
        search: {
          url: 'https://api.example.com/s?q={query}',
          map: { title: 'title|name|songName', artist: 'artist|singer', audioUrl: 'url' },
        },
      },
    })
    expect(validatePluginManifest(input).ok).toBe(true)
  })

  it('items 路径可选，给了就要合法', () => {
    const ok = baseManifest({
      source: { search: { url: 'https://api.example.com/s?q={query}', items: 'data.songs', map: { title: 't', audioUrl: 'u' } } },
    })
    expect(validatePluginManifest(ok).ok).toBe(true)

    const bad = baseManifest({
      source: { search: { url: 'https://api.example.com/s?q={query}', items: 'data?.songs', map: { title: 't', audioUrl: 'u' } } },
    })
    expect(issuePaths(bad)).toContain('source.search.items')
  })
})

describe('请求头', () => {
  it('字符串平表合法', () => {
    const input = baseManifest({
      source: {
        search: {
          url: 'https://api.example.com/s?q={query}',
          headers: { Authorization: 'Bearer x' },
          map: { title: 't', audioUrl: 'u' },
        },
      },
    })
    expect(validatePluginManifest(input).ok).toBe(true)
  })

  it('非字符串值报 invalid-type（IPC/JSON 会把它变成别的东西）', () => {
    const input = baseManifest({
      source: {
        search: {
          url: 'https://api.example.com/s?q={query}',
          headers: { 'X-N': 42 },
          map: { title: 't', audioUrl: 'u' },
        },
      },
    })
    expect(issuePaths(input)).toContain('source.search.headers.X-N')
  })
})

describe('歌词格式', () => {
  it('缺省为 json（既有执行器的解析路径）', () => {
    const result = validatePluginManifest(
      baseManifest({ lyrics: { url: 'https://api.example.com/lrc?t={track}' } })
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.lyrics?.format).toBe('json')
  })

  it('lrc 与 json 之外的值报 invalid-type', () => {
    const result = validatePluginManifest(
      baseManifest({ lyrics: { url: 'https://api.example.com/lrc?t={track}', format: 'xml' } })
    )
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'lyrics.format', code: 'invalid-type' })
    )
  })
})

describe('校验通过后的重建：只保留契约里的键', () => {
  it('未知字段被丢弃（作者笔误不该进入运行期）', () => {
    const result = validatePluginManifest(baseManifest({ unknownField: 'x', name: 'Demo' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest).not.toHaveProperty('unknownField')
      expect(Object.keys(result.manifest).sort()).toEqual(
        ['format', 'hosts', 'id', 'name', 'permissions', 'source', 'version'].sort()
      )
    }
  })

  it('多个问题一次全部返回（用户不能"改一条撞下一条"）', () => {
    const input = baseManifest({
      id: 'BAD ID',
      version: 'latest',
      hosts: ['*'],
      permissions: ['filesystem'],
    })
    const result = validatePluginManifest(input)
    expect(result.ok).toBe(false)
    // id / version / hosts / permissions 四类都要报出来
    expect(result.issues.length).toBeGreaterThanOrEqual(4)
    const codes = result.issues.map((issue) => issue.code)
    expect(codes).toEqual(
      expect.arrayContaining(['invalid-id', 'invalid-version', 'wildcard-host', 'unsupported-permission'])
    )
  })
})

describe('在线发现（推荐 / 榜单）', () => {
  it('推荐端点：id 与 name 必填（点不开 / 空白卡片）', () => {
    const result = validatePluginManifest(
      baseManifest({
        source: { recommend: { url: 'https://api.example.com/r', map: {} } },
      })
    )
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.path)).toContain('source.recommend.map.id')
    expect(result.issues.map((issue) => issue.path)).toContain('source.recommend.map.name')
  })

  it('推荐端点不需要占位符（分类参数是上游专有的）', () => {
    const result = validatePluginManifest(
      baseManifest({
        source: { recommend: { url: 'https://api.example.com/recommend', map: { id: 'id', name: 'n' } } },
      })
    )
    expect(result.ok).toBe(true)
  })

  it('推荐端点允许 categoryId / sortId / page / limit 占位符', () => {
    const result = validatePluginManifest(
      baseManifest({
        source: {
          recommend: {
            url: 'https://api.example.com/r?c={categoryId}&s={sortId}&p={page}&l={limit}',
            map: { id: 'id', name: 'n' },
          },
        },
      })
    )
    expect(result.ok).toBe(true)
  })

  it('推荐端点用了未声明的占位符要报错', () => {
    const result = validatePluginManifest(
      baseManifest({
        source: {
          recommend: { url: 'https://api.example.com/r?u={userId}', map: { id: 'id', name: 'n' } },
        },
      })
    )
    expect(result.ok).toBe(false)
  })

  it('榜单列表：item.id 与 item.name 必填', () => {
    const result = validatePluginManifest(
      baseManifest({
        source: { toplists: { url: 'https://api.example.com/t', map: { item: {} } } },
      })
    )
    expect(result.ok).toBe(false)
    const paths = result.issues.map((issue) => issue.path)
    expect(paths).toContain('source.toplists.map.item.id')
    expect(paths).toContain('source.toplists.map.item.name')
  })

  it('榜单列表：给了 songs 路径就必须给 song.title', () => {
    const withSongs = validatePluginManifest(
      baseManifest({
        source: {
          toplists: {
            url: 'https://api.example.com/t',
            map: { item: { id: 'id', name: 'n', songs: 'songs', song: {} } },
          },
        },
      })
    )
    expect(withSongs.ok).toBe(false)
    expect(withSongs.issues.map((issue) => issue.path)).toContain('source.toplists.map.item.song.title')

    // 给了 songs 但完全没给 song 映射：同样是错的
    const noSongMap = validatePluginManifest(
      baseManifest({
        source: {
          toplists: { url: 'https://api.example.com/t', map: { item: { id: 'id', name: 'n', songs: 'songs' } } },
        },
      })
    )
    expect(noSongMap.ok).toBe(false)
    expect(noSongMap.issues.map((issue) => issue.path)).toContain('source.toplists.map.item.song')
  })

  it('榜单列表：不声明 songs 是合法的（该源没有预览曲目）', () => {
    const result = validatePluginManifest(
      baseManifest({
        source: { toplists: { url: 'https://api.example.com/t', map: { item: { id: 'id', name: 'n' } } } },
      })
    )
    expect(result.ok).toBe(true)
  })

  it('榜单详情：title 与 artist 必填', () => {
    const result = validatePluginManifest(
      baseManifest({
        source: { toplistDetail: { url: 'https://api.example.com/d', map: {} } },
      })
    )
    expect(result.ok).toBe(false)
    const paths = result.issues.map((issue) => issue.path)
    expect(paths).toContain('source.toplistDetail.map.title')
    expect(paths).toContain('source.toplistDetail.map.artist')
  })

  it('榜单详情：duration 与 durationMs 同时声明报 duplicate（同一个坑）', () => {
    const result = validatePluginManifest(
      baseManifest({
        source: {
          toplistDetail: {
            url: 'https://api.example.com/d',
            map: { title: 't', artist: 'a', duration: 'd', durationMs: 'dm' },
          },
        },
      })
    )
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'source.toplistDetail.map.durationMs', code: 'duplicate' })
    )
  })

  it('榜单详情：meta 三段都是可选路径，类型要对', () => {
    const ok = validatePluginManifest(
      baseManifest({
        source: {
          toplistDetail: {
            url: 'https://api.example.com/d',
            meta: { name: 'data.name', updateTime: 'data.updateTime', total: 'data.total' },
            map: { title: 't', artist: 'a' },
          },
        },
      })
    )
    expect(ok.ok).toBe(true)

    const bad = validatePluginManifest(
      baseManifest({
        source: {
          toplistDetail: {
            url: 'https://api.example.com/d',
            meta: { name: 'data?.name' },
            map: { title: 't', artist: 'a' },
          },
        },
      })
    )
    expect(bad.issues.map((issue) => issue.path)).toContain('source.toplistDetail.meta.name')
  })

  it('只声明在线发现能力的清单是合法插件（不强制要搜索）', () => {
    const result = validatePluginManifest(
      baseManifest({ source: { recommend: { url: 'https://api.example.com/r', map: { id: 'id', name: 'n' } } } })
    )
    expect(result.ok).toBe(true)
  })
})

describe('B 档：受限脚本', () => {
  const scriptManifest = (extra: Record<string, unknown> = {}) =>
    baseManifest({
      permissions: ['network', 'script'],
      script: { url: 'https://api.example.com/source.js' },
      source: undefined,
      ...extra,
    })

  it('只有脚本能力的清单是合法插件（洛雪脚本只提供取址）', () => {
    const result = validatePluginManifest(scriptManifest())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.script?.url).toContain('source.js')
  })

  it('脚本块与 script 权限必须配平：有块无权限 → 报错', () => {
    const result = validatePluginManifest(
      scriptManifest({ permissions: ['network'] })
    )
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.path)).toContain('permissions')
  })

  it('有权限无脚本块 → 同样报错（申请了用不上的高危权限）', () => {
    const result = validatePluginManifest(
      baseManifest({ permissions: ['network', 'script'] })
    )
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.path)).toContain('script')
  })

  it('脚本地址必须是 http(s)', () => {
    for (const url of ['file:///etc/passwd', 'data:text/javascript,x', '', '   ']) {
      const result = validatePluginManifest(scriptManifest({ script: { url } }))
      expect(result.ok).toBe(false)
    }
  })

  it('sha256 可省略；给了必须是 64 位 hex', () => {
    expect(
      validatePluginManifest(
        scriptManifest({ script: { url: 'https://api.example.com/s.js', sha256: 'a'.repeat(64) } })
      ).ok
    ).toBe(true)

    for (const sha256 of ['abc', 'g'.repeat(64), 123]) {
      const result = validatePluginManifest(
        scriptManifest({ script: { url: 'https://api.example.com/s.js', sha256 } })
      )
      expect(result.ok).toBe(false)
      expect(result.issues.map((issue) => issue.path)).toContain('script.sha256')
    }
  })

  it('platforms 可选；给了必须是字符串数组', () => {
    expect(
      validatePluginManifest(
        scriptManifest({ script: { url: 'https://api.example.com/s.js', platforms: ['kw', 'tx'] } })
      ).ok
    ).toBe(true)

    const bad = validatePluginManifest(
      scriptManifest({ script: { url: 'https://api.example.com/s.js', platforms: ['kw', 42] } })
    )
    expect(bad.issues.map((issue) => issue.path)).toContain('script.platforms')
  })

  it('声明式端点与脚本块可以并存（协议源负责搜索、脚本负责取址）', () => {
    const result = validatePluginManifest(
      baseManifest({
        permissions: ['network', 'script'],
        script: { url: 'https://api.example.com/source.js', platforms: ['kw'] },
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.source?.search).toBeDefined()
      expect(result.manifest.script).toBeDefined()
    }
  })

  it('filesystem 权限仍然不被允许（脚本也拿不到 fs）', () => {
    const result = validatePluginManifest(scriptManifest({ permissions: ['network', 'script', 'filesystem'] }))
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'unsupported-permission' })
    )
  })

  it('校验通过后脚本块被保留（不被重建丢掉）', () => {
    const result = validatePluginManifest(
      scriptManifest({
        script: { url: 'https://api.example.com/s.js', sha256: 'b'.repeat(64), platforms: ['kw', 'tx'] },
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.script).toEqual({
        url: 'https://api.example.com/s.js',
        sha256: 'b'.repeat(64),
        platforms: ['kw', 'tx'],
      })
    }
  })
})

import {
  AURORA_ENDPOINT_FALLBACK,
  apiKeyFromUrl,
  buildAuroraEndpoints,
  checkSourceForm,
  normalizeSourceBase,
  parseSourceInput,
  parseAuroraEndpoints,
  playlistEndpointOf,
  probeAuroraService,
  searchEndpointOf,
} from '../auroraPreset'
import { setCustomFetch } from '../fetchWithTimeout'

/** 用户手里流传的真实形态：老端口 + 完整占位符 + 明文密钥 */
const OLD_LINK =
  'https://music.lighthouses.top:81/aurora?query={query}&quality={quality}&key=22fd9f64-ee25-43a7-a899-d9981630f481'
const KEY = '22fd9f64-ee25-43a7-a899-d9981630f481'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => setCustomFetch(null))

describe('normalizeSourceBase', () => {
  it('无协议头时补 https，去掉尾斜杠', () => {
    expect(normalizeSourceBase('music.lighthouses.top')).toBe('https://music.lighthouses.top')
    expect(normalizeSourceBase('https://music.lighthouses.top/')).toBe('https://music.lighthouses.top')
  })

  it('保留自定义端口', () => {
    expect(normalizeSourceBase('https://music.lighthouses.top:81/')).toBe(
      'https://music.lighthouses.top:81'
    )
  })

  it('剥掉端点路径，保留子路径前缀', () => {
    expect(normalizeSourceBase('https://x.com/aurora')).toBe('https://x.com')
    expect(normalizeSourceBase('https://x.com/aurora/playlist')).toBe('https://x.com')
    expect(normalizeSourceBase('https://x.com/music/aurora')).toBe('https://x.com/music')
  })

  it('丢弃 query 与 hash', () => {
    expect(normalizeSourceBase('https://x.com/aurora?query={query}')).toBe('https://x.com')
  })

  it('非法输入返回空串', () => {
    expect(normalizeSourceBase('')).toBe('')
    expect(normalizeSourceBase('   ')).toBe('')
    expect(normalizeSourceBase('http://')).toBe('')
  })
})

describe('apiKeyFromUrl', () => {
  it('取出真实密钥', () => {
    expect(apiKeyFromUrl(OLD_LINK)).toBe(KEY)
  })

  it('模板占位不算密钥', () => {
    expect(apiKeyFromUrl('/aurora?key=<API_KEY>')).toBe('')
    expect(apiKeyFromUrl('https://x.com/aurora?key={key}')).toBe('')
    expect(apiKeyFromUrl('https://x.com/aurora')).toBe('')
  })
})

describe('parseSourceInput', () => {
  it('裸服务地址：服务形态，无密钥', () => {
    expect(parseSourceInput('music.lighthouses.top')).toEqual({
      kind: 'service',
      baseUrl: 'https://music.lighthouses.top',
      apiKey: '',
    })
  })

  it('域名 + key 参数（没有端点路径）：服务形态，带出密钥', () => {
    expect(parseSourceInput('https://music.lighthouses.top?key=abc123')).toEqual({
      kind: 'service',
      baseUrl: 'https://music.lighthouses.top',
      apiKey: 'abc123',
    })
  })

  it('本协议完整端点地址（迁移前的老配置）：剥成服务地址 + 密钥', () => {
    expect(parseSourceInput(OLD_LINK)).toEqual({
      kind: 'service',
      baseUrl: 'https://music.lighthouses.top:81',
      apiKey: KEY,
    })
  })

  it('歌单端点形态同样归入服务形态', () => {
    expect(parseSourceInput('https://x.com/aurora/playlist?url={url}&key=abc')).toEqual({
      kind: 'service',
      baseUrl: 'https://x.com',
      apiKey: 'abc',
    })
  })

  it('子路径部署的端点也认', () => {
    expect(parseSourceInput('https://x.com/music/aurora?query={query}&key=abc')).toEqual({
      kind: 'service',
      baseUrl: 'https://x.com/music',
      apiKey: 'abc',
    })
  })

  it('带占位符的第三方地址：接口模板形态，原样保留', () => {
    expect(parseSourceInput('https://api.example.com/search?q={query}')).toEqual({
      kind: 'endpoint',
      baseUrl: '',
      apiKey: '',
      apiUrl: 'https://api.example.com/search?q={query}',
    })
    expect(parseSourceInput('https://lrclib.net/api/search?track_name={track}')?.kind).toBe('endpoint')
  })

  it('路径像但不是本协议端点（/aurora-search）：按接口模板处理，不误当服务地址', () => {
    expect(parseSourceInput('https://api.example.com/aurora-search?q={query}')).toEqual({
      kind: 'endpoint',
      baseUrl: '',
      apiKey: '',
      apiUrl: 'https://api.example.com/aurora-search?q={query}',
    })
  })

  it('带非 key 查询参数的地址：按接口模板处理（服务地址不该有别的参数）', () => {
    expect(parseSourceInput('https://api.example.com/search?q=abc')).toEqual({
      kind: 'endpoint',
      baseUrl: '',
      apiKey: '',
      apiUrl: 'https://api.example.com/search?q=abc',
    })
    expect(parseSourceInput('https://music.lighthouses.top?key=abc')?.kind).toBe('service')
  })

  it('非法输入返回 null（设置页据此报地址格式错误）', () => {
    expect(parseSourceInput('')).toBeNull()
    expect(parseSourceInput('   ')).toBeNull()
    expect(parseSourceInput('http://')).toBeNull()
  })
})

describe('checkSourceForm', () => {
  it('音乐源 + 服务地址：直接可保存，歌单接口由软件派生（不让用户手填）', () => {
    const f = checkSourceForm({ kind: 'music', link: 'https://music.lighthouses.top?key=abc' })
    expect(f.isService).toBe(true)
    expect(f.showPlaylist).toBe(false)
    expect(f.linkError).toBeNull()
    expect(f.canSave).toBe(true)
  })

  it('音乐源 + 老链接：同样归入服务形态，密钥解析可用', () => {
    const f = checkSourceForm({ kind: 'music', link: OLD_LINK })
    expect(f.isService).toBe(true)
    expect(f.parsed?.apiKey).toBe(KEY)
    expect(f.canSave).toBe(true)
  })

  it('音乐源 + 接口模板：需含 {query}，手填的歌单接口需含 {url}', () => {
    const ok = checkSourceForm({ kind: 'music', link: 'https://api.example.com/s?q={query}' })
    expect(ok.isService).toBe(false)
    expect(ok.canSave).toBe(true)

    const bad = checkSourceForm({
      kind: 'music',
      link: 'https://api.example.com/s?q={query}',
      playlistUrl: 'https://api.example.com/resolve',
    })
    expect(bad.playlistError).toBe('地址需包含占位符：{url}')
    expect(bad.canSave).toBe(false)
  })

  it('音乐源 + 接口模板缺占位符：报缺失项且不可保存', () => {
    const f = checkSourceForm({ kind: 'music', link: 'https://api.example.com/search?q=abc' })
    expect(f.linkError).toContain('{query}')
    expect(f.canSave).toBe(false)
  })

  it('只做歌单解析：主链接留空也允许保存', () => {
    const f = checkSourceForm({
      kind: 'music',
      link: '',
      playlistUrl: 'https://api.example.com/resolve?url={url}',
    })
    expect(f.showPlaylist).toBe(true)
    expect(f.canSave).toBe(true)
  })

  it('主链接与歌单接口都空：不可保存', () => {
    expect(checkSourceForm({ kind: 'music', link: '', playlistUrl: '' }).canSave).toBe(false)
  })

  it('歌词源：一律按接口模板校验，需 {track} 与 {artist}，且不派生歌单接口', () => {
    const ok = checkSourceForm({
      kind: 'lyrics',
      link: 'https://lrclib.net/api/search?track_name={track}&artist_name={artist}',
    })
    expect(ok.isService).toBe(false)
    expect(ok.showPlaylist).toBe(false)
    expect(ok.canSave).toBe(true)

    const bad = checkSourceForm({ kind: 'lyrics', link: 'https://lrclib.net/api/search?track_name={track}' })
    expect(bad.linkError).toContain('{artist}')
    expect(bad.canSave).toBe(false)
  })

  it('歌词源填裸域名：没有服务端组装约定，按缺占位符报错', () => {
    const f = checkSourceForm({ kind: 'lyrics', link: 'https://lrclib.net' })
    expect(f.isService).toBe(false)
    expect(f.linkError).toContain('{track}')
    expect(f.canSave).toBe(false)
  })

  it('链接非法：报格式错误', () => {
    const f = checkSourceForm({ kind: 'music', link: 'http://' })
    expect(f.linkError).toContain('地址格式不正确')
    expect(f.canSave).toBe(false)
  })

  it('请求头非法时不可保存', () => {
    const f = checkSourceForm({
      kind: 'music',
      link: 'https://music.lighthouses.top',
      headersInvalid: true,
    })
    expect(f.canSave).toBe(false)
  })
})

describe('searchEndpointOf / playlistEndpointOf（执行时解析端点）', () => {
  it('服务地址形态：按默认约定组装出两个端点，密钥写进 key', () => {
    const s = { sourceUrl: `https://music.lighthouses.top?key=${KEY}` }
    expect(searchEndpointOf(s)).toBe(
      `https://music.lighthouses.top/aurora?query={query}&quality={quality}&key=${KEY}`
    )
    expect(playlistEndpointOf(s)).toBe(
      `https://music.lighthouses.top/aurora/playlist?url={url}&key=${KEY}`
    )
  })

  it('老链接形态（完整端点地址）同样按服务地址处理', () => {
    const s = { sourceUrl: OLD_LINK }
    expect(searchEndpointOf(s)).toBe(
      `https://music.lighthouses.top:81/aurora?query={query}&quality={quality}&key=${KEY}`
    )
  })

  it('服务端自描述的模板优先于默认约定', () => {
    const s = {
      sourceUrl: 'https://x.com',
      endpoints: { search: '/v2/search?q={query}&key=<API_KEY>', playlist: '/v2/pl?u={url}' },
    }
    expect(searchEndpointOf(s)).toBe('https://x.com/v2/search?q={query}')
    expect(playlistEndpointOf(s)).toBe('https://x.com/v2/pl?u={url}')
  })

  it('接口模板形态：搜索地址原样使用，歌单地址取手填的那条', () => {
    const s = {
      sourceUrl: 'https://api.example.com/search?q={query}',
      playlistUrl: 'https://api.example.com/resolve?url={url}',
    }
    expect(searchEndpointOf(s)).toBe('https://api.example.com/search?q={query}')
    expect(playlistEndpointOf(s)).toBe('https://api.example.com/resolve?url={url}')
  })

  it('只做歌单解析的音源没有搜索端点', () => {
    const s = { sourceUrl: '', playlistUrl: 'https://api.example.com/resolve?url={url}' }
    expect(searchEndpointOf(s)).toBe('')
    expect(playlistEndpointOf(s)).toBe('https://api.example.com/resolve?url={url}')
  })

  it('只做搜索的音源没有歌单端点', () => {
    const s = { sourceUrl: 'https://api.example.com/search?q={query}' }
    expect(searchEndpointOf(s)).toBe('https://api.example.com/search?q={query}')
    expect(playlistEndpointOf(s)).toBe('')
  })

  it('未配置 / 地址非法时安全返回空串', () => {
    expect(searchEndpointOf(null)).toBe('')
    expect(playlistEndpointOf(undefined)).toBe('')
    expect(searchEndpointOf({ sourceUrl: 'http://' })).toBe('')
    expect(playlistEndpointOf({ sourceUrl: 'http://' })).toBe('')
  })
})

describe('buildAuroraEndpoints', () => {
  it('按兜底模板组装搜索与歌单端点', () => {
    expect(buildAuroraEndpoints('https://music.lighthouses.top', 'K1')).toEqual({
      search: 'https://music.lighthouses.top/aurora?query={query}&quality={quality}&key=K1',
      playlist: 'https://music.lighthouses.top/aurora/playlist?url={url}&key=K1',
    })
  })

  it('占位符原样保留（留给执行器替换）', () => {
    const ep = buildAuroraEndpoints('https://x.com', 'K1')!
    expect(ep.search).toContain('{query}')
    expect(ep.search).toContain('{quality}')
    expect(ep.playlist).toContain('{url}')
  })

  it('密钥为空时清掉 key 参数，不留多余分隔符', () => {
    expect(buildAuroraEndpoints('https://x.com', '')!.search).toBe(
      'https://x.com/aurora?query={query}&quality={quality}'
    )
  })

  it('密钥里的特殊字符做 URL 编码', () => {
    expect(buildAuroraEndpoints('https://x.com', 'a b&c')!.search).toContain('key=a%20b%26c')
  })

  it('服务端自描述优先于兜底模板', () => {
    const ep = buildAuroraEndpoints('https://x.com', 'K1', {
      search: '/v2/search?q={query}&key=<API_KEY>',
    })!
    expect(ep.search).toBe('https://x.com/v2/search?q={query}&key=K1')
    expect(ep.playlist).toBe('https://x.com/aurora/playlist?url={url}&key=K1')
  })

  it('子路径部署时拼接正确', () => {
    expect(buildAuroraEndpoints('https://x.com/music', 'K1')!.search).toBe(
      'https://x.com/music/aurora?query={query}&quality={quality}&key=K1'
    )
  })

  it('服务地址非法返回 null', () => {
    expect(buildAuroraEndpoints('', 'K1')).toBeNull()
    expect(buildAuroraEndpoints('http://', 'K1')).toBeNull()
  })

  it('兜底模板与服务端 GET / 的取值一致', () => {
    expect(AURORA_ENDPOINT_FALLBACK.playlist).toBe('/aurora/playlist?url={url}&key=<API_KEY>')
  })
})

describe('parseAuroraEndpoints', () => {
  it('读出自描述端点', () => {
    expect(
      parseAuroraEndpoints({ endpoints: { search: '/aurora?query={query}', playlist: '/p?url={url}' } })
    ).toEqual({ search: '/aurora?query={query}', playlist: '/p?url={url}' })
  })

  it('只有一项也认', () => {
    expect(parseAuroraEndpoints({ endpoints: { search: '/aurora?query={query}' } })).toEqual({
      search: '/aurora?query={query}',
    })
  })

  it('无自描述或类型不对返回 null', () => {
    expect(parseAuroraEndpoints({ status: 'ok' })).toBeNull()
    expect(parseAuroraEndpoints(null)).toBeNull()
    expect(parseAuroraEndpoints({ endpoints: { search: 42 } })).toBeNull()
  })
})

describe('probeAuroraService', () => {
  const rootDoc = {
    status: 'ok',
    endpoints: {
      search: '/aurora?query={query}&quality={quality}&key=<API_KEY>',
      playlist: '/aurora/playlist?url={url}&key=<API_KEY>',
    },
  }

  it('根路径自描述 + 密钥有效 → 成功并带回端点模板', async () => {
    const seen: string[] = []
    setCustomFetch(async (input) => {
      const url = String(input)
      seen.push(url)
      if (url.includes('/health')) return jsonResponse({ status: 'ok' })
      return jsonResponse(rootDoc)
    })
    const res = await probeAuroraService('music.lighthouses.top', KEY)
    expect(res.ok).toBe(true)
    expect(res.selfDescribed).toBe(true)
    expect(res.endpoints?.playlist).toBe('/aurora/playlist?url={url}&key=<API_KEY>')
    expect(seen[0]).toBe('https://music.lighthouses.top/')
    expect(seen[1]).toContain('/health?key=' + KEY)
  })

  it('密钥错误（401）→ 失败并指出密钥问题', async () => {
    setCustomFetch(async (input) =>
      String(input).includes('/health') ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse(rootDoc)
    )
    const res = await probeAuroraService('https://music.lighthouses.top', 'bad-key')
    expect(res.ok).toBe(false)
    expect(res.message).toContain('密钥')
  })

  it('地址不可达 → 失败', async () => {
    setCustomFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const res = await probeAuroraService('https://nope.invalid')
    expect(res.ok).toBe(false)
    expect(res.message).toContain('连接失败')
  })

  it('服务在线但无端点自描述 → 成功且标注未自描述', async () => {
    setCustomFetch(async () => jsonResponse({ status: 'ok' }))
    const res = await probeAuroraService('https://x.com', 'K1')
    expect(res.ok).toBe(true)
    expect(res.selfDescribed).toBe(false)
    expect(res.message).toContain('默认')
  })

  it('未填密钥时只探根路径', async () => {
    const seen: string[] = []
    setCustomFetch(async (input) => {
      seen.push(String(input))
      return jsonResponse(rootDoc)
    })
    const res = await probeAuroraService('https://x.com')
    expect(res.ok).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('地址非法 → 直接失败，不发请求', async () => {
    let called = false
    setCustomFetch(async () => {
      called = true
      return jsonResponse({})
    })
    const res = await probeAuroraService('http://')
    expect(res.ok).toBe(false)
    expect(called).toBe(false)
  })
})

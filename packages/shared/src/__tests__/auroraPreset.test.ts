import {
  AURORA_ENDPOINT_FALLBACK,
  apiKeyFromUrl,
  buildAuroraEndpoints,
  composeAuroraSource,
  detectAuroraSource,
  looksLikeEndpointInput,
  normalizeSourceBase,
  parseSourceInput,
  parseAuroraEndpoints,
  probeAuroraService,
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

describe('detectAuroraSource', () => {
  it('识别老链接：拆出服务地址（含端口）与密钥', () => {
    expect(detectAuroraSource(OLD_LINK)).toEqual({
      baseUrl: 'https://music.lighthouses.top:81',
      apiKey: KEY,
    })
  })

  it('识别歌单端点形态', () => {
    expect(detectAuroraSource('https://x.com/aurora/playlist?url={url}&key=abc')).toEqual({
      baseUrl: 'https://x.com',
      apiKey: 'abc',
    })
  })

  it('仅服务地址不认（没有端点路径）', () => {
    expect(detectAuroraSource('https://music.lighthouses.top')).toBeNull()
  })

  it('自定义接口地址不认，避免误改用户配置', () => {
    expect(detectAuroraSource('https://api.example.com/search?q={query}')).toBeNull()
    expect(detectAuroraSource('https://lrclib.net/api/search?track_name={track}')).toBeNull()
    expect(detectAuroraSource('https://api.example.com/aurora-search?q={query}')).toBeNull()
  })

  it('子路径部署的端点也认', () => {
    expect(detectAuroraSource('https://x.com/music/aurora?query={query}&key=abc')).toEqual({
      baseUrl: 'https://x.com/music',
      apiKey: 'abc',
    })
  })
})

describe('parseSourceInput', () => {
  it('只填服务地址：没有密钥', () => {
    expect(parseSourceInput('music.lighthouses.top')).toEqual({
      baseUrl: 'https://music.lighthouses.top',
      apiKey: '',
    })
  })

  it('域名 + key 参数（没有端点路径）也能拆出密钥', () => {
    expect(parseSourceInput('https://music.lighthouses.top?key=abc123')).toEqual({
      baseUrl: 'https://music.lighthouses.top',
      apiKey: 'abc123',
    })
  })

  it('完整端点地址：剥掉路径、带出密钥', () => {
    expect(parseSourceInput(OLD_LINK)).toEqual({
      baseUrl: 'https://music.lighthouses.top:81',
      apiKey: KEY,
    })
  })

  it('非法输入返回 null（设置页据此报地址格式错误）', () => {
    expect(parseSourceInput('')).toBeNull()
    expect(parseSourceInput('http://')).toBeNull()
  })
})

describe('looksLikeEndpointInput', () => {
  it('带查询串或 /aurora 端点：视为粘贴进来的完整地址', () => {
    expect(looksLikeEndpointInput('https://music.lighthouses.top?key=1')).toBe(true)
    expect(looksLikeEndpointInput('https://music.lighthouses.top/aurora')).toBe(true)
    expect(looksLikeEndpointInput('https://music.lighthouses.top/aurora/playlist')).toBe(true)
  })

  it('逐字符打字中的半成品：不触发拆分，免得输入被打断', () => {
    expect(looksLikeEndpointInput('music')).toBe(false)
    expect(looksLikeEndpointInput('https://music.lighthouses.top')).toBe(false)
    expect(looksLikeEndpointInput('https://music.lighthouses.top/')).toBe(false)
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

describe('composeAuroraSource', () => {
  it('一次组装出可写入存储的完整音源', () => {
    const s = composeAuroraSource({ name: '我的音源', baseUrl: 'music.lighthouses.top/', apiKey: KEY })!
    expect(s.name).toBe('我的音源')
    expect(s.preset).toBe('aurora')
    expect(s.baseUrl).toBe('https://music.lighthouses.top')
    expect(s.apiKey).toBe(KEY)
    expect(s.apiUrl).toBe(`https://music.lighthouses.top/aurora?query={query}&quality={quality}&key=${KEY}`)
    expect(s.playlistUrl).toBe(`https://music.lighthouses.top/aurora/playlist?url={url}&key=${KEY}`)
  })

  it('未填名称时给默认名', () => {
    expect(composeAuroraSource({ baseUrl: 'https://x.com' })!.name).toBe('标准音源')
  })

  it('服务地址非法返回 null', () => {
    expect(composeAuroraSource({ baseUrl: '' })).toBeNull()
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

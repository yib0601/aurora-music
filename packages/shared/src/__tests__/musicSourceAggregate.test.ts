/**
 * 聚合搜索层的客户端侧降耗时验证：
 *   1) 可疑音频校正优先「就地取材」——源在主档回填 qualityUrls['128'] 时不再补拉 128 档
 *      （这一层省掉整整一轮上游往返，是 QQ Music 这类多音质源的实际路径）
 *   2) 就地取材不成立（源未回填 128 档）时才补拉基线档，且结果口径与旧串行版一致
 *   3) 短 TTL 缓存：重复词不再打网络；音源变更（clearSearchCache）后立即失效；失败不缓存
 *
 * 网络层通过 setCustomFetch 注入，测试不依赖真实上游。
 */
import { searchOnlineTracks, clearSearchCache } from '../musicSource'
import { setCustomFetch } from '../fetchWithTimeout'
import type { OnlineSourceConfig, OnlineTrackSearchResult } from '../types'

interface Call {
  url: string
  at: number
}

/** 注入桩 fetch：记录每次请求地址与时刻，按 URL 里的 quality 返回给定条目 */
function installStubFetch(delayMs: number, itemOf: (isBaseline: boolean) => any) {
  const calls: Call[] = []
  setCustomFetch(async (input) => {
    const url = String(input)
    calls.push({ url, at: Date.now() })
    await new Promise((r) => setTimeout(r, delayMs))
    return new Response(JSON.stringify({ results: [itemOf(url.includes('quality=128'))] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

/** 主档条目：声称 flac，但地址是 mp3（跨平台取址回落的可疑特征） */
const suspiciousMain = { id: 'same-id', title: '歌', artist: '手', url: 'http://x/main.mp3', quality: 'flac', qualitySource: 'qq' }
const base128 = { id: 'same-id', title: '歌', artist: '手', url: 'http://x/base.mp3', quality: '128', qualitySource: 'qq' }

const SOURCE: OnlineSourceConfig = {
  id: 'src-1',
  name: '测试源',
  sourceUrl: 'http://stub.test/aurora?query={query}&quality={quality}',
  enabled: true,
}

afterEach(() => {
  setCustomFetch(null)
  clearSearchCache()
})

describe('可疑音频校正：就地取材优先，省掉一轮往返', () => {
  it('主档自带 qualityUrls[128] 时只发 1 次请求，并就地完成校正', async () => {
    const calls = installStubFetch(20, () => ({
      ...suspiciousMain,
      qualityUrls: { '128': 'http://x/own128.mp3' },
      url_128: 'http://x/own128.mp3',
    }))
    const out = await searchOnlineTracks('就地词', { sources: [SOURCE], quality: 'flac' })

    expect(calls).toHaveLength(1) // 不再补拉 128 档
    expect(out).toHaveLength(1)
    expect(out[0].audioUrl).toBe('http://x/own128.mp3')
    expect(out[0].audioQuality).toBe('128')
    expect(out[0].title).toBe('歌') // 元数据保持主档
    expect(out[0].qualityUrls?.['128']).toBe('http://x/own128.mp3')
  })

  it('主档未回填 128 档且条目可疑时，才补拉基线档并校正', async () => {
    const calls = installStubFetch(20, (isBaseline) => (isBaseline ? base128 : suspiciousMain))
    const out = await searchOnlineTracks('补拉词', { sources: [SOURCE], quality: 'flac' })

    expect(calls).toHaveLength(2) // 主档 + 基线档
    expect(calls[1].url).toContain('quality=128')
    expect(out[0].audioUrl).toBe('http://x/base.mp3')
    expect(out[0].audioQuality).toBe('128')
  })

  it('主档未回填 128 档但条目不可疑时，不做任何多余请求', async () => {
    const calls = installStubFetch(20, () => ({
      id: 'a', title: '歌', artist: '手', url: 'http://x/a.flac', quality: 'flac', qualitySource: 'qq',
    }))
    const out = await searchOnlineTracks('干净词', { sources: [SOURCE], quality: 'flac' })

    expect(calls).toHaveLength(1)
    expect(out[0].audioUrl).toBe('http://x/a.flac') // 真正的 .flac 不当可疑处理
  })

  it('请求 128 档时不触发基线档逻辑', async () => {
    const calls = installStubFetch(20, () => base128)
    await searchOnlineTracks('基础档词', { sources: [SOURCE], quality: '128' })
    expect(calls).toHaveLength(1)
  })

  it('基线档请求失败时保留就地校正结果，不抛错也不留可疑地址', async () => {
    const calls: string[] = []
    setCustomFetch(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('quality=128')) throw new Error('baseline down')
      return new Response(JSON.stringify({ results: [suspiciousMain] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const out = await searchOnlineTracks('基线挂词', { sources: [SOURCE], quality: 'flac' })
    expect(calls).toHaveLength(2)
    expect(out).toHaveLength(1)
    expect(out[0].audioUrl).toBe('http://x/main.mp3') // 无基线可用时保持原样
  })

  it('基线档多出的条目不会进入结果（它只用于校正，不扩充结果集）', async () => {
    setCustomFetch(async (input) => {
      const isBaseline = String(input).includes('quality=128')
      const results = isBaseline
        ? [base128, { id: 'only-in-baseline', title: '仅基线有', artist: 'x', url: 'http://x/extra.mp3' }]
        : [suspiciousMain]
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const out = await searchOnlineTracks('不扩充词', { sources: [SOURCE], quality: 'flac' })
    expect(out).toHaveLength(1)
    expect(out.some((r) => r.id.includes('only-in-baseline'))).toBe(false)
    expect(out[0].audioUrl).toBe('http://x/base.mp3') // 同 id 被校正
  })
})

describe('搜索结果缓存', () => {
  const plain = { id: 'a', title: '歌', artist: '手', url: 'http://x/a.flac', quality: 'flac', qualitySource: 'qq' }

  it('同一词重复搜索命中缓存，不再打网络', async () => {
    const calls = installStubFetch(10, () => plain)
    await searchOnlineTracks('缓存词', { sources: [SOURCE], quality: 'flac' })
    expect(calls).toHaveLength(1)
    await searchOnlineTracks('缓存词', { sources: [SOURCE], quality: 'flac' })
    await searchOnlineTracks('缓存词', { sources: [SOURCE], quality: 'flac' })
    expect(calls).toHaveLength(1)
  })

  it('不同搜索词不共用缓存', async () => {
    const calls = installStubFetch(10, () => plain)
    await searchOnlineTracks('词A', { sources: [SOURCE], quality: 'flac' })
    await searchOnlineTracks('词B', { sources: [SOURCE], quality: 'flac' })
    expect(calls).toHaveLength(2)
  })

  it('同刻同词的并发请求合流为一次网络执行', async () => {
    const calls = installStubFetch(60, () => plain)
    const [a, b, c] = await Promise.all([
      searchOnlineTracks('合流词', { sources: [SOURCE], quality: 'flac' }),
      searchOnlineTracks('合流词', { sources: [SOURCE], quality: 'flac' }),
      searchOnlineTracks('合流词', { sources: [SOURCE], quality: 'flac' }),
    ])
    expect(calls).toHaveLength(1)
    expect(a[0].audioUrl).toBe(b[0].audioUrl)
    expect(b[0].audioUrl).toBe(c[0].audioUrl)
  })

  it('clearSearchCache 后同一词重新走网络（音源变更即失效）', async () => {
    const calls = installStubFetch(10, () => plain)
    await searchOnlineTracks('失效词', { sources: [SOURCE], quality: 'flac' })
    clearSearchCache()
    await searchOnlineTracks('失效词', { sources: [SOURCE], quality: 'flac' })
    expect(calls).toHaveLength(2)
  })

  it('源地址改变后缓存不串用（key 含解析出的端点）', async () => {
    const calls = installStubFetch(10, () => plain)
    await searchOnlineTracks('换源词', { sources: [SOURCE], quality: 'flac' })
    const moved: OnlineSourceConfig = {
      ...SOURCE,
      sourceUrl: 'http://stub2.test/aurora?query={query}&quality={quality}',
    }
    await searchOnlineTracks('换源词', { sources: [moved], quality: 'flac' })
    expect(calls).toHaveLength(2)
  })

  it('失败结果不入缓存：一次抖动不会被固化', async () => {
    let n = 0
    setCustomFetch(async () => {
      n++
      if (n === 1) throw new Error('boom')
      return new Response(JSON.stringify({ results: [plain] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await expect(
      searchOnlineTracks('抖动词', { sources: [SOURCE], quality: '128' })
    ).rejects.toThrow('所有音乐源请求失败，请检查网络连接或源配置')
    const again = await searchOnlineTracks('抖动词', { sources: [SOURCE], quality: '128' })
    expect(again).toHaveLength(1)
  })
})

describe('结果结构与顺序不变', () => {
  it('多源时结果按源顺序拼接，且每源失败不影响其它源', async () => {
    setCustomFetch(async (input) => {
      const url = String(input)
      if (url.includes('stub-bad')) throw new Error('bad source')
      const which = url.includes('stub2') ? 'B' : 'A'
      return new Response(JSON.stringify({ results: [{ id: which, title: which, artist: which, url: `http://x/${which}.flac` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const bad: OnlineSourceConfig = { id: 'bad', name: '坏源', sourceUrl: 'http://stub-bad.test/aurora?query={query}', enabled: true }
    const b: OnlineSourceConfig = { id: 'b', name: 'B源', sourceUrl: 'http://stub2.test/aurora?query={query}', enabled: true }
    const out: OnlineTrackSearchResult[] = await searchOnlineTracks('多源词', {
      sources: [SOURCE, bad, b],
      quality: '128',
    })
    expect(out.map((r) => r.id)).toEqual(['src-1-A', 'b-B'])
  })

  it('全部源失败时报出统一中文错误', async () => {
    setCustomFetch(async () => {
      throw new Error('down')
    })
    await expect(
      searchOnlineTracks('全挂词', { sources: [SOURCE], quality: '128' })
    ).rejects.toThrow('所有音乐源请求失败，请检查网络连接或源配置')
  })
})
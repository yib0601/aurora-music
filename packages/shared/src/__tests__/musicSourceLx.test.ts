/**
 * 聚合搜索接入洛雪脚本源（kind='lx'）的验证
 *
 * 覆盖：
 *   1) lx 源产出的条目 audioUrl 为空串、带 lx 定位信息，且**不参与可疑音源校正**
 *      （不判可疑、不触发 128 基线补拉）；
 *   2) 缓存键分源：两个 lx 源之间、lx 源与 aurora 源之间都不串味；
 *   3) 宿主未注册 / 脚本源码不可得时跳过该源并给出告警，不把配置问题伪装成网络失败；
 *   4) lx 源与 aurora 源混排时结果按源顺序拼接，单源失败不影响其它源。
 *
 * 网络与脚本执行全部打桩，不依赖真实上游。
 */
import { searchOnlineTracks, clearSearchCache, isSearchableSource, sourceCacheKeyOf } from '../musicSource'
import { setCustomFetch } from '../fetchWithTimeout'
import { setLxHostDeps, clearLxSourceCache, type LxHostDeps } from '../lxHost'
import { setLxScriptProvider } from '../lxResolver'
import type { OnlineSourceConfig } from '../types'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 洛雪脚本桩：search 经 lx.request 打宿主（用于统计真实执行次数），返回两条元信息 */
function lxScript(tag: string): string {
  return `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  if (arg.action !== 'search') return Promise.reject(new Error('只支持 search'))
  return new Promise(function (resolve, reject) {
    lx.request('http://stub.test/search?tag=${tag}&k=' + encodeURIComponent(arg.info.keyword), {}, function (err, resp, body) {
      if (err) return reject(err)
      var data = typeof body === 'string' ? JSON.parse(body) : body
      resolve(data.list)
    })
  })
})
lx.send(lx.EVENT_NAMES.inited, { sources: { kw: { name: '酷我', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k', 'flac'] } } })
`
}

/** 假宿主 request：记录每次搜索请求，按 tag 返回不同的 id 前缀（便于分辨是哪个源返回的） */
function installLxDeps() {
  const calls: string[] = []
  const deps: LxHostDeps = {
    env: 'desktop',
    request(url, _options, callback) {
      calls.push(url)
      const tag = /tag=([^&]*)/.exec(url)?.[1] || '?'
      const body = {
        list: [
          { name: `歌曲-${tag}`, singer: '歌手', albumName: '专辑', songmid: `mid-${tag}`, interval: 240 },
          { name: `歌曲2-${tag}`, singer: '歌手2', albumName: '专辑2', songmid: `mid2-${tag}`, interval: 180 },
        ],
      }
      setTimeout(() => callback(null, { statusCode: 200, body }, JSON.stringify(body)), 0)
      return () => {}
    },
  }
  setLxHostDeps(deps)
  return calls
}

function lxSource(over: Partial<OnlineSourceConfig> & { script?: string } = {}): OnlineSourceConfig & { script?: string } {
  return {
    id: 'lx-a',
    name: '洛雪源A',
    kind: 'lx',
    sourceUrl: 'http://stub.test/script-a.js',
    enabled: true,
    script: lxScript('a'),
    ...over,
  }
}

const AURORA: OnlineSourceConfig = {
  id: 'src-1',
  name: '测试源',
  sourceUrl: 'http://stub.test/aurora?query={query}&quality={quality}',
  enabled: true,
}

/** aurora 侧桩：主档返回「声称 flac 但地址是 mp3」的可疑条目，128 档返回干净地址 */
function installAuroraFetch(itemOf: (isBaseline: boolean) => any = (b) => (b ? base128 : suspiciousMain)) {
  const calls: string[] = []
  setCustomFetch(async (input) => {
    const url = String(input)
    calls.push(url)
    return new Response(JSON.stringify({ results: [itemOf(url.includes('quality=128'))] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

const suspiciousMain = { id: 'same-id', title: '歌', artist: '手', url: 'http://x/main.mp3', quality: 'flac', qualitySource: 'qq' }
const base128 = { id: 'same-id', title: '歌', artist: '手', url: 'http://x/base.mp3', quality: '128', qualitySource: 'qq' }

afterEach(() => {
  setCustomFetch(null)
  setLxHostDeps(null)
  setLxScriptProvider(null)
  clearLxSourceCache()
  clearSearchCache()
  vi.restoreAllMocks()
})

describe('lx 源条目形态', () => {
  it('audioUrl 为空串、带 lx 定位信息，且元信息完整', async () => {
    installLxDeps()
    const out = await searchOnlineTracks('起风了', { sources: [lxSource()], quality: 'flac' })

    expect(out).toHaveLength(2)
    expect(out[0].audioUrl).toBe('')
    expect(out[0].audioQuality).toBeUndefined()
    expect(out[0].trackRef).toEqual({
      sourceId: 'lx-a',
      platform: 'kw',
      meta: { name: '歌曲-a', singer: '歌手', albumName: '专辑', songmid: 'mid-a', interval: 240 },
    })
    expect(out[0].title).toBe('歌曲-a')
    expect(out[0].artist).toBe('歌手')
    expect(out[0].duration).toBe(240)
    expect(out[0].source).toBe('lx-a')
    expect(out[0].id).toContain('lx-a-kw-mid-a')
  })

  it('lx 条目不参与可疑校正：不判可疑、不触发 128 基线补拉', async () => {
    const lxCalls = installLxDeps()
    const auroraCalls = installAuroraFetch()
    const out = await searchOnlineTracks('混合词', {
      sources: [lxSource(), AURORA],
      quality: 'flac',
    })

    // lx 源只被搜索一次（若被塞进基线补拉会是两次）
    expect(lxCalls).toHaveLength(1)
    // aurora 侧仍是「主档 + 基线档」两次，校正逻辑未被 lx 源改变
    expect(auroraCalls).toHaveLength(2)

    const lxItem = out.find((r) => r.source === 'lx-a')
    const auroraItem = out.find((r) => r.source === 'src-1')
    expect(lxItem?.audioUrl).toBe('')
    expect(lxItem?.audioQuality).toBeUndefined() // 空地址不得被判为「声称 flac 的可疑项」
    expect(auroraItem?.audioUrl).toBe('http://x/base.mp3') // aurora 侧照常校正
  })

  it('只有 lx 源时不发生任何 aurora 基线请求', async () => {
    installLxDeps()
    const auroraCalls = installAuroraFetch()
    await searchOnlineTracks('纯脚本词', { sources: [lxSource()], quality: 'flac' })
    expect(auroraCalls).toHaveLength(0)
  })
})

describe('缓存键分源', () => {
  it('两个 lx 源即使脚本地址相同也各走各的（不串味）', async () => {
    const calls = installLxDeps()
    const a = lxSource({ id: 'lx-a', name: '洛雪源A', script: lxScript('a') })
    const b = lxSource({ id: 'lx-b', name: '洛雪源B', script: lxScript('b'), sourceUrl: 'http://stub.test/script-b.js' })
    const out = await searchOnlineTracks('双脚本词', { sources: [a, b], quality: '128' })

    expect(calls.filter((u) => u.includes('tag=a'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('tag=b'))).toHaveLength(1)
    expect(out.map((r) => r.source)).toEqual(['lx-a', 'lx-a', 'lx-b', 'lx-b'])
  })

  it('lx 源与 aurora 源同词互不覆盖', async () => {
    const lxCalls = installLxDeps()
    const auroraCalls = installAuroraFetch((b) => (b ? base128 : base128))
    const out = await searchOnlineTracks('同词', { sources: [lxSource(), AURORA], quality: '128' })

    expect(lxCalls).toHaveLength(1)
    expect(auroraCalls).toHaveLength(1)
    expect(out).toHaveLength(3)

    // 再次搜索命中各自缓存：lx 与 aurora 都不再打网络
    await searchOnlineTracks('同词', { sources: [lxSource(), AURORA], quality: '128' })
    expect(lxCalls).toHaveLength(1)
    expect(auroraCalls).toHaveLength(1)
  })

  it('sourceCacheKeyOf：lx 源用 id + kind 兜底，aurora 源仍用解析出的端点', () => {
    expect(sourceCacheKeyOf(lxSource())).toBe('lx\u0001lx-a\u0001http://stub.test/script-a.js')
    // 同�� lx 但 id 不同 → 键必须不同（旧实现会双双退化成空端点）
    expect(sourceCacheKeyOf(lxSource({ id: 'lx-b' }))).not.toBe(sourceCacheKeyOf(lxSource()))
    expect(sourceCacheKeyOf(AURORA)).toBe('http://stub.test/aurora?query={query}&quality={quality}')
  })

  it('isSearchableSource：lx 源不看端点，只看 kind + enabled + sourceUrl', () => {
    expect(isSearchableSource(lxSource({ sourceUrl: 'http://stub.test/s.js' }))).toBe(true)
    expect(isSearchableSource(lxSource({ enabled: false }))).toBe(false)
    expect(isSearchableSource(lxSource({ sourceUrl: '' }))).toBe(false)
    expect(isSearchableSource(AURORA)).toBe(true)
    // aurora 源沿用既有口径：端点解析不出来（空地址）就不参与搜索
    expect(isSearchableSource({ ...AURORA, sourceUrl: '' })).toBe(false)
    expect(isSearchableSource(null)).toBe(false)
  })
})

describe('lx 源的跳过与告警', () => {
  it('宿主未注册：跳过 lx 源并告警，aurora 源不受影响', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auroraCalls = installAuroraFetch((b) => (b ? base128 : base128))
    const out = await searchOnlineTracks('无宿主词', { sources: [lxSource(), AURORA], quality: '128' })

    expect(auroraCalls).toHaveLength(1)
    expect(out).toHaveLength(1)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('未初始化洛雪脚本宿主'))).toBe(true)
  })

  it('只有 lx 源且宿主未注册时返回空结果（不抛错冒充网络故障）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await searchOnlineTracks('无宿主词2', { sources: [lxSource()], quality: '128' })
    expect(out).toEqual([])
  })

  it('脚本源码不可得：跳过该源并告警', async () => {
    installLxDeps()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const noScript = lxSource({ id: 'lx-nil', name: '无脚本源', script: undefined })
    setLxScriptProvider(() => null)
    const out = await searchOnlineTracks('缺脚本词', { sources: [noScript], quality: '128' })

    expect(out).toEqual([])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('脚本源码不可得'))).toBe(true)
  })

  it('脚本执行失败算单源失败，其它源照常返回', async () => {
    const lxCalls = installLxDeps()
    const badScript = `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function () { return Promise.reject(new Error('脚本炸了')) })
lx.send(lx.EVENT_NAMES.inited, { sources: { kw: { name: '酷我', type: 'music', actions: ['search'], qualitys: ['128k'] } } })
`
    const auroraCalls = installAuroraFetch((b) => (b ? base128 : base128))
    const out = await searchOnlineTracks('半挂词', {
      sources: [lxSource({ id: 'lx-bad', script: badScript }), AURORA],
      quality: '128',
    })
    expect(lxCalls).toHaveLength(0)
    expect(auroraCalls).toHaveLength(1)
    expect(out.map((r) => r.source)).toEqual(['src-1'])
  })
})
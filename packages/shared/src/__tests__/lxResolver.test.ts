/**
 * 洛雪取址编排层单测（不打真实网络）
 *
 * 覆盖三件事：
 *   1) 「通用元信息 → 脚本字段」的平台映射（kw/kg/tx/wy/mg），以及缺字段时**不发请求**直接返回原因；
 *   2) 取址编排的各类失败路径（定位信息缺失 / 源不存在 / 非 lx 源 / 源停用 / 脚本不可得）；
 *   3) deps.request 的宿主回调协议（err / body 两种形态）被脚本与宿主正确消费。
 *
 * 脚本用最小的洛雪格式内联，经真实宿主（lxHost）执行，不 mock 宿主本身。
 */
import {
  setLxScriptProvider,
  toLxMusicInfo,
  isUsableLxMeta,
  resolveLxTrack,
  resolveLxTrackUrl,
  resolveLxScript,
  type LxResolveOutcome,
} from '../lxResolver'
import { clearLxSourceCache, type LxHostDeps, type LxRequestOptions } from '../lxHost'
import type { OnlineSourceConfig } from '../types'

// ─── 桩：脚本与宿主依赖 ───────────────────────────────────────────

/**
 * 最小洛雪脚本：kw 平台同时声明 search 与 musicUrl，两者都经 lx.request 走宿主。
 * 用它既能验证宿主回调协议，又能从外部统计脚本被调用的次数。
 */
const SCRIPT_KW = `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  var action = arg.action
  var info = arg.info || {}
  if (action === 'search') {
    return new Promise(function (resolve, reject) {
      lx.request('http://stub.test/search?k=' + encodeURIComponent(info.keyword || ''), { method: 'get' }, function (err, resp, body) {
        if (err) return reject(err)
        if (!resp || resp.statusCode !== 200) return reject(new Error('HTTP ' + (resp && resp.statusCode)))
        var data = typeof body === 'string' ? JSON.parse(body) : body
        resolve(data.list)
      })
    })
  }
  if (action === 'musicUrl') {
    return new Promise(function (resolve, reject) {
      lx.request('http://stub.test/url', { method: 'post' }, function (err, resp, body) {
        if (err) return reject(err)
        var data = typeof body === 'string' ? JSON.parse(body) : body
        resolve(data.url)
      })
    })
  }
  return Promise.resolve(null)
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: { kw: { name: '酷我', type: 'music', actions: ['musicUrl', 'search'], qualitys: ['128k', '320k', 'flac'] } },
})
`

/** 咪咕形态的脚本：只声明 musicUrl，取址时读 musicInfo.name / singer（不需要 id） */
const SCRIPT_MG = `
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function (arg) {
  var info = arg.info || {}
  if (arg.action !== 'musicUrl') return Promise.resolve(null)
  var m = info.musicInfo || {}
  if (!m.name || !m.singer) return Promise.reject(new Error('缺歌名/歌手'))
  return Promise.resolve('http://mg.test/' + encodeURIComponent(m.name) + '?s=' + encodeURIComponent(m.singer))
})
lx.send(lx.EVENT_NAMES.inited, {
  sources: { mg: { name: '咪咕', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
})
`

interface StubCall {
  url: string
  options: LxRequestOptions
}

/** 假宿主请求：按 url 分流返回体，并记录每次调用 */
function makeDeps(overrides?: {
  searchBody?: (url: string) => unknown
  urlBody?: unknown
  urlErr?: unknown
}): { deps: LxHostDeps; calls: StubCall[] } {
  const calls: StubCall[] = []
  const deps: LxHostDeps = {
    request(url, options, callback) {
      calls.push({ url, options })
      setTimeout(() => {
        if (url.includes('/search')) {
          const body = overrides?.searchBody
            ? overrides.searchBody(url)
            : { list: [{ name: '起风了', singer: '买辣椒也用券', albumName: '专辑', id: '228908' }] }
          callback(null, { statusCode: 200, statusMessage: 'OK', body }, JSON.stringify(body))
          return
        }
        if (overrides?.urlErr) {
          callback(overrides.urlErr, null, undefined)
          return
        }
        const body = overrides?.urlBody ?? { url: 'http://bd.test/real.mp3' }
        callback(null, { statusCode: 200, statusMessage: 'OK', body }, JSON.stringify(body))
      }, 0)
      return () => {}
    },
    env: 'desktop',
  }
  return { deps, calls }
}

function lxSource(over: Partial<OnlineSourceConfig> & { script?: string } = {}): OnlineSourceConfig & { script?: string } {
  return {
    id: 'lx-1',
    name: '洛雪测试源',
    kind: 'lx',
    sourceUrl: 'http://stub.test/script.js',
    enabled: true,
    ...over,
  }
}

afterEach(() => {
  setLxScriptProvider(null)
  clearLxSourceCache()
})

// ─── 字段映射 ─────────────────────────────────────────────────────

describe('元信息 → 脚本字段映射', () => {
  it('酷我 kw：id 同时写入 hash 与 songmid，并带歌名/歌手/专辑/时长', () => {
    const m = toLxMusicInfo('kw', {
      title: ' 起风了 ',
      artist: '买辣椒也用券',
      album: '起风了',
      duration: 325,
      id: '228908',
    })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.musicInfo.hash).toBe('228908')
    expect(m.musicInfo.songmid).toBe('228908')
    expect(m.musicInfo.name).toBe('起风了')
    expect(m.musicInfo.singer).toBe('买辣椒也用券')
    expect(m.musicInfo.albumName).toBe('起风了')
    expect(m.musicInfo.interval).toBe(325)
  })

  it('酷狗 kg：与 kw 同规格（hash / songmid）', () => {
    const m = toLxMusicInfo('kg', { title: '歌', artist: '手', hash: 'HASH1' })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.musicInfo.hash).toBe('HASH1')
    expect(m.musicInfo.songmid).toBe('HASH1')
  })

  it('QQ tx：标识写 songmid', () => {
    const m = toLxMusicInfo('tx', { title: '歌', artist: '手', id: '0039MnYb0qxYhV' })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.musicInfo.songmid).toBe('0039MnYb0qxYhV')
    expect(m.musicInfo.mid).toBe('0039MnYb0qxYhV')
    expect(m.musicInfo.hash).toBeUndefined()
  })

  it('网易 wy：songmid 与 id 都写（脚本字段名不一）', () => {
    const m = toLxMusicInfo('wy', { title: '歌', artist: '手', songmid: '5214170' })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.musicInfo.songmid).toBe('5214170')
    expect(m.musicInfo.id).toBe('5214170')
  })

  it('咪咕 mg：只要歌名 + 歌手，不需要 id', () => {
    const m = toLxMusicInfo('mg', { title: '起风了', artist: '买辣椒也用券' })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.musicInfo.name).toBe('起风了')
    expect(m.musicInfo.singer).toBe('买辣椒也用券')
    expect(m.musicInfo.songmid).toBeUndefined()
  })

  it('缺必要字段时返回原因与缺失清单，不伪造 id', () => {
    const noId = toLxMusicInfo('kw', { title: '歌', artist: '手' })
    expect(noId.ok).toBe(false)
    if (noId.ok) return
    expect(noId.missing).toEqual(['hash', 'songmid'])
    expect(noId.reason).toContain('酷我')

    const mgNoSinger = toLxMusicInfo('mg', { title: '歌' })
    expect(mgNoSinger.ok).toBe(false)
    if (mgNoSinger.ok) return
    expect(mgNoSinger.missing).toContain('singer')
  })

  it('未登记平台按兜底字段名映射（给了就写全）', () => {
    const m = toLxMusicInfo('xx', { title: '歌', artist: '手', songmid: 'MID9' })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    expect(m.musicInfo.songmid).toBe('MID9')
    expect(m.musicInfo.hash).toBe('MID9')
  })

  it('isUsableLxMeta：脚本自带 search 的原始条目可直接回喂', () => {
    expect(isUsableLxMeta('kw', { songmid: '1' })).toBe(true)
    expect(isUsableLxMeta('kw', { title: '歌', singer: '手' })).toBe(false) // kw 要 id
    expect(isUsableLxMeta('mg', { name: '歌', singer: '手' })).toBe(true) // mg 只需名 + 歌手
    expect(isUsableLxMeta('mg', { name: '歌' })).toBe(false)
    expect(isUsableLxMeta('kw', null)).toBe(false)
  })
})

// ─── 取址编排的失败路径 ───────────────────────────────────────────

describe('resolveLxTrack 失败路径（一律返回原因，不抛错）', () => {
  it('缺定位信息 / 缺平台标识', async () => {
    const bare = await resolveLxTrack({ lx: undefined as any })
    expect(bare.url).toBeNull()

    const noPlatform = await resolveLxTrack({ lx: { sourceId: 'lx-1', platform: '', meta: {} } })
    expect(noPlatform.url).toBeNull()
    if (noPlatform.url !== null) return
    expect(noPlatform.reason).toContain('定位信息')
  })

  it('按 id 找不到源配置', async () => {
    const out = await resolveLxTrack({
      lx: { sourceId: 'ghost', platform: 'kw', meta: { songmid: '1' } },
      sources: [lxSource({ id: 'lx-1' })],
    })
    expect(out.url).toBeNull()
    if (out.url !== null) return
    expect(out.reason).toContain('ghost')
  })

  it('源不是洛雪源 / 源已停用', async () => {
    const aurora = { id: 'a1', name: '普通源', sourceUrl: 'http://x.test/aurora', enabled: true }
    const notLx = await resolveLxTrack({
      lx: { sourceId: 'a1', platform: 'kw', meta: { songmid: '1' } },
      sources: [aurora],
    })
    expect(notLx.url).toBeNull()
    if (notLx.url !== null) return
    expect(notLx.reason).toContain('不是洛雪脚本源')

    const disabled = await resolveLxTrack({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } },
      sources: [lxSource({ enabled: false, script: SCRIPT_KW })],
    })
    expect(disabled.url).toBeNull()
    if (disabled.url !== null) return
    expect(disabled.reason).toContain('已停用')
  })

  it('脚本源码不可得（未内联且无供应器）时给出可读原因', async () => {
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } },
      sources: [lxSource()],
    })
    expect(out.url).toBeNull()
    if (out.url !== null) return
    expect(out.reason).toContain('脚本源码不可得')
  })

  it('映射不出必要字段时直接失败，一次请求都不发', async () => {
    const { deps, calls } = makeDeps()
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { title: '只有歌名' } },
      sources: [lxSource({ script: SCRIPT_KW })],
      deps,
    })
    expect(out.url).toBeNull()
    if (out.url !== null) return
    expect(out.reason).toContain('缺少必要字段')
    expect(calls).toHaveLength(0)
  })

  it('宿主未注入时失败而非崩栈', async () => {
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } },
      sources: [lxSource({ script: SCRIPT_KW })],
      deps: null,
    })
    expect(out.url).toBeNull()
    if (out.url !== null) return
    expect(out.reason).toContain('宿主未初始化')
  })
})

// ─── 取址成功路径 + 宿主回调协议 ──────────────────────────────────

describe('resolveLxTrack 成功路径与宿主回调协议', () => {
  it('kw：按需映射字段后取到直链（body 为字符串形态也能解析）', async () => {
    const { deps, calls } = makeDeps()
    const out: LxResolveOutcome = await resolveLxTrack({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: {} },
      meta: { title: '起风了', artist: '买辣椒也用券', id: '228908' },
      sources: [lxSource({ script: SCRIPT_KW })],
      quality: '320',
      deps,
    })
    expect(out.url).toBe('http://bd.test/real.mp3')
    expect(out.quality).toBe('320k') // 脚本声明里有 320k
    expect(calls.map((c) => c.url)).toEqual(['http://stub.test/url'])
  })

  it('脚本自带 search 的原始 meta 直接回喂，不重新映射', async () => {
    const { deps, calls } = makeDeps()
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: 'SELF1', name: '脚本条目', singer: '手' } },
      meta: { title: '会被忽略的通用元信息', artist: 'x' },
      sources: [lxSource({ script: SCRIPT_KW })],
      deps,
    })
    expect(out.url).toBe('http://bd.test/real.mp3')
    expect(calls).toHaveLength(1) // 直接取址，没有多余往返
  })

  it('咪咕 mg：只有歌名 + 歌手，无 id 也能取址', async () => {
    const { deps } = makeDeps()
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-mg', platform: 'mg', meta: { name: '起风了', singer: '买辣椒也用券' } },
      sources: [lxSource({ id: 'lx-mg', name: '幻音咪咕', script: SCRIPT_MG })],
      deps,
    })
    expect(out.url).toBe('http://mg.test/%E8%B5%B7%E9%A3%8E%E4%BA%86?s=%E4%B9%B0%E8%BE%A3%E6%A4%92%E4%B9%9F%E7%94%A8%E5%88%B8')
  })

  it('宿主回调 err 形态被消费：脚本抛错 → 编排层给原因而非崩栈', async () => {
    const { deps } = makeDeps({ urlErr: new Error('上游 500') })
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } },
      sources: [lxSource({ script: SCRIPT_KW })],
      deps,
    })
    expect(out.url).toBeNull()
    if (out.url !== null) return
    expect(out.reason).toBe('上游 500')
  })

  it('脚本返回非法地址时失败（不把非 http 串当直链）', async () => {
    const { deps } = makeDeps({ urlBody: { url: 'not-a-url' } })
    const out = await resolveLxTrack({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } },
      sources: [lxSource({ script: SCRIPT_KW })],
      deps,
    })
    expect(out.url).toBeNull()
  })

  it('resolveLxTrackUrl 只给直链或 null', async () => {
    const { deps } = makeDeps()
    const ok = await resolveLxTrackUrl({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } },
      sources: [lxSource({ script: SCRIPT_KW })],
      deps,
    })
    expect(ok?.url).toBe('http://bd.test/real.mp3')

    const bad = await resolveLxTrackUrl({
      lx: { sourceId: 'lx-1', platform: 'kw', meta: { songmid: '1' } },
      sources: [lxSource({ script: 'var lx = globalThis.lx; lx.send(lx.EVENT_NAMES.inited, { sources: {} })' })],
      deps,
    })
    expect(bad).toBeNull()
  })
})

// ─── 脚本源码供应器 ───────────────────────────────────────────────

describe('脚本源码获取（配置内联优先，其次平台供应器）', () => {
  it('内联脚本直接可用，供应器不被调用', async () => {
    let called = 0
    setLxScriptProvider(() => {
      called++
      return SCRIPT_KW
    })
    expect(await resolveLxScript(lxSource({ script: SCRIPT_KW }))).toBe(SCRIPT_KW)
    expect(called).toBe(0)
  })

  it('无内联脚本时走供应器（异步形态也可）', async () => {
    setLxScriptProvider(async () => SCRIPT_KW)
    expect(await resolveLxScript(lxSource())).toBe(SCRIPT_KW)
  })

  it('供应器抛错 / 返回空按「拿不到脚本」处理', async () => {
    setLxScriptProvider(() => {
      throw new Error('boom')
    })
    expect(await resolveLxScript(lxSource())).toBeNull()
    setLxScriptProvider(() => '   ')
    expect(await resolveLxScript(lxSource())).toBeNull()
  })
})
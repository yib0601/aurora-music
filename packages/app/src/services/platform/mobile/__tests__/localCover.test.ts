/**
 * 移动端封面兜底（`../localCover.ts`）的契约测试。
 *
 * 这一层补的是移动端「我的音乐」的历史空洞：扫描只读一次内嵌封面、已入库记录又原样
 * 复用，下载时封面没嵌进文件的歌就永久空图。因此这里要钉住四条语义：
 *   1. 本地文件有内嵌图 → 落盘 + 写库 + 返回可上屏地址；
 *   2. 确认没有内嵌图 → 返回 null（交给在线兜底），且**不写库**；
 *   3. 读文件 / 解析失败 → 抛错（UI 退避重试），不能记成「这首没有封面」；
 *   4. 在线兜底：按元信息搜、严格匹配候选、下载后落盘写库；无候选返回 null，
 *      下载失败抛错（渲染层据此不缓存本次结果）。
 *
 * 打桩范围与真机保持同一份语义：Capacitor Filesystem / 原生 HTTP / 元数据解析 /
 * 歌源搜索 / 封面落盘。用例里只用一眼可辨的假值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnlineTrackSearchResult, Track } from '@/types'
import type { MobileDatabase } from '../database'

const state = vi.hoisted(() => ({
  /** 解析器替身返回的内嵌封面（null = 这首没有封面） */
  picture: null as null | { data: Uint8Array; format: string },
  /** 解析器替身是否抛错（模拟标签损坏 / 文件读不了） */
  parseFails: false,
  /** 本地文件字节（readLocalAudioBytes 的产物来源） */
  fileBytes: new Uint8Array([0x49, 0x44, 0x33]),
  /** 文件读取的 HTTP 状态（非 2xx = 读失败） */
  fileReadStatus: 200,
  /** saveCoverImage 的调用记录 */
  saved: [] as Array<{ trackId: string; bytes: number; format?: string }>,
  /** db.updateTrack 的调用记录 */
  updates: [] as Array<{ id: string; updates: Record<string, unknown> }>,
  /** 歌源搜索的查询词 */
  searches: [] as string[],
  /** 歌源搜索的返回候选 */
  candidates: [] as OnlineTrackSearchResult[],
  /** 原生 HTTP 的调用地址 */
  httpUrls: [] as string[],
  /** 原生 HTTP 的状态码与响应体（base64 字符串；null = 二进制读失败） */
  httpStatus: 200,
  httpBody: null as string | null,
  /** 让原生 HTTP 永不 resolve（模拟封面站挂住） */
  httpHangs: false,
}))

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA', ExternalStorage: 'EXT' },
  Filesystem: {
    async getUri({ path }: { path: string }) {
      return { uri: `file:///storage/emulated/0/${path}` }
    },
  },
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    convertFileSrc: (p: string) => `https://localhost/_capacitor_file_${p.replace(/^file:\/\//, '')}`,
  },
  CapacitorHttp: {
    async get({ url }: { url: string }) {
      state.httpUrls.push(url)
      if (state.httpHangs) return new Promise<never>(() => {})
      return { status: state.httpStatus, data: state.httpBody }
    },
  },
}))

vi.mock('music-metadata-browser', () => ({
  parseBlob: async () => {
    if (state.parseFails) throw new Error('标签损坏')
    return {
      common: state.picture ? { picture: [state.picture] } : {},
    }
  },
}))

vi.mock('../online', () => ({
  searchOnlineTracks: async (query: string) => {
    state.searches.push(query)
    return state.candidates
  },
}))

vi.mock('../coverFile', () => ({
  saveCoverImage: async (trackId: string, data: Uint8Array, format?: string) => {
    state.saved.push({ trackId, bytes: data.length, format })
    return `https://localhost/_capacitor_file_/data/covers/${trackId}.jpg`
  },
}))

const { ensureEmbeddedCoverForTrack, ensureOnlineCoverForTrack } = await import('../localCover')

const db = {
  async updateTrack(id: string, updates: Record<string, unknown>) {
    state.updates.push({ id, updates })
  },
} as unknown as MobileDatabase

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    path: 'Music/Aurora Music/歌手 - 歌名.m4a',
    title: '歌名',
    artist: '歌手',
    album: '专辑',
    duration: 200,
    addedAt: 0,
    playCount: 0,
    liked: false,
    ...overrides,
  }
}

/** 一张 120 字节的假封面：jpeg 魔数 + 填充（下载后要过魔数校验） */
const COVER_BYTES = (() => {
  const b = new Uint8Array(120).fill(0)
  b.set([0xff, 0xd8, 0xff, 0xe0])
  return b
})()
const COVER_BASE64 = Buffer.from(COVER_BYTES).toString('base64')

beforeEach(() => {
  state.picture = null
  state.parseFails = false
  state.fileBytes = new Uint8Array([0x49, 0x44, 0x33])
  state.fileReadStatus = 200
  state.saved = []
  state.updates = []
  state.searches = []
  state.candidates = []
  state.httpUrls = []
  state.httpStatus = 200
  state.httpBody = null
  state.httpHangs = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: state.fileReadStatus === 200,
      status: state.fileReadStatus,
      // 生产实现取 Blob（music-metadata-browser 按 slice 随机读，不整段进堆）
      async blob() {
        return new Blob([state.fileBytes])
      },
    }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensureEmbeddedCoverForTrack（按需提取内嵌封面）', () => {
  it('文件带内嵌图：落盘、写库，并返回可上屏地址', async () => {
    state.picture = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), format: 'image/jpeg' }
    const track = makeTrack()

    const src = await ensureEmbeddedCoverForTrack(track, db)

    expect(src).toBe(`https://localhost/_capacitor_file_/data/covers/${track.id}.jpg`)
    expect(state.saved).toEqual([{ trackId: track.id, bytes: 4, format: 'image/jpeg' }])
    // 写库是关键：不落库的话每次冷启动都要把同一批文件重新解析一遍
    expect(state.updates).toEqual([{ id: track.id, updates: { coverPath: src } }])
  })

  it('确认没有内嵌图：返回 null 且不写库（交给在线兜底）', async () => {
    const src = await ensureEmbeddedCoverForTrack(makeTrack(), db)
    expect(src).toBeNull()
    expect(state.saved).toEqual([])
    expect(state.updates).toEqual([])
  })

  it('解析失败必须抛错（让 UI 退避重试），不能被当成"这首没有封面"', async () => {
    state.parseFails = true
    await expect(ensureEmbeddedCoverForTrack(makeTrack(), db)).rejects.toThrow()
    expect(state.updates).toEqual([])
  })

  it('读文件失败（HTTP 非 2xx）抛错', async () => {
    state.fileReadStatus = 404
    await expect(ensureEmbeddedCoverForTrack(makeTrack(), db)).rejects.toMatchObject({
      code: 'runtime.error.fileReadFailed',
    })
  })

  it('已有 coverPath 也重新提取：悬空路径不早退，否则与 CoverImage 的 onError 互相踢皮球', async () => {
    // 场景：库里 cover_path 指向已被清掉的缓存文件，UI 侧 onError 只清 store 不写库
    state.picture = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), format: 'image/jpeg' }
    const track = makeTrack({ coverPath: 'https://localhost/_capacitor_file_/data/covers/stale.jpg' })

    const src = await ensureEmbeddedCoverForTrack(track, db)

    expect(src).toBe(`https://localhost/_capacitor_file_/data/covers/${track.id}.jpg`)
    expect(state.saved).toHaveLength(1)
    expect(state.updates).toEqual([{ id: track.id, updates: { coverPath: src } }])
  })

  it('悬空 coverPath + 确认无内嵌图：顺手清掉库里的坏值', async () => {
    const track = makeTrack({ coverPath: 'https://localhost/_capacitor_file_/data/covers/stale.jpg' })
    const src = await ensureEmbeddedCoverForTrack(track, db)
    expect(src).toBeNull()
    expect(state.updates).toEqual([{ id: track.id, updates: { coverPath: undefined } }])
  })
})

describe('ensureOnlineCoverForTrack（在线歌源兜底）', () => {
  function matchingCandidate(overrides: Partial<OnlineTrackSearchResult> = {}): OnlineTrackSearchResult {
    return {
      title: '歌名',
      artist: '歌手',
      album: '专辑',
      duration: 200,
      coverUrl: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg',
      audioUrl: '',
      source: 'aurora',
      ...overrides,
    } as OnlineTrackSearchResult
  }

  it('严格匹配到候选后下载封面、落盘并写库', async () => {
    state.candidates = [matchingCandidate()]
    state.httpBody = COVER_BASE64
    const track = makeTrack()

    const src = await ensureOnlineCoverForTrack(track, { sources: [] }, db)

    expect(state.searches).toEqual(['歌手 歌名'])
    expect(state.httpUrls).toEqual(['https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg'])
    expect(state.saved).toEqual([{ trackId: track.id, bytes: 120, format: undefined }])
    expect(src).toBe(`https://localhost/_capacitor_file_/data/covers/${track.id}.jpg`)
    expect(state.updates).toEqual([{ id: track.id, updates: { coverPath: src } }])
  })

  it('占位歌手不参与查询词（否则只会搜回别人的封面）', async () => {
    state.candidates = [matchingCandidate({ artist: '周杰伦', title: '晴天' })]
    state.httpBody = COVER_BASE64
    const track = makeTrack({ title: '晴天', artist: '未知艺术家' })

    await ensureOnlineCoverForTrack(track, { sources: [] }, db)

    expect(state.searches).toEqual(['晴天'])
  })

  it('没有候选：返回 null，不发任何封面请求', async () => {
    state.candidates = []
    const src = await ensureOnlineCoverForTrack(makeTrack(), { sources: [] }, db)
    expect(src).toBeNull()
    expect(state.httpUrls).toEqual([])
    expect(state.updates).toEqual([])
  })

  it('候选带封面地址但版本/时长对不上：不借用（宁可无图也不贴错图）', async () => {
    // 时长差 60s = 另一个录音（电台剪辑 / Live 抽段）
    state.candidates = [matchingCandidate({ duration: 260 })]
    const src = await ensureOnlineCoverForTrack(makeTrack(), { sources: [] }, db)
    expect(src).toBeNull()
    expect(state.httpUrls).toEqual([])
  })

  it('封面下载失败（HTTP 非 2xx）抛错：渲染层据此不缓存本次结果、下次重试', async () => {
    state.candidates = [matchingCandidate()]
    state.httpStatus = 403
    state.httpBody = null
    await expect(ensureOnlineCoverForTrack(makeTrack(), { sources: [] }, db)).rejects.toMatchObject({
      code: 'runtime.error.coverHttpStatus',
    })
    expect(state.updates).toEqual([])
  })

  it('曲目自己已有远端封面地址（在线快照）：直接跳过，不搜歌源也不下载', async () => {
    // 在线快照永远不入库，给它落盘封面只会产生没人引用、也没人能清理的孤儿文件
    const src = await ensureOnlineCoverForTrack(
      makeTrack({ coverUrl: 'http://p1.music.126.net/abc.jpg' }),
      { sources: [] },
      db
    )
    expect(src).toBeNull()
    expect(state.searches).toEqual([])
    expect(state.httpUrls).toEqual([])
  })

  it('封面地址给的是 HTML（CDN 错误页 / 验证页）：抛 coverInvalid，绝不落盘', async () => {
    state.candidates = [matchingCandidate()]
    state.httpBody = Buffer.from('<html>not an image</html>'.repeat(8)).toString('base64')
    await expect(ensureOnlineCoverForTrack(makeTrack(), { sources: [] }, db)).rejects.toMatchObject({
      code: 'runtime.error.coverInvalid',
    })
    expect(state.saved).toEqual([])
  })

  it('原生侧把响应当 JSON 解析（data 非字符串）：抛 coverInvalid 而不是报 HTTP 200', async () => {
    state.candidates = [matchingCandidate()]
    state.httpStatus = 200
    state.httpBody = null
    await expect(ensureOnlineCoverForTrack(makeTrack(), { sources: [] }, db)).rejects.toMatchObject({
      code: 'runtime.error.coverInvalid',
    })
  })

  it('封面下载挂住：按超时抛 coverTimeout（渲染层下次挂载重试）', async () => {
    state.candidates = [matchingCandidate()]
    state.httpHangs = true
    vi.useFakeTimers()
    try {
      const pending = ensureOnlineCoverForTrack(makeTrack(), { sources: [] }, db)
      const assertion = expect(pending).rejects.toMatchObject({ code: 'runtime.error.coverTimeout' })
      await vi.advanceTimersByTimeAsync(15000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('已有低清 coverPath 时仍然去搜（低清升级）：命中后覆盖为新封面', async () => {
    state.candidates = [matchingCandidate()]
    state.httpBody = COVER_BASE64
    const track = makeTrack({ coverPath: 'https://localhost/_capacitor_file_/data/covers/lowres.jpg' })

    const src = await ensureOnlineCoverForTrack(track, { sources: [] }, db)

    expect(state.searches).toEqual(['歌手 歌名'])
    expect(src).toBe(`https://localhost/_capacitor_file_/data/covers/${track.id}.jpg`)
    expect(state.updates).toEqual([{ id: track.id, updates: { coverPath: src } }])
  })
})

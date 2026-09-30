import { describe, it, expect } from 'vitest'
import {
  CACHE_POOLS,
  audioExtFrom,
  cacheBodyKey,
  cacheFileKey,
  hashCacheKey,
  imageExtFrom,
  parseCacheIndex,
  poolLimitsMB,
  selectEvictions,
  serializeCacheIndex,
  sumSizes,
  type CacheEntry,
} from '../mediaCacheCore'

function entry(pool: CacheEntry['pool'], size: number, lastUsed: number, file = `${pool}-${lastUsed}`): [string, CacheEntry] {
  return [cacheBodyKey(pool, file), { pool, file, size, lastUsed }]
}

describe('poolLimitsMB 容量分配', () => {
  it('1024MB 档位按 80/15/5 切给三个池', () => {
    const limits = poolLimitsMB(1024)
    expect(limits.audio).toBeCloseTo(819.2, 5)
    expect(limits.cover).toBeCloseTo(153.6, 5)
    expect(limits.lyrics).toBeCloseTo(51.2, 5)
    // 各池之和等于总量（未被最低配额顶飞）
    expect(limits.audio + limits.cover + limits.lyrics).toBeCloseTo(1024, 5)
  })

  it('小档位下最低配额生效，且各池之和不超过总量', () => {
    const limits = poolLimitsMB(10)
    expect(limits.audio).toBeGreaterThan(0)
    expect(limits.cover).toBeGreaterThan(0)
    expect(limits.lyrics).toBeGreaterThan(0)
    // 10MB 撑不起 16/8/4 的下限，必须等比缩回，否则三池之和会超过用户设定的上限
    expect(limits.audio + limits.cover + limits.lyrics).toBeLessThanOrEqual(10 + 1e-9)
    expect(limits.audio).toBeGreaterThan(limits.cover)
    expect(limits.cover).toBeGreaterThan(limits.lyrics)
  })

  it('档位足够大时各池恰好按比例切分，不再触发缩回', () => {
    // 80MB 是三者同时满足「比例值 ≥ 最低配额」的最小档位：64 / 12 / 4
    const limits = poolLimitsMB(80)
    expect(limits.audio).toBeCloseTo(64, 5)
    expect(limits.cover).toBeCloseTo(12, 5)
    expect(limits.lyrics).toBeCloseTo(4, 5)
    expect(limits.audio + limits.cover + limits.lyrics).toBeCloseTo(80, 5)
  })

  it('档位介于最低配额与比例平衡点之间时依然按总量缩回', () => {
    // 28MB 时比例值（22.4 / 4.2 / 1.4）会被最低配额（16 / 8 / 4）顶到 34.4，
    // 超过用户设定的总量，必须等比缩回——否则「上限」形同虚设
    const limits = poolLimitsMB(28)
    expect(limits.audio + limits.cover + limits.lyrics).toBeLessThanOrEqual(28 + 1e-9)
    expect(limits.audio).toBeGreaterThan(limits.cover)
    expect(limits.cover).toBeGreaterThan(limits.lyrics)
  })

  it('关闭档位与非法输入一律返回零容量', () => {
    for (const value of [0, -1, NaN, Infinity]) {
      const limits = poolLimitsMB(value)
      for (const pool of CACHE_POOLS) expect(limits[pool]).toBe(0)
    }
  })
})

describe('sumSizes 与 selectEvictions 驱逐选择', () => {
  it('总量与单池占用分别统计', () => {
    const entries = [entry('audio', 100, 1), entry('cover', 20, 2), entry('lyrics', 5, 3)]
    expect(sumSizes(entries.map(([, e]) => e))).toBe(125)
    expect(sumSizes(entries.map(([, e]) => e), 'cover')).toBe(20)
  })

  it('超限时按最久未用优先挑出要删的条目', () => {
    const entries = [
      entry('audio', 100, 100, 'new'),
      entry('audio', 100, 50, 'old'),
      entry('audio', 100, 10, 'oldest'),
      entry('cover', 999, 1, 'cover'),
    ]
    // 300 字节占用、配额 150：必须删到剩下的不超过 150
    const doomed = selectEvictions(entries, 'audio', 150)
    expect(doomed).toEqual([cacheBodyKey('audio', 'oldest'), cacheBodyKey('audio', 'old')])
    // 封面池的条目不受音频池驱逐影响
    expect(doomed).not.toContain(cacheBodyKey('cover', 'cover'))
  })

  it('未超限不驱逐，恰好等于配额也不驱逐', () => {
    const entries = [entry('audio', 100, 1), entry('audio', 100, 2)]
    expect(selectEvictions(entries, 'audio', 200)).toEqual([])
    expect(selectEvictions(entries, 'audio', 201)).toEqual([])
  })

  it('配额为 0 是冻结语义：不驱逐任何条目', () => {
    const entries = [entry('audio', 5000, 1), entry('lyrics', 5000, 2)]
    expect(selectEvictions(entries, 'audio', 0)).toEqual([])
    expect(selectEvictions(entries, 'lyrics', 0)).toEqual([])
  })
})

describe('索引解析与序列化', () => {
  it('往返后条目内容一致', () => {
    const entries = new Map<string, CacheEntry>()
    entries.set(cacheBodyKey('audio', 'stem1'), {
      pool: 'audio',
      file: 'stem1.mp3',
      size: 1234,
      lastUsed: 1700000000000,
      url: 'https://example.com/a.mp3',
    })
    entries.set(cacheBodyKey('lyrics', 'track-1'), {
      pool: 'lyrics',
      file: 'track-1.lrc',
      size: 400,
      lastUsed: 1700000001000,
      trackId: 'track-1',
    })
    const parsed = parseCacheIndex(JSON.parse(serializeCacheIndex(entries)))
    expect(parsed.size).toBe(2)
    expect(parsed.get(cacheBodyKey('audio', 'stem1'))).toEqual(entries.get(cacheBodyKey('audio', 'stem1')))
    expect(parsed.get(cacheBodyKey('lyrics', 'track-1'))).toEqual(entries.get(cacheBodyKey('lyrics', 'track-1')))
  })

  it('旧版单池索引（无 version、键为裸哈希）升级为音频池', () => {
    const legacy = { entries: { deadbeef: { file: 'deadbeef.mp3', size: 2048, lastUsed: 1600000000000 } } }
    const parsed = parseCacheIndex(legacy)
    expect(parsed.size).toBe(1)
    const up = parsed.get(cacheBodyKey('audio', 'deadbeef'))
    expect(up?.pool).toBe('audio')
    expect(up?.file).toBe('deadbeef.mp3')
    expect(up?.size).toBe(2048)
  })

  it('非法条目被丢弃，损坏输入返回空索引', () => {
    const messy = {
      version: 2,
      entries: {
        'audio:ok': { pool: 'audio', file: 'ok.mp3', size: 1, lastUsed: 1 },
        'audio:noFile': { pool: 'audio', size: 1 },
        'audio:noSize': { pool: 'audio', file: 'x.mp3' },
        'video:bad': { pool: 'video', file: 'v.mp4', size: 1 },
      },
    }
    const parsed = parseCacheIndex(messy)
    expect([...parsed.keys()]).toEqual(['audio:ok'])
    expect(parseCacheIndex(null).size).toBe(0)
    expect(parseCacheIndex({}).size).toBe(0)
    expect(parseCacheIndex({ entries: 'nope' }).size).toBe(0)
  })

  it('缺失的 lastUsed 用当前时间兜底，避免整批条目被当成最冷数据', () => {
    const before = Date.now()
    const parsed = parseCacheIndex({ version: 2, entries: { 'cover:a': { pool: 'cover', file: 'a.jpg', size: 10 } } })
    const parsedEntry = parsed.get('cover:a')
    expect(parsedEntry?.lastUsed).toBeGreaterThanOrEqual(before)
  })

  it('反查键按池与文件名拼接', () => {
    expect(cacheFileKey('cover', 'abc.jpg')).toBe('cover:abc.jpg')
  })
})

describe('hashCacheKey 稳定文件名', () => {
  it('与标准 SHA-1 输出一致（含多字节与长输入）', () => {
    const vectors: Array<[string, string]> = [
      ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
      ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
      ['abcdefghijklmnopqrstuvwxyz', '32d10c7b8cf96570ca04ce37f2a19d84240d3a89'],
      ['src-1|12345', 'f5b06be63ddd1a5f90482f0219560d2c42e740ec'],
      ['在线源|中文歌曲名', 'dbdcbb90b8e70ab2adeebc4c210c216122e17ab2'],
      ['a'.repeat(200), 'e61cfffe0d9195a525fc6cf06ca2d77119c24a40'],
    ]
    for (const [input, expected] of vectors) {
      expect(hashCacheKey(input)).toBe(expected)
    }
  })

  it('同一键始终得到同一文件名，不同键不碰撞', () => {
    const key = 'https://cdn.example.com/song.mp3?token=abc'
    expect(hashCacheKey(key)).toBe(hashCacheKey(key))
    expect(hashCacheKey(key)).not.toBe(hashCacheKey(`${key}x`))
    // 文件名安全：只需十六进制字符，不含路径分隔符与 URL 特殊字符
    expect(hashCacheKey(key)).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('扩展名推断', () => {
  it('Content-Type 优先，其次 URL 后缀，最后兜底', () => {
    expect(audioExtFrom('audio/flac')).toBe('.flac')
    expect(audioExtFrom('audio/mpeg; charset=utf-8')).toBe('.mp3')
    expect(audioExtFrom(null, 'https://a.com/x.m4a?t=1')).toBe('.m4a')
    expect(audioExtFrom(null, 'https://a.com/x.unknown')).toBe('.mp3')
    expect(audioExtFrom(undefined)).toBe('.mp3')
  })

  it('图片扩展名归一 jpeg→jpg，判不出来按 jpg', () => {
    expect(imageExtFrom('image/png')).toBe('.png')
    expect(imageExtFrom('image/webp')).toBe('.webp')
    expect(imageExtFrom(null, 'https://a.com/c.jpeg')).toBe('.jpg')
    expect(imageExtFrom(null, 'https://a.com/cover')).toBe('.jpg')
  })
})

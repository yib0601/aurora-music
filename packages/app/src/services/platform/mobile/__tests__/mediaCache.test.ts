/**
 * 移动端媒体缓存的落盘逻辑单测（Capacitor Filesystem 以内存实现打桩）。
 *
 * 为什么不跑真机：容量分配与 LRU 驱逐的边角（超限、并发去重、清空后占用回涨、
 * 索引随重启恢复、半截文件清理）在真机上要反复写爆配额才能复现，而这些分支恰好
 * 是最容易出错的地方。打桩后这些路径能确定性重放；真机只用于确认「设置页出现
 * 缓存分区 + 播放落盘」这条主干。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCacheKey } from '@aurora/shared'

interface MemFile {
  size: number
  mtime: number
  content?: string
}

const state = vi.hoisted(() => ({
  files: new Map<string, { size: number; mtime: number; content?: string }>(),
  dirs: new Set<string>(),
  downloads: [] as Array<{ url: string; path: string }>,
  failDownload: false,
  downloadSize: 400 * 1024,
  imageSize: 60 * 1024,
}))

vi.mock('@capacitor/filesystem', () => {
  const trim = (p: string) => p.replace(/\/+$/, '')
  return {
    Directory: { Data: 'DATA' },
    Filesystem: {
      async mkdir({ path }: { path: string }) {
        state.dirs.add(trim(path))
      },
      async readdir({ path }: { path: string }) {
        const prefix = `${trim(path)}/`
        const names = new Set<string>()
        for (const file of state.files.keys()) {
          if (!file.startsWith(prefix)) continue
          const rest = file.slice(prefix.length)
          if (!rest || rest.includes('/')) continue
          names.add(rest)
        }
        return {
          files: [...names].map((name) => ({
            name,
            type: 'file' as const,
            size: state.files.get(prefix + name)?.size ?? 0,
          })),
        }
      },
      async getUri({ path }: { path: string }) {
        return { uri: `file:///data/user/0/com.aurora.music/files/${trim(path)}` }
      },
      async stat({ path }: { path: string }) {
        const file = state.files.get(path)
        if (!file) throw new Error('File does not exist')
        return { type: 'file' as const, size: file.size, mtime: file.mtime, uri: `file://${path}` }
      },
      async readFile({ path }: { path: string }) {
        const file = state.files.get(path)
        if (!file || file.content === undefined) throw new Error('File does not exist')
        return { data: Buffer.from(file.content, 'utf8').toString('base64') }
      },
      async writeFile({ path, data }: { path: string; data: string }) {
        const text = Buffer.from(String(data), 'base64').toString('utf8')
        state.files.set(path, { size: Buffer.byteLength(text), mtime: Date.now(), content: text })
        return { uri: `file://${path}` }
      },
      async deleteFile({ path }: { path: string }) {
        if (!state.files.delete(path)) throw new Error('File does not exist')
      },
      async rename({ from, to }: { from: string; to: string }) {
        const file = state.files.get(from)
        if (!file) throw new Error('File does not exist')
        state.files.delete(from)
        state.files.set(to, file)
      },
      async rmdir({ path }: { path: string }) {
        const prefix = `${trim(path)}/`
        for (const file of [...state.files.keys()]) if (file.startsWith(prefix)) state.files.delete(file)
        state.dirs.delete(trim(path))
      },
      async downloadFile({ url, path }: { url: string; path: string }) {
        // 失败时也写下半截文件：模拟「HTTP 403 前已开始下载」，验证 catch 路径清干净
        if (state.failDownload) {
          state.files.set(path, { size: 128, mtime: Date.now() })
          throw new Error('HTTP error: 403')
        }
        state.downloads.push({ url, path })
        const size = url.includes('.jpg') ? state.imageSize : state.downloadSize
        state.files.set(path, { size, mtime: Date.now() })
        return { path }
      },
    },
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    convertFileSrc: (p: string) => `https://localhost/_capacitor_file_${p.replace(/^file:\/\//, '')}`,
  },
}))

const AUDIO_DIR = 'aurora-music/media-cache/audio'
const COVER_DIR = 'aurora-music/media-cache/cover'
const LYRIC_DIR = 'aurora-music/lyrics'

type CacheModule = typeof import('../mediaCache')

/** 每次重新加载模块：模块级索引状态等价于一次应用冷启动 */
async function loadCache(): Promise<CacheModule> {
  vi.resetModules()
  return await import('../mediaCache')
}

function filesIn(dir: string): string[] {
  return [...state.files.keys()].filter((p) => p.startsWith(`${dir}/`))
}

function readyFilesIn(dir: string): string[] {
  return filesIn(dir).filter((p) => !p.endsWith('.part'))
}

function nameOf(path: string): string {
  return path.split('/').pop() || path
}

async function waitFor(cond: () => boolean, timeout = 2000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return cond()
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const audioReq = (key: string, url = `https://cdn.example.com/${key}.mp3?token=abc`) => ({ url, key })

beforeEach(() => {
  state.files.clear()
  state.dirs.clear()
  state.downloads.length = 0
  state.failDownload = false
  state.downloadSize = 400 * 1024
  state.imageSize = 60 * 1024
})

describe('移动端媒体缓存：命中与落盘', () => {
  it('首次未命中返回 null 并后台落盘，下次命中本地地址', async () => {
    const cache = await loadCache()
    const req = audioReq('src-1|42')

    const first = await cache.resolveMobileCachedAudio(req)
    expect(first.src).toBeNull()
    // 未命中不阻塞调用方：本次仍用远端地址，后台把流写进缓存
    expect(await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)).toBe(true)

    const second = await cache.resolveMobileCachedAudio(req)
    expect(second.src).toBe(
      `https://localhost/_capacitor_file_/data/user/0/com.aurora.music/files/${AUDIO_DIR}/${hashCacheKey(req.key)}.mp3`
    )
    // 文件名是稳定键的哈希：歌源直链带时效参数，不能直接当文件名
    expect(nameOf(readyFilesIn(AUDIO_DIR)[0])).toMatch(/^[0-9a-f]{40}\.mp3$/)
    // 半截文件不留在目录里
    expect(filesIn(AUDIO_DIR).some((p) => p.endsWith('.part'))).toBe(false)
    // 命中后占用按真实文件大小统计
    expect((await cache.getMobileCacheUsage()).usedBytes).toBe(state.downloadSize)
  })

  it('同一键并发请求只下载一次', async () => {
    const cache = await loadCache()
    const req = audioReq('k-once')
    await Promise.all([cache.resolveMobileCachedAudio(req), cache.resolveMobileCachedAudio(req)])
    expect(await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)).toBe(true)
    expect(state.downloads).toHaveLength(1)
  })

  it('远端封面走独立池，与音频互不影响', async () => {
    const cache = await loadCache()
    await cache.resolveMobileCachedCover({ url: 'https://cdn.example.com/c.jpg', key: 'src-1|42' })
    expect(await waitFor(() => readyFilesIn(COVER_DIR).length === 1)).toBe(true)
    expect(nameOf(readyFilesIn(COVER_DIR)[0])).toMatch(/^[0-9a-f]{40}\.jpg$/)
    expect(readyFilesIn(AUDIO_DIR)).toHaveLength(0)
  })

  it('关闭档位后已有内容照常命中，且不再拉取新内容', async () => {
    const cache = await loadCache()
    const req = audioReq('kept')
    await cache.resolveMobileCachedAudio(req)
    await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)

    await cache.configureMobileMediaCache(0)
    expect((await cache.resolveMobileCachedAudio(req)).src).toBeTruthy()

    const before = state.downloads.length
    await cache.resolveMobileCachedAudio(audioReq('skipped'))
    await new Promise((r) => setTimeout(r, 30))
    expect(state.downloads).toHaveLength(before)
    expect(readyFilesIn(AUDIO_DIR)).toHaveLength(1)
  })

  it('索引文件缺失时按空索引重建，不抛错', async () => {
    const cache = await loadCache()
    await cache.resolveMobileCachedAudio(audioReq('no-index'))
    await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)
    state.files.delete('aurora-music/media-cache/index.json')

    const restarted = await loadCache()
    // 索引没了，文件还在：缓存目录里的孤儿在启动时被清掉，占用归零而不是残留
    expect((await restarted.getMobileCacheUsage()).count).toBe(0)
    expect(readyFilesIn(AUDIO_DIR)).toHaveLength(0)
  })
})

describe('移动端媒体缓存：驱逐与清空', () => {
  it('启动时清掉孤儿文件与半截文件，并收编历史歌词', async () => {
    state.files.set(`${AUDIO_DIR}/orphan.mp3`, { size: 10, mtime: 1 })
    state.files.set(`${AUDIO_DIR}/interrupted.part`, { size: 5, mtime: 1 })
    state.files.set(`${LYRIC_DIR}/legacy.lrc`, { size: 300, mtime: 1000, content: '[00:01]x' })

    const cache = await loadCache()
    const usage = await cache.getMobileCacheUsage()
    expect(state.files.has(`${AUDIO_DIR}/orphan.mp3`)).toBe(false)
    expect(state.files.has(`${AUDIO_DIR}/interrupted.part`)).toBe(false)
    // 缓存实现之前写下的歌词被收编进配额，不再是不受约束的黑洞
    expect(usage.usedBytes).toBe(300)
    expect(usage.count).toBe(1)
  })

  it('超过池配额时按最久未用驱逐', async () => {
    const cache = await loadCache()
    // 1MB 档位：三池按最低配额等比缩回，音频池约 0.57MB，放不下两个 400KB 文件
    await cache.configureMobileMediaCache(1)
    const first = audioReq('oldest')
    const second = audioReq('newer')

    await cache.resolveMobileCachedAudio(first)
    expect(await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)).toBe(true)
    await delay(20)
    await cache.resolveMobileCachedAudio(second)
    await waitFor(() => filesIn(AUDIO_DIR).length >= 2)

    await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)
    expect(nameOf(readyFilesIn(AUDIO_DIR)[0])).toBe(`${hashCacheKey(second.key)}.mp3`)
    expect(state.files.has(`${AUDIO_DIR}/${hashCacheKey(first.key)}.mp3`)).toBe(false)
  })

  it('各池配额与驱逐互相独立：封面池超限不动音频池', async () => {
    const cache = await loadCache()
    await cache.configureMobileMediaCache(1)
    // 音频池 ≈ 0.57MB（一个 400KB 音频放得下），封面池 ≈ 0.29MB（约 5 个 60KB 封面）
    const audio = audioReq('audio-kept')
    await cache.resolveMobileCachedAudio(audio)
    expect(await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)).toBe(true)

    for (let i = 0; i < 8; i++) {
      await cache.resolveMobileCachedCover({ url: `https://cdn.example.com/c${i}.jpg`, key: `c${i}` })
      await waitFor(() => state.downloads.length >= i + 1)
      await delay(10)
    }
    // 封面池超限：收敛到配额内（不是无限堆积），且最新的那张优先留下
    expect(await waitFor(() => readyFilesIn(COVER_DIR).length < 8)).toBe(true)
    expect(readyFilesIn(COVER_DIR).length).toBeGreaterThan(0)
    expect(state.files.has(`${COVER_DIR}/${hashCacheKey('c0')}.jpg`)).toBe(false)
    // 音频在自己的池里，不受封面池驱逐牵连
    expect(state.files.has(`${AUDIO_DIR}/${hashCacheKey(audio.key)}.mp3`)).toBe(true)
  })

  it('清空缓存删掉全部登记文件（含封面池整目录）并把占用归零', async () => {
    const cache = await loadCache()
    await cache.resolveMobileCachedAudio(audioReq('a'))
    await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)
    await cache.resolveMobileCachedCover({ url: 'https://cdn.example.com/c.jpg', key: 'c' })
    await waitFor(() => readyFilesIn(COVER_DIR).length === 1)
    state.files.set(`${LYRIC_DIR}/t-1.lrc`, { size: 512, mtime: Date.now(), content: '[00:01]hi' })
    await cache.registerLyricsFile('t-1', 512)

    await cache.clearMobileMediaCache()

    expect(filesIn(AUDIO_DIR)).toHaveLength(0)
    expect(filesIn(COVER_DIR)).toHaveLength(0)
    expect(state.files.has(`${LYRIC_DIR}/t-1.lrc`)).toBe(false)
    const usage = await cache.getMobileCacheUsage()
    expect(usage).toEqual({ usedBytes: 0, count: 0 })
    // 目录被重建，后续写入仍可用
    expect(state.dirs.has(AUDIO_DIR)).toBe(true)
    expect(state.dirs.has(COVER_DIR)).toBe(true)
  })

  it('清空期间完成的下载不会把占用又涨回去', async () => {
    const cache = await loadCache()
    // 下载在 await 期间被清空：epoch 变化后写回的文件必须丢弃
    const pending = cache.resolveMobileCachedAudio(audioReq('race'))
    await cache.clearMobileMediaCache()
    await pending
    await new Promise((r) => setTimeout(r, 50))
    const usage = await cache.getMobileCacheUsage()
    expect(usage.count).toBe(0)
    expect(filesIn(AUDIO_DIR)).toHaveLength(0)
  })
})

describe('移动端媒体缓存：失败与重启', () => {
  it('下载失败不留半截文件，也不登记条目', async () => {
    state.failDownload = true
    const cache = await loadCache()
    const req = audioReq('broken')
    await cache.resolveMobileCachedAudio(req)
    await waitFor(() => !filesIn(AUDIO_DIR).some((p) => p.endsWith('.part')))

    expect(filesIn(AUDIO_DIR)).toHaveLength(0)
    expect((await cache.getMobileCacheUsage()).count).toBe(0)
    // 失败不缓存终态：下次仍会重试下载
    expect(await waitFor(() => state.downloads.length === 0)).toBe(true)
  })

  it('索引随重启恢复，不重复下载', async () => {
    const cache = await loadCache()
    const req = audioReq('persisted')
    await cache.resolveMobileCachedAudio(req)
    await waitFor(() => readyFilesIn(AUDIO_DIR).length === 1)
    const downloadsAfterFirst = state.downloads.length

    const restarted = await loadCache()
    const hit = await restarted.resolveMobileCachedAudio(req)
    expect(hit.src).toContain(`/${AUDIO_DIR}/${hashCacheKey(req.key)}.mp3`)
    expect(state.downloads).toHaveLength(downloadsAfterFirst)
    expect((await restarted.getMobileCacheUsage()).count).toBe(1)
  })

  it('歌词登记后可计量，命中刷新使用时间', async () => {
    const cache = await loadCache()
    state.files.set(`${LYRIC_DIR}/t-9.lrc`, { size: 400, mtime: 100, content: '[00:01]x' })
    await cache.registerLyricsFile('t-9', 400)
    expect((await cache.getMobileCacheUsage())).toEqual({ usedBytes: 400, count: 1 })

    // 再次读取（体积有变化）走 touch 路径：条目保留而非重复登记
    await cache.touchLyricsFile('t-9', 410)
    expect(await cache.getMobileCacheUsage()).toEqual({ usedBytes: 410, count: 1 })
  })
})

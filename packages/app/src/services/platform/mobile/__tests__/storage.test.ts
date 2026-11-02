/**
 * 移动端网络存储（`../storage.ts`）的契约测试。
 *
 * 这一层是"手机上能不能配 NAS"的全部逻辑：口令落盘、带鉴权探测、远端扫描入库、
 * 以及把远端曲目换成可播的本地地址。它跑在 WebView 里（没有主进程），
 * 所以测试必须把 Capacitor Filesystem、原生 HTTP（经 `setCustomFetch`）、
 * 元数据解析、媒体缓存四处都打桩，并且只用一眼可辨的假地址。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStorageTransportError, setCustomFetch } from '@aurora/shared'
import type { Track } from '@/types'
import type { MobileDatabase } from '../database'

const fsState = vi.hoisted(() => ({ files: new Map<string, string>() }))
const cacheCalls = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
/** 解析器替身返回的内嵌封面（null = 这首没有封面） */
const coverState = vi.hoisted(() => ({
  picture: null as null | { data: Uint8Array; format: string },
  /** 解析器替身是否抛错 */
  parseFails: false,
}))

vi.mock('@capacitor/filesystem', () => {
  const Directory = { Data: 'DATA', ExternalStorage: 'EXTERNAL' }
  const Encoding = { UTF8: 'utf8' }
  const Filesystem = {
    async readFile({ path }: { path: string }) {
      const value = fsState.files.get(path)
      if (value === undefined) throw new Error('File does not exist')
      return { data: value }
    },
    async writeFile({ path, data }: { path: string; data: string }) {
      fsState.files.set(path, String(data))
      return { uri: `file:///data/user/0/com.aurora.music/files/${path}` }
    },
    async mkdir() {},
    async getUri({ path }: { path: string }) {
      return { uri: `file:///data/user/0/com.aurora.music/files/${path}` }
    },
  }
  return { Directory, Encoding, Filesystem }
})

// 封面落盘要用 Capacitor.convertFileSrc 把 file:// 转成 WebView 可加载地址
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    convertFileSrc: (p: string) => `https://localhost/_capacitor_file_${p.replace(/^file:\/\//, '')}`,
  },
}))

vi.mock('music-metadata-browser', () => ({
  parseBlob: async () => {
    if (coverState.parseFails) throw new Error('标签损坏')
    return {
      common: {
        title: '标题',
        artist: '歌手',
        album: '专辑',
        track: { no: 1 },
        ...(coverState.picture ? { picture: [coverState.picture] } : {}),
      },
      format: { container: 'MP3', duration: 12 },
    }
  },
}))

vi.mock('../mediaCache', () => ({
  awaitCachedAudio: async (req: Record<string, unknown>) => {
    cacheCalls.calls.push(req)
    return { src: 'https://localhost/_capacitor_file_/cache/a.mp3' }
  },
}))

const { syncLibrarySources, saveStorageCredential, storageCredentialState, clearStorageCredential, probeLibrarySource, scanLibrarySource, removeLibrarySource, resolveStorageAudio, ensureStorageCover, ensureStorageCoverForTrack, listMobileStoragePlugins } =
  await import('../storage')
const { resetKeystoreProbe } = await import('../secureStorage')

const CREDENTIALS_FILE = 'aurora-music/storage-credentials.json'
const SOURCE_ID = 'src-0001'

/** 目录清单：`''` 是根，其余按相对路径给出文件/子目录 */
interface Entry {
  path: string
  dir?: boolean
}
let layout: Entry[] = []
/** 请求记录（断言鉴权头与地址用） */
const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = []
/** 需要模拟失败的目录（前缀匹配） */
let failingDirs = new Set<string>()
/** 让 Range 读取返回 401（模拟 NAS 拒绝 / 会话过期） */
let rangeRejects = false

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function propfindBody(dir: string): string {
  const encode = (p: string) => p.split('/').map(encodeURIComponent).join('/')
  const responses: string[] = []
  const push = (path: string, isDir: boolean) => {
    responses.push(`<D:response>
  <D:href>/dav/Music/${encode(path)}${isDir ? '/' : ''}</D:href>
  <D:propstat><D:prop>
    <D:displayname>${xmlEscape(path.split('/').pop() || '')}</D:displayname>
    <D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
    <D:getcontentlength>1024</D:getcontentlength>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`)
  }
  push(dir, true)
  const prefix = dir ? `${dir}/` : ''
  for (const entry of layout) {
    if (entry.path === dir) continue
    if (!entry.path.startsWith(prefix)) continue
    if (entry.path.slice(prefix.length).includes('/')) continue
    push(entry.path, Boolean(entry.dir))
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`
}

function installFetch(): void {
  setCustomFetch(async (input, init) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    const headers = (init?.headers || {}) as Record<string, string>
    seen.push({ url, method, headers })
    if (method === 'PROPFIND') {
      const rel = decodeURIComponent(new URL(url).pathname)
        .replace(/^\/dav\/Music\/?/, '')
        .replace(/\/$/, '')
      if (failingDirs.has(rel)) throw new Error('boom')
      return new Response(propfindBody(rel), {
        status: 207,
        headers: { 'content-type': 'application/xml' },
      })
    }
    // Range GET（读元数据头 / 内嵌封面）
    if (rangeRejects) return new Response(new Uint8Array(0), { status: 401 })
    return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 206 })
  })
}

const inserted: Track[] = []
const cleaned: Array<{ prefix: string; existing?: ReadonlySet<string> }> = []
const existing = new Map<string, Track>()

const fakeDb = {
  async getTracksByPaths() {
    return existing
  },
  async insertTrack(track: Track) {
    inserted.push(track)
  },
  async deleteTracksBySourcePrefix(prefix: string, paths?: ReadonlySet<string>) {
    cleaned.push({ prefix, existing: paths })
    return 0
  },
  async getAllTracks() {
    return []
  },
} as unknown as MobileDatabase

const deps = { db: fakeDb, ensureDbInited: async () => {} }

beforeEach(() => {
  fsState.files.clear()
  cacheCalls.calls.length = 0
  seen.length = 0
  inserted.length = 0
  cleaned.length = 0
  existing.clear()
  failingDirs = new Set()
  rangeRejects = false
  coverState.picture = null
  coverState.parseFails = false
  resetKeystoreProbe()
  layout = [{ path: 'a.mp3' }, { path: 'b.flac' }]
  installFetch()
  syncLibrarySources([
    {
      id: SOURCE_ID,
      kind: 'webdav',
      pluginId: 'webdav',
      name: '演示 NAS',
      settings: { baseUrl: 'https://nas.invalid/dav', rootPath: 'Music', username: 'demo' },
      enabled: true,
    },
  ])
})

afterEach(() => setCustomFetch(null))

describe('移动端存储：口令落在应用私有目录', () => {
  it('保存后能读回状态，且文件里只有应用私有目录这一个落点', async () => {
    const saved = await saveStorageCredential(SOURCE_ID, { password: 'demo-secret' })
    expect(saved).toMatchObject({ ok: true, saved: true, protection: 'app-private' })
    expect(fsState.files.get(CREDENTIALS_FILE)).toContain('demo-secret')

    const state = await storageCredentialState(SOURCE_ID)
    expect(state.saved).toBe(true)
    // 没有密钥环：如实回报"存住了但没加密"，UI 据此用另一句文案
    expect(state.protection).toBe('app-private')

    const cleared = await clearStorageCredential(SOURCE_ID)
    expect(cleared.saved).toBe(false)
    expect(await storageCredentialState(SOURCE_ID)).toMatchObject({ saved: false })
  })
})

describe('移动端存储：探测与扫描都带上鉴权头', () => {
  it('probe 把口令注入配置（settings 里的口令不落 localStorage，只在调用前一瞬间合并）', async () => {
    await saveStorageCredential(SOURCE_ID, { password: 'demo-secret' })
    const result = await probeLibrarySource(SOURCE_ID)
    expect(result.ok).toBe(true)
    const propfind = seen.find((r) => r.method === 'PROPFIND')
    expect(propfind?.url).toBe('https://nas.invalid/dav/Music')
    // Basic base64("demo:demo-secret")
    expect(propfind?.headers.Authorization).toBe(`Basic ${Buffer.from('demo:demo-secret').toString('base64')}`)
  })

  it('扫描入库：path 编入来源、写入 sourceId，并且完整时按前缀做缺失清理', async () => {
    await saveStorageCredential(SOURCE_ID, { password: 'demo-secret' })
    const result = await scanLibrarySource(SOURCE_ID, deps)

    expect(result.complete).toBe(true)
    expect(result.failedDirs).toBe(0)
    expect(result.tracks).toHaveLength(2)
    const [first] = result.tracks
    expect(first.path.startsWith(`webdav:${SOURCE_ID}/`)).toBe(true)
    expect(first.sourceId).toBe(SOURCE_ID)
    // 移动端不写 remoteUrl：aurora-remote:// 在手机上没人处理
    expect(first.remoteUrl).toBeUndefined()
    expect(inserted).toHaveLength(2)
    expect(cleaned[0]?.prefix).toBe(`webdav:${SOURCE_ID}/`)
  })

  it('子目录列举失败时保持 complete=false，且**不做**缺失清理（防误删曲库）', async () => {
    layout = [{ path: 'Sub', dir: true }, { path: 'Sub/x.mp3' }, { path: 'y.mp3' }]
    failingDirs = new Set(['Sub'])
    const result = await scanLibrarySource(SOURCE_ID, deps)
    expect(result.complete).toBe(false)
    expect(result.failedDirs).toBe(1)
    expect(cleaned).toHaveLength(0)
  })

  it('移除来源按前缀清理并返回全库', async () => {
    const tracks = await removeLibrarySource(SOURCE_ID, deps)
    expect(tracks).toEqual([])
    expect(cleaned[0]?.prefix).toBe(`webdav:${SOURCE_ID}/`)
  })
})

describe('移动端存储：远端曲目换成可播的本地地址', () => {
  it('把可直连地址与鉴权头交给媒体缓存，返回本地文件地址', async () => {
    await saveStorageCredential(SOURCE_ID, { password: 'demo-secret' })
    const result = await resolveStorageAudio({
      sourceId: SOURCE_ID,
      path: `webdav:${SOURCE_ID}/a.mp3`,
    })
    expect(result.src).toBe('https://localhost/_capacitor_file_/cache/a.mp3')
    const call = cacheCalls.calls[0]
    expect(call.url).toBe('https://nas.invalid/dav/Music/a.mp3')
    expect((call.headers as Record<string, string>).Authorization).toContain('Basic ')
    // 缓存键按"来源 + 相对路径"稳定派生（直链会变，键不能变）
    expect(call.key).toBe(`storage|${SOURCE_ID}|a.mp3`)
  })

  it('来源不存在时不猜地址，直接返回 null（调用方按取址失败处理）', async () => {
    expect(await resolveStorageAudio({ sourceId: 'ghost', path: 'webdav:ghost/a.mp3' })).toEqual({
      src: null,
    })
    expect(cacheCalls.calls).toHaveLength(0)
  })
})

describe('移动端存储：可添加的协议名单', () => {
  it('SFTP / SMB 在移动端标为不可用（依赖只在桌面端注入），WebDAV 可用', () => {
    const metas = listMobileStoragePlugins()
    const byId = new Map(metas.map((meta) => [meta.id, meta]))
    expect(byId.get('webdav')?.available).toBe(true)
    // 未注入 ssh2 / smb2：这两个协议在手机上连"新增来源"的入口都不该出现
    expect(byId.get('sftp')?.available).toBe(false)
    expect(byId.get('smb')?.available).toBe(false)
  })
})

/**
 * Keystore 替身：AES-GCM 的真实行为不可在 node 里复现，但**契约**可以：
 * `encrypt` 后明文不再出现、`decrypt` 拿回原文、密钥换了就解不开。
 * 实现用单字节异或 + base64（可逆、且输出里不含明文子串）。
 */
function installKeystore(): { rotateKey: () => void; uninstall: () => void } {
  let key = 0x5a
  const scramble = (text: string, k: number): string => {
    const bytes = Buffer.from(text, 'utf8')
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= k
    return bytes.toString('base64')
  }
  const unscramble = (value: string, k: number): string => {
    const bytes = Buffer.from(value, 'base64')
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= k
    return bytes.toString('utf8')
  }
  const plugin = {
    async isAvailable() {
      return { available: true }
    },
    async encrypt({ plaintext }: { plaintext: string }) {
      return { value: scramble(plaintext, key) }
    },
    async decrypt({ value }: { value: string }) {
      return { plaintext: unscramble(value, key) }
    },
  }
  ;(globalThis as Record<string, unknown>).window = { Capacitor: { Plugins: { SecureStorage: plugin } } }
  return {
    // 模拟"恢复备份/换机重装"：密文还在，密钥已经换了
    rotateKey: () => {
      key = 0x33
    },
    uninstall: () => {
      delete (globalThis as Record<string, unknown>).window
    },
  }
}

/** 一张字节上"完整"的 JPEG（isCompleteImage 也要求 ≥ 64 字节） */
function jpegBytes(size = 96): Uint8Array {
  const data = new Uint8Array(size)
  data[0] = 0xff
  data[1] = 0xd8
  data[2] = 0xff
  data[size - 2] = 0xff
  data[size - 1] = 0xd9
  return data
}

describe('移动端存储：口令经 Android Keystore 加密', () => {
  let keystore: ReturnType<typeof installKeystore>

  beforeEach(() => {
    keystore = installKeystore()
  })

  afterEach(() => {
    keystore.uninstall()
    resetKeystoreProbe()
  })

  it('保存后文件里只有密文容器，状态回报 keystore', async () => {
    const saved = await saveStorageCredential(SOURCE_ID, { password: 'demo-secret' })
    expect(saved).toMatchObject({ ok: true, saved: true, protection: 'keystore' })

    const raw = fsState.files.get(CREDENTIALS_FILE) || ''
    expect(raw).not.toContain('demo-secret')
    expect(JSON.parse(raw)).toMatchObject({ format: 'keystore-v1' })

    expect(await storageCredentialState(SOURCE_ID)).toMatchObject({
      saved: true,
      protection: 'keystore',
    })
  })

  it('解密后的口令仍能拼进鉴权头（探测照常可用，不因加密失效）', async () => {
    await saveStorageCredential(SOURCE_ID, { password: 'demo-secret' })
    const result = await probeLibrarySource(SOURCE_ID)
    expect(result.ok).toBe(true)
    const propfind = seen.find((r) => r.method === 'PROPFIND')
    expect(propfind?.headers.Authorization).toBe(
      `Basic ${Buffer.from('demo:demo-secret').toString('base64')}`
    )
  })

  it('历史明文文件在查询状态时原地加密，用户不必重输口令', async () => {
    fsState.files.set(CREDENTIALS_FILE, JSON.stringify({ [SOURCE_ID]: { password: 'demo-secret' } }))

    const state = await storageCredentialState(SOURCE_ID)
    expect(state).toMatchObject({ saved: true, protection: 'keystore' })
    // 迁移后文件里不再有明文，且口令依然可用于鉴权
    expect(fsState.files.get(CREDENTIALS_FILE)).not.toContain('demo-secret')
    await probeLibrarySource(SOURCE_ID)
    const propfind = seen.find((r) => r.method === 'PROPFIND')
    expect(propfind?.headers.Authorization).toBe(
      `Basic ${Buffer.from('demo:demo-secret').toString('base64')}`
    )
  })

  it('密钥失效（恢复备份 / 换机）时按未保存处理，不谎报已保存', async () => {
    await saveStorageCredential(SOURCE_ID, { password: 'demo-secret' })
    keystore.rotateKey()

    const state = await storageCredentialState(SOURCE_ID)
    expect(state).toMatchObject({ saved: false, protection: 'keystore' })
    // 密文没被删掉：用户重填口令时直接覆盖，旧文件留着也无害
    expect(JSON.parse(fsState.files.get(CREDENTIALS_FILE) || '{}')).toMatchObject({
      format: 'keystore-v1',
    })
  })
})

describe('移动端存储：远端封面按需提取', () => {
  const trackId = 'track-cover-0001'
  const track = {
    id: trackId,
    sourceId: SOURCE_ID,
    path: `webdav:${SOURCE_ID}/a.mp3`,
    fileSize: 2048,
  }

  beforeEach(async () => {
    await saveStorageCredential(SOURCE_ID, { password: 'demo-secret' })
  })

  it('取内嵌封面 → 落盘到封面目录并返回 WebView 可加载地址', async () => {
    coverState.picture = { data: jpegBytes(), format: 'image/jpeg' }

    const coverPath = await ensureStorageCover(track)

    expect(coverPath).toContain(`aurora-music/covers/${trackId}.jpg`)
    expect(coverPath?.startsWith('https://localhost/_capacitor_file_')).toBe(true)
    expect(fsState.files.has(`aurora-music/covers/${trackId}.jpg`)).toBe(true)
    // 只读文件头那一段（1 MiB 上限内取整文件大小）
    const range = seen.find((r) => r.headers.Range)
    expect(range?.headers.Range).toBe('bytes=0-2047')
    expect(range?.headers.Authorization).toContain('Basic ')
  })

  it('确认无内嵌封面时返回 null（渲染层据此缓存"这首没有封面"）', async () => {
    expect(await ensureStorageCover(track)).toBeNull()
    expect(fsState.files.has(`aurora-music/covers/${trackId}.jpg`)).toBe(false)
  })

  it('封面被头段截断（无 EOI）时按无封面处理，不落半张图', async () => {
    const truncated = jpegBytes()
    truncated[truncated.length - 1] = 0x00
    coverState.picture = { data: truncated, format: 'image/jpeg' }

    expect(await ensureStorageCover(track)).toBeNull()
    expect(fsState.files.has(`aurora-music/covers/${trackId}.jpg`)).toBe(false)
  })

  it('头段解析失败按无封面处理（不拿同一段字节反复重试远端）', async () => {
    coverState.parseFails = true
    expect(await ensureStorageCover(track)).toBeNull()
  })

  it('传输层失败必须抛错：NAS 短暂不可达不能被记成"这首没有封面"', async () => {
    coverState.picture = { data: jpegBytes(), format: 'image/jpeg' }
    rangeRejects = true

    await expect(ensureStorageCover(track)).rejects.toSatisfy((err: unknown) =>
      isStorageTransportError(err)
    )
  })

  it('取到封面后写回数据库（否则每次冷启动都要重读同一张封面）', async () => {
    coverState.picture = { data: jpegBytes(), format: 'image/jpeg' }
    const updates: Array<{ id: string; patch: Partial<Track> }> = []
    const db = {
      async getTrackById() {
        return { ...track, title: '标题', artist: '歌手', album: '专辑' } as Track
      },
      async updateTrack(id: string, patch: Partial<Track>) {
        updates.push({ id, patch })
      },
    }

    const coverPath = await ensureStorageCoverForTrack(trackId, { db })

    expect(coverPath).toContain(`aurora-music/covers/${trackId}.jpg`)
    expect(updates).toEqual([{ id: trackId, patch: { coverPath } }])
  })

  it('本地曲目（没有 sourceId）不在这里提取，返回 null 且不碰数据库', async () => {
    const updates: unknown[] = []
    const db = {
      async getTrackById() {
        return { id: trackId, path: '/storage/emulated/0/Music/a.mp3', title: '标题' } as Track
      },
      async updateTrack(id: string, patch: Partial<Track>) {
        updates.push({ id, patch })
      },
    }
    expect(await ensureStorageCoverForTrack(trackId, { db })).toBeNull()
    expect(updates).toHaveLength(0)
  })

  it('不是该来源的坐标（路径前缀不符）时不去猜地址', async () => {
    expect(
      await ensureStorageCover({ ...track, path: `webdav:other/${trackId}.mp3` })
    ).toBeNull()
    expect(seen.some((r) => r.headers.Range)).toBe(false)
  })
})

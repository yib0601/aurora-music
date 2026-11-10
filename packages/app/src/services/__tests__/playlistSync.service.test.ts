/**
 * 歌单同步引擎（`playlistSync.service`）的行为测试。
 *
 * 钉住的是 docs/playlist-sync.md 里**最贵的四条**（错了就丢用户数据或泄口令）：
 *  1) 快照里的曲目引用能落回本机 trackId（匹配成功就不该凭空造出一首占位曲目）；
 *  2) 匹配不上的引用登记成占位曲目，**且不覆盖已有占位曲目的播放统计**；
 *  3) 墓碑会真的删掉本机歌单，但过期墓碑不再传播（否则歌单永远无法重建）；
 *  4) `changed === false` 时一行都不写 store（否则每次定时同步都在刷 updatedAt，
 *     把「用户刚改的」和「服务器上的」搅成一个永远分不出胜负的 LWW）。
 *
 * 另外钉两条与 §10 安全要求直接相关的：口令不出现在 lastError 里、同 config 并发
 * 只跑一轮。平台与插件全部打桩，不碰真实网络与磁盘。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSyncPluginsForTest, registerSyncPlugin } from '@aurora/shared'
import type { MessageKey, SyncConfig, SyncSnapshot, SyncTrackRef } from '@aurora/shared'
import type { Track } from '@/types'
import { usePlaylistStore } from '@/stores/playlistStore'
import {
  migratePersistedSyncState,
  takePendingSecretMigrations,
  useSyncStore,
} from '@/stores/syncStore'
import {
  applySyncedPlaylists,
  initPlaylistSync,
  resetPlaylistSyncForTest,
  snapshotFromStores,
  syncOnce,
  syncPlaceholderId,
  type SyncOutcome,
} from '../playlistSync.service'

const mocks = vi.hoisted(() => ({
  /** 库侧状态（真 store 太重且会拉平台，这里只喂引擎要看的两份数组） */
  library: { tracks: [] as Track[], librarySources: [] as unknown[] },
  platform: {
    supportsPlaylistSync: true,
    lanSync: null as unknown,
    onLanSyncInbox: undefined as
      | undefined
      | ((callback: (snapshots: SyncSnapshot[]) => void) => () => void),
    sync: {
      device: vi.fn(async () => ({ deviceId: 'dev-local', deviceName: '本机' })),
      getCredential: vi.fn(async () => ({}) as Record<string, string>),
      saveCredential: vi.fn(async () => ({ ok: true, saved: true, encryptionAvailable: true })),
      credentialState: vi.fn(async () => ({ saved: false, encryptionAvailable: false })),
      clearCredential: vi.fn(async () => ({ ok: true, saved: false, encryptionAvailable: true })),
    },
  },
}))

vi.mock('@/services/platform', () => ({ platform: mocks.platform }))
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: { getState: () => mocks.library },
}))

/** 900 天之类的时间常量在测试里不该出现魔法数：直接对共享导出的 TTL 取用 */
const TTL_MS = 90 * 24 * 60 * 60 * 1000

const track = (over: Partial<Track> = {}): Track =>
  ({
    id: 'track-local-1',
    path: '/music/album/01 song.flac',
    title: '夜曲',
    artist: '周杰伦',
    album: '十一月的萧邦',
    duration: 226,
    addedAt: 1,
    playCount: 0,
    liked: false,
    ...over,
  }) as Track

const localRef = (over: Partial<Track> = {}): SyncTrackRef => {
  const t = track(over)
  return {
    kind: 'local',
    path: t.path,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
  }
}

const metaRef = (over: Partial<SyncTrackRef> = {}): SyncTrackRef =>
  ({
    kind: 'meta',
    platform: 'aurora',
    onlineId: '003abc',
    title: '别的歌',
    artist: '别人',
    album: '',
    duration: 180,
    ...over,
  }) as SyncTrackRef

const snapshotOf = (
  playlists: SyncSnapshot['playlists'],
  over: Partial<SyncSnapshot> = {}
): SyncSnapshot => ({
  format: 'aurora-playlist-sync/1',
  deviceId: 'dev-remote',
  deviceName: '对端',
  revision: 7,
  updatedAt: 1_700_000_000_000,
  playlists,
  ...over,
})

const playlistOf = (over: Partial<SyncSnapshot['playlists'][number]> = {}) => ({
  id: 'pl-1',
  name: '长途飞行',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  tracks: [] as SyncTrackRef[],
  ...over,
})

/** 一条能跑的同步配置（插件在 beforeEach 里注册） */
const configOf = (over: Partial<SyncConfig> = {}): SyncConfig => ({
  id: 'cfg-1',
  pluginId: 'test-sync',
  name: '测试目标',
  settings: {},
  direction: 'bidirectional',
  autoSync: true,
  enabled: true,
  ...over,
})

beforeEach(() => {
  resetPlaylistSyncForTest()
  clearSyncPluginsForTest()
  usePlaylistStore.setState({
    playlists: [],
    currentPlaylistId: null,
    importedTracks: {},
    syncTombstones: {},
  })
  useSyncStore.setState({
    configs: [],
    runtime: {},
    device: null,
    lan: { status: null, peers: [], scanning: false },
  })
  mocks.library.tracks = []
  mocks.library.librarySources = []
  mocks.platform.sync.device.mockClear()
  mocks.platform.sync.getCredential.mockClear()
  mocks.platform.sync.getCredential.mockResolvedValue({})
  useSyncStore.getState().addConfig(configOf())
})

describe('applySyncedPlaylists：引用解析', () => {
  it('本地路径能匹配时不造占位曲目，成员是本机 trackId', () => {
    const local = track()
    mocks.library.tracks = [local]

    const outcome = applySyncedPlaylists(
      snapshotOf([playlistOf({ tracks: [localRef()] })])
    )

    const playlists = usePlaylistStore.getState().playlists
    expect(playlists).toHaveLength(1)
    expect(playlists[0]?.trackIds).toEqual([local.id])
    expect(outcome).toMatchObject({ added: 1, updated: 0, removed: 0, placeholders: 0 })
    expect(usePlaylistStore.getState().importedTracks).toEqual({})
  })

  it('匹配不上的引用登记成占位曲目（path 空、元数据齐全）', () => {
    const ref = metaRef()
    const outcome = applySyncedPlaylists(snapshotOf([playlistOf({ tracks: [ref] })]))

    const id = syncPlaceholderId(ref)
    expect(outcome.placeholders).toBe(1)
    expect(usePlaylistStore.getState().playlists[0]?.trackIds).toEqual([id])

    const placeholder = usePlaylistStore.getState().importedTracks[id]
    expect(placeholder).toMatchObject({
      id,
      path: '',
      title: '别的歌',
      artist: '别人',
      duration: 180,
      onlineId: '003abc',
      playCount: 0,
      liked: false,
    })
  })

  it('已经存在的占位曲目不被覆盖：播放统计必须留在本机', () => {
    const ref = metaRef()
    const id = syncPlaceholderId(ref)
    usePlaylistStore.setState({
      importedTracks: {
        [id]: track({
          id,
          path: '',
          title: '别的歌',
          artist: '别人',
          duration: 180,
          playCount: 42,
          liked: true,
        }),
      },
    })

    const outcome = applySyncedPlaylists(snapshotOf([playlistOf({ tracks: [ref] })]))

    expect(outcome.placeholders).toBe(0)
    expect(usePlaylistStore.getState().playlists[0]?.trackIds).toEqual([id])
    expect(usePlaylistStore.getState().importedTracks[id]?.playCount).toBe(42)
    expect(usePlaylistStore.getState().importedTracks[id]?.liked).toBe(true)
  })
})

describe('applySyncedPlaylists：墓碑', () => {
  const existing = () =>
    usePlaylistStore.setState({
      playlists: [
        { id: 'pl-1', name: '长途飞行', createdAt: 1, updatedAt: 2, trackIds: [] },
        { id: 'pl-2', name: '留着的', createdAt: 1, updatedAt: 2, trackIds: [] },
      ],
    })

  it('TTL 内的墓碑删掉本机歌单，并记下删除时刻', () => {
    existing()
    const deletedAt = Date.now() - 1000

    const outcome = applySyncedPlaylists(
      snapshotOf([playlistOf({ deletedAt, updatedAt: deletedAt })])
    )

    expect(usePlaylistStore.getState().playlists.map((p) => p.id)).toEqual(['pl-2'])
    expect(usePlaylistStore.getState().syncTombstones['pl-1']).toBe(deletedAt)
    expect(outcome.removed).toBe(1)
  })

  it('过期墓碑不再传播：留着它歌单就永远回不来', () => {
    existing()
    const expired = Date.now() - TTL_MS - 60_000

    applySyncedPlaylists(snapshotOf([playlistOf({ deletedAt: expired, updatedAt: expired })]))

    expect(usePlaylistStore.getState().playlists.map((p) => p.id)).toEqual(['pl-1', 'pl-2'])
    expect(usePlaylistStore.getState().syncTombstones['pl-1']).toBeUndefined()
  })
})

describe('syncOnce：编排与副作用边界', () => {
  const register = (over: Partial<Parameters<typeof registerSyncPlugin>[0]> = {}) => {
    const plugin = {
      id: 'test-sync',
      displayNameKey: 'sync.plugin.webdav.name' as MessageKey,
      version: '1.0.0',
      fields: [],
      pull: vi.fn(async () => [] as SyncSnapshot[]),
      ...over,
    }
    registerSyncPlugin(plugin)
    return plugin
  }

  it('changed=false 时不写 playlist store（连数组引用都不换）', async () => {
    const plugin = register()
    const before = usePlaylistStore.getState().playlists

    const outcome = await syncOnce(useSyncStore.getState().configs[0]!)

    expect(outcome.ok).toBe(true)
    expect(outcome.changed).toBe(false)
    expect(plugin.pull).toHaveBeenCalledTimes(1)
    expect(usePlaylistStore.getState().playlists).toBe(before)
    expect(usePlaylistStore.getState().playlists).toEqual([])
    // 成功要刷 lastSyncAt 并清空上次失败
    const config = useSyncStore.getState().configs[0]!
    expect(config.lastSyncAt).toBeTypeOf('number')
    expect(config.lastError).toBeUndefined()
    expect(useSyncStore.getState().runtime[config.id]?.state).toBe('ok')
  })

  it('同一 config 并发调用复用同一轮（不排队、不重复 pull）', async () => {
    const plugin = register()
    const config = useSyncStore.getState().configs[0]!

    const first = syncOnce(config)
    const second = syncOnce(config)

    expect(second).toBe(first)
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(plugin.pull).toHaveBeenCalledTimes(1)
  })

  it('失败时口令不进 lastError（脱敏后落 syncStore）', async () => {
    const secret = 'super-secret-value'
    mocks.platform.sync.getCredential.mockResolvedValue({ password: secret })
    register({
      pull: vi.fn(async () => {
        throw new Error(`401 for password ${secret}`)
      }),
    })

    const outcome: SyncOutcome = await syncOnce(useSyncStore.getState().configs[0]!)

    expect(outcome.ok).toBe(false)
    const lastError = useSyncStore.getState().runtime['cfg-1']?.lastError ?? ''
    expect(lastError).not.toContain(secret)
    expect(lastError).toContain('***')
    // 退避：第一次失败排 30s 后的重试
    const nextRetryAt = useSyncStore.getState().runtime['cfg-1']?.nextRetryAt ?? 0
    expect(nextRetryAt - Date.now()).toBeGreaterThan(25_000)
  })
})

describe('snapshotFromStores', () => {
  it('墓碑进快照（删过要能传出去），已过 TTL 的墓碑被清掉', () => {
    mocks.library.tracks = [track()]
    const now = Date.now()
    usePlaylistStore.setState({
      playlists: [{ id: 'pl-1', name: '飞行', createdAt: 1, updatedAt: 2, trackIds: [track().id] }],
      syncTombstones: { 'pl-gone': now - 1000, 'pl-ancient': now - TTL_MS - 1000 },
    })

    const snapshot = snapshotFromStores({ deviceId: 'dev-local', deviceName: '本机' })

    expect(snapshot.deviceId).toBe('dev-local')
    const ids = snapshot.playlists.map((p) => p.id)
    expect(ids).toContain('pl-1')
    expect(ids).toContain('pl-gone')
    expect(ids).not.toContain('pl-ancient')
    // 成员存的是引用而不是本机 id：换一台机器才可能解析成别的 id
    expect(snapshot.playlists.find((p) => p.id === 'pl-1')?.tracks[0]).toMatchObject({
      kind: 'local',
      path: track().path,
    })
  })

  it('指向已不存在曲目的成员被丢弃（不硬塞一条空元数据）', () => {
    usePlaylistStore.setState({
      playlists: [
        { id: 'pl-1', name: '飞行', createdAt: 1, updatedAt: 2, trackIds: ['missing-id'] },
      ],
    })

    const snapshot = snapshotFromStores({ deviceId: 'dev-local', deviceName: '本机' })

    expect(snapshot.playlists[0]?.tracks).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * 验证报告（docs/verify-playlist-sync.md）的修复：B-1 / S-1 / S-3 / S-6 / N-2
 * ------------------------------------------------------------------ */

/** 注册一条可控插件（pull 返回固定快照、push 记调用次数） */
const registerPlugin = (over: Partial<Parameters<typeof registerSyncPlugin>[0]> = {}) => {
  const plugin = {
    id: 'test-sync',
    displayNameKey: 'sync.plugin.webdav.name' as MessageKey,
    version: '1.0.0',
    fields: [],
    pull: vi.fn(async () => [] as SyncSnapshot[]),
    ...over,
  }
  registerSyncPlugin(plugin)
  return plugin
}

/** playlistStore 里的歌单形状（成员是本机 trackId，不是引用） */
const storePlaylist = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `歌单 ${id}`,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  trackIds: [] as string[],
  ...over,
})

/** 假局域网桥：publish 次数是本组的核心观测点 */
const fakeBridge = () => ({
  status: vi.fn(async () => ({
    running: true,
    port: 45871,
    code: 'ABC-123',
    deviceId: 'dev-local',
    deviceName: '本机',
  })),
  setEnabled: vi.fn(async () => ({
    running: true,
    port: 45871,
    code: 'ABC-123',
    deviceId: 'dev-local',
    deviceName: '本机',
  })),
  rotateCode: vi.fn(async () => ({
    running: true,
    port: 45871,
    code: 'NEW-456',
    deviceId: 'dev-local',
    deviceName: '本机',
  })),
  discover: vi.fn(async () => []),
  publish: vi.fn(async () => {}),
  takeInbox: vi.fn(async () => [] as SyncSnapshot[]),
  pullPeer: vi.fn(async () => null),
  pushPeer: vi.fn(async () => {}),
})

describe('B-1：互推环的不动点', () => {
  it('内容没变时第二轮一次都不写对端（首轮必须写第一份）', async () => {
    const push = vi.fn(async () => {})
    registerPlugin({ pull: vi.fn(async () => []), push })
    const config = useSyncStore.getState().configs[0]!

    // 首轮：本会话还没有 lastPushedHash，必须写一次，否则第一份永远出不去
    await syncOnce(config)
    expect(push).toHaveBeenCalledTimes(1)

    // 第二轮：内容逐字节相同 → 0 次写（这就是互推环被切断的地方）
    await syncOnce(config)
    expect(push).toHaveBeenCalledTimes(1)

    // 本地真的改了 → 恰好写一次
    usePlaylistStore.setState({ playlists: [storePlaylist('pl-1')] })
    await syncOnce(config)
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('收件箱：内容未变的第二轮 0 次 publish（旧实现每收一份就推回去）', async () => {
    vi.useFakeTimers()
    try {
      const bridge = fakeBridge()
      mocks.platform.lanSync = bridge
      let deliver: (snapshots: SyncSnapshot[]) => void = () => {}
      mocks.platform.onLanSyncInbox = ((cb: (snapshots: SyncSnapshot[]) => void) => {
        deliver = cb
        return () => {}
      }) as typeof mocks.platform.onLanSyncInbox

      const push = vi.fn(async () => {})
      registerPlugin({ pull: vi.fn(async () => []), push })
      usePlaylistStore.setState({ playlists: [storePlaylist('pl-1')] })

      initPlaylistSync()
      await vi.advanceTimersByTimeAsync(0)
      // N-3：启动时主动消费一次收件箱（事件早于监听者到达的那批才不会丢）
      expect(bridge.takeInbox).toHaveBeenCalled()

      const mine = snapshotFromStores({ deviceId: 'dev-peer', deviceName: '对端' })
      // 假时钟下只推进 0ms：让 await 链（handleLanInbox → syncOnce → plugin.pull）跑完
      const inbox = async (snapshots: SyncSnapshot[]) => {
        deliver(snapshots)
        for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(0)
      }

      // 第一份：内容与本机完全一致 → 合并不改；随后那轮同步写第一份（首轮必写）
      await inbox([mine])
      const afterFirst = bridge.publish.mock.calls.length
      expect(afterFirst).toBe(1)

      // 第二份：一模一样 → 一次 publish 都不该多
      await inbox([mine])
      expect(bridge.publish.mock.calls.length).toBe(afterFirst)
      expect(push).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('对端只有旧内容时恰好回推一次，同一份再到达就不再回推（收敛）', async () => {
    vi.useFakeTimers()
    try {
      const bridge = fakeBridge()
      mocks.platform.lanSync = bridge
      let deliver: (snapshots: SyncSnapshot[]) => void = () => {}
      mocks.platform.onLanSyncInbox = ((cb: (snapshots: SyncSnapshot[]) => void) => {
        deliver = cb
        return () => {}
      }) as typeof mocks.platform.onLanSyncInbox

      registerPlugin({ pull: vi.fn(async () => []) })
      // 关掉自动同步：本组只想看「收件箱自己会不会回推」，别把同步轮的写混进来
      useSyncStore.setState({ configs: [configOf({ autoSync: false })] })

      const newest = Date.now() + 60_000
      usePlaylistStore.setState({
        playlists: [storePlaylist('pl-1', { name: '本地最新的名字', updatedAt: newest })],
      })
      initPlaylistSync()
      await vi.advanceTimersByTimeAsync(0)

      // 对端那份是旧内容：合并后应当是本机的，于是给对端回推一次
      const stale = snapshotOf([
        playlistOf({ id: 'pl-1', name: '旧名字', createdAt: 1, updatedAt: 1_700_000_000_000 }),
      ])
      const inbox = async (snapshots: SyncSnapshot[]) => {
        deliver(snapshots)
        for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(0)
      }

      await inbox([stale])
      expect(bridge.publish).toHaveBeenCalledTimes(1)

      // 冷却也早已过期；同一份旧内容再到达一次 → 我们刚推出去的就是它，回推没有信息量
      await vi.advanceTimersByTimeAsync(10_000)
      await inbox([stale])
      expect(bridge.publish).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('S-1：内容相同但远端时间戳更新时收敛', () => {
  it('采纳时间戳但不回推，第二轮 changed=false', async () => {
    const push = vi.fn(async () => {})
    const remoteUpdatedAt = Date.now() + 60_000
    const remote = snapshotOf([
      playlistOf({ id: 'pl-1', name: '长途飞行', updatedAt: remoteUpdatedAt, createdAt: 1 }),
    ])
    registerPlugin({ pull: vi.fn(async () => [remote]), push })
    const config = useSyncStore.getState().configs[0]!

    const first = await syncOnce(config)
    expect(first.changed).toBe(true)
    // 时间戳被采纳：否则每轮合并都会报 changed，永远在写对端
    expect(usePlaylistStore.getState().playlists[0]?.updatedAt).toBe(remoteUpdatedAt)

    const second = await syncOnce(config)
    expect(second.changed).toBe(false)
    expect(push).toHaveBeenCalledTimes(1)
  })
})

describe('S-6：口令脱敏不看长度', () => {
  it('三字符口令也会被抹掉', async () => {
    const secret = 'z9q'
    mocks.platform.sync.getCredential.mockResolvedValue({ password: secret })
    registerPlugin({
      pull: vi.fn(async () => {
        throw new Error(`401 unauthorized (password=${secret})`)
      }),
    })

    const outcome = await syncOnce(useSyncStore.getState().configs[0]!)

    expect(outcome.ok).toBe(false)
    const lastError = useSyncStore.getState().runtime['cfg-1']?.lastError ?? ''
    expect(lastError).not.toContain(secret)
    expect(lastError).toContain('***')
  })
})

describe('S-3：配对码不进 settings（localStorage）', () => {
  it('落盘迁移把 settings.code 剥出来排队交给凭证网关', () => {
    const migrated = migratePersistedSyncState({
      configs: [
        {
          id: 'cfg-lan',
          pluginId: 'lan-sync',
          name: '书房 Mac',
          settings: { host: '192.168.1.20', port: 45871, code: 'PAIR123' },
          direction: 'bidirectional',
          autoSync: true,
          enabled: true,
        },
      ],
    })

    expect(migrated.configs[0]?.settings).toEqual({ host: '192.168.1.20', port: 45871 })
    expect(migrated.configs[0]?.settings).not.toHaveProperty('code')
    // 剥出来的值不能被静默丢掉：进待迁移队列，由凭证网关接手
    expect(takePendingSecretMigrations()).toEqual([{ configId: 'cfg-lan', secrets: { code: 'PAIR123' } }])
  })

  it('addConfig/updateConfig 拒绝把秘密字段写进 store', () => {
    useSyncStore.getState().addConfig(
      configOf({
        id: 'cfg-secret',
        settings: { host: '192.168.1.21', code: 'PAIR456', password: 'pw' },
      })
    )
    const stored = useSyncStore.getState().configs.find((c) => c.id === 'cfg-secret')!
    expect(stored.settings).toEqual({ host: '192.168.1.21' })

    useSyncStore.getState().updateConfig('cfg-secret', { settings: { host: 'x', code: 'PAIR789' } })
    const updated = useSyncStore.getState().configs.find((c) => c.id === 'cfg-secret')!
    expect(updated.settings).toEqual({ host: 'x' })
  })
})

describe('N-2：占位曲目 id 的哈希宽度', () => {
  it('64 位（14 个 base36 字符），相近引用不会撞成同一个 id', () => {
    const id = syncPlaceholderId(metaRef())
    expect(id.startsWith('sync:')).toBe(true)
    expect(id.slice('sync:'.length)).toHaveLength(14)

    const a = syncPlaceholderId(metaRef({ onlineId: 'aaa' }))
    const b = syncPlaceholderId(metaRef({ onlineId: 'aab' }))
    expect(a).not.toBe(b)
  })
})

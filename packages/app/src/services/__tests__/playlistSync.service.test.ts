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
import { clearSyncPluginsForTest, likeKeyOf, registerSyncPlugin, snapshotContentHash } from '@aurora/shared'
import type { MessageKey, SyncConfig, SyncSnapshot, SyncedLike, SyncTrackRef } from '@aurora/shared'
import type { Track } from '@/types'
import { usePlaylistStore } from '@/stores/playlistStore'
import {
  migratePersistedSyncState,
  takePendingSecretMigrations,
  useSyncStore,
} from '@/stores/syncStore'
import {
  applySyncedLikes,
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
  // 收藏同步（§5.1）用到的状态与动作：默认是「空库 + 空收藏」，具体用例按需替换
  library: {
    tracks: [] as Track[],
    librarySources: [] as unknown[],
    likedTracks: new Set<string>(),
    likeRecords: {} as Record<string, SyncedLike>,
    setLiked: (_trackId: string, _liked: boolean) => {},
    applyLikeRecords: (_records: Record<string, SyncedLike>) => {},
  },
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
  useLibraryStore: { getState: () => mocks.library, subscribe: () => () => {} },
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
  mocks.library.likedTracks = new Set<string>()
  mocks.library.likeRecords = {}
  mocks.library.setLiked = (_trackId: string, _liked: boolean) => {}
  mocks.library.applyLikeRecords = (_records: Record<string, SyncedLike>) => {}
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

describe('收件箱落盘：收藏与歌单在同一轮写回', () => {
  it('autoSync 关闭时，对端推来的收藏仍然当场落盘（不再等随后的 syncOnce 补）', async () => {
    vi.useFakeTimers()
    try {
      const bridge = fakeBridge()
      mocks.platform.lanSync = bridge
      let deliver: (snapshots: SyncSnapshot[]) => void = () => {}
      mocks.platform.onLanSyncInbox = ((cb: (snapshots: SyncSnapshot[]) => void) => {
        deliver = cb
        return () => {}
      }) as typeof mocks.platform.onLanSyncInbox

      // 把「补写」那轮同步彻底关掉：模拟 pushOnly / pull 不可用 / 用户没开自动同步。
      // 旧实现只 applySyncedPlaylists，收藏要等收件箱触发的那轮 syncOnce 才落盘，
      // 这个场景下那轮不会跑 → 收藏永远不生效。
      useSyncStore.setState({ configs: [configOf({ autoSync: false })] })
      const applyLikeRecords = vi.fn()
      mocks.library.applyLikeRecords = applyLikeRecords

      initPlaylistSync()
      await vi.advanceTimersByTimeAsync(0)

      const ref = metaRef({ title: '远端的歌', artist: '对端', duration: 201 })
      deliver([snapshotOf([], { likes: [{ id: likeKeyOf(ref), likedAt: 500, ref }] })])
      for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(0)

      expect(applyLikeRecords).toHaveBeenCalled()
      const records = applyLikeRecords.mock.calls.at(-1)?.[0] as Record<string, SyncedLike>
      expect(records[likeKeyOf(ref)]).toMatchObject({ likedAt: 500 })
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

/* ------------------------------------------------------------------ *
 * 收藏（§5.1）：采集与落盘
 * ------------------------------------------------------------------ */

/**
 * 把 mock 库接成「真的会变」的状态机：`setLiked` 改 `likedTracks`、`applyLikeRecords`
 * 落盘记录。收藏同步的正确性全在「谁的时刻更晚」上，用 no-op 桩测不出来。
 */
function wireLikeState(): { calls: Array<[string, boolean]>; saved: () => Record<string, SyncedLike> } {
  const calls: Array<[string, boolean]> = []
  let records: Record<string, SyncedLike> = {}
  mocks.library.setLiked = (trackId: string, liked: boolean) => {
    calls.push([trackId, liked])
    const next = new Set(mocks.library.likedTracks)
    if (liked) next.add(trackId)
    else next.delete(trackId)
    mocks.library.likedTracks = next
  }
  mocks.library.applyLikeRecords = (next: Record<string, SyncedLike>) => {
    records = next
    mocks.library.likeRecords = next
  }
  return { calls, saved: () => records }
}

const likedRef = (over: Partial<Track> = {}): SyncTrackRef => localRef(over)

describe('snapshotFromStores：收藏采集', () => {
  it('收藏的曲目进快照；有记录的沿用记录里的时刻，历史收藏（无记录）时刻算 0', () => {
    const first = track({ id: 'liked-1', path: '/m/甲.flac', title: '甲' })
    const second = track({ id: 'liked-2', path: '/m/乙.flac', title: '乙' })
    mocks.library.tracks = [first, second]
    mocks.library.likedTracks = new Set(['liked-1', 'liked-2'])
    const refOfFirst = likedRef({ path: '/m/甲.flac', title: '甲' })
    mocks.library.likeRecords = {
      [likeKeyOf(refOfFirst)]: { id: likeKeyOf(refOfFirst), likedAt: 1_234, ref: refOfFirst },
    }

    const snapshot = snapshotFromStores({ deviceId: 'dev-local', deviceName: '本机' })

    expect(snapshot.likes).toHaveLength(2)
    const byTitle = new Map((snapshot.likes ?? []).map((entry) => [entry.ref.title, entry]))
    expect(byTitle.get('甲')?.likedAt).toBe(1_234)
    // 「收藏参与同步」之前就存在的收藏：时刻无从得知，按 0 算（见 collectSnapshotLikes）
    expect(byTitle.get('乙')?.likedAt).toBe(0)
  })

  it('取消收藏的墓碑进快照；过期的被清掉（否则过期取消会长期压制对端的重新收藏）', () => {
    const now = Date.now()
    const fresh = likedRef({ path: '/m/刚取消.flac', title: '刚取消' })
    const stale = likedRef({ path: '/m/很久前取消.flac', title: '很久前取消' })
    mocks.library.tracks = []
    mocks.library.likedTracks = new Set()
    mocks.library.likeRecords = {
      [likeKeyOf(fresh)]: { id: likeKeyOf(fresh), likedAt: 1, removedAt: now - 1_000, ref: fresh },
      [likeKeyOf(stale)]: {
        id: likeKeyOf(stale),
        likedAt: 1,
        removedAt: now - TTL_MS - 1,
        ref: stale,
      },
    }

    const snapshot = snapshotFromStores({ deviceId: 'dev-local', deviceName: '本机' })

    expect((snapshot.likes ?? []).map((entry) => entry.ref.title)).toEqual(['刚取消'])
    expect(snapshot.likes?.[0]?.removedAt).toBe(now - 1_000)
  })

  it('曲目已不在本机的「已收藏」记录照样带出去（删掉文件不等于不喜欢）', () => {
    const gone = likedRef({ path: '/m/已删除.flac', title: '已删除' })
    mocks.library.tracks = []
    mocks.library.likedTracks = new Set()
    mocks.library.likeRecords = { [likeKeyOf(gone)]: { id: likeKeyOf(gone), likedAt: 777, ref: gone } }

    const snapshot = snapshotFromStores({ deviceId: 'dev-local', deviceName: '本机' })

    expect(snapshot.likes).toHaveLength(1)
    expect(snapshot.likes?.[0]?.likedAt).toBe(777)
  })
})

describe('applySyncedLikes：收藏落盘', () => {
  it('解析到本机曲目：设为已收藏，并把合并结果整体落盘', () => {
    mocks.library.tracks = [track()]
    const { calls, saved } = wireLikeState()
    const ref = likedRef()

    const outcome = applySyncedLikes(
      snapshotOf([], { likes: [{ id: likeKeyOf(ref), likedAt: 500, ref }] })
    )

    expect(calls).toEqual([['track-local-1', true]])
    expect(outcome).toMatchObject({ liked: 1, unliked: 0, records: 1 })
    expect(Object.keys(saved())).toEqual([likeKeyOf(ref)])
  })

  it('取消收藏的墓碑：本机原来是收藏的 → 设回未收藏', () => {
    mocks.library.tracks = [track()]
    mocks.library.likedTracks = new Set(['track-local-1'])
    const { calls } = wireLikeState()
    const ref = likedRef()

    // 墓碑时刻要落在 TTL 内，否则会按「过期取消」被丢弃（那是另一条用例的口径）
    const removedAt = Date.now() - 1_000
    const outcome = applySyncedLikes(
      snapshotOf([], {
        likes: [{ id: likeKeyOf(ref), likedAt: removedAt - 1_000, removedAt, ref }],
      })
    )

    expect(calls).toEqual([['track-local-1', false]])
    expect(outcome).toMatchObject({ liked: 0, unliked: 1 })
  })

  it('本机没有这首歌：只留记录，不造占位曲目（收藏页不展示占位，造了也没人看得见）', () => {
    mocks.library.tracks = []
    const { calls } = wireLikeState()
    const ref = metaRef()

    const outcome = applySyncedLikes(
      snapshotOf([], { likes: [{ id: likeKeyOf(ref), likedAt: 500, ref }] })
    )

    expect(calls).toEqual([])
    expect(outcome).toMatchObject({ liked: 0, unliked: 0, records: 1 })
    expect(usePlaylistStore.getState().importedTracks).toEqual({})
  })

  it('状态没变的记录不重复写（幂等 setLiked 不该被调用）', () => {
    mocks.library.tracks = [track()]
    mocks.library.likedTracks = new Set(['track-local-1'])
    const { calls } = wireLikeState()
    const ref = likedRef()

    applySyncedLikes(snapshotOf([], { likes: [{ id: likeKeyOf(ref), likedAt: 500, ref }] }))

    expect(calls).toEqual([])
  })

  it('应用后再采集，收藏部分的内容哈希与合并结果一致（一轮收敛）', () => {
    mocks.library.tracks = [track()]
    wireLikeState()
    const ref = likedRef()
    const merged = snapshotOf([], { likes: [{ id: likeKeyOf(ref), likedAt: 500, ref }] })

    applySyncedLikes(merged)
    const mine = snapshotFromStores({ deviceId: 'dev-local', deviceName: '本机' })

    expect(snapshotContentHash(mine)).toBe(snapshotContentHash({ ...merged, playlists: mine.playlists }))
  })
})

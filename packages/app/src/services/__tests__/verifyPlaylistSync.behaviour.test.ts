/**
 * 对抗性验证（verifier 任务 task-4）用的**临时证据测试**，不属于实现方交付。
 *
 * 覆盖的是「实现方自测没测的破坏性/循环性风险」：
 *  1) 内容相同但 `updatedAt` 落后的歌单会不会被采纳远端时间戳（不采纳 → 每轮 changed=true）；
 *  2) `applySyncedPlaylists` 会不会删掉快照里没有的本地歌单；
 *  3) 占位曲目重复登记 / 播放统计被覆盖；
 *  4) 失败后串行锁与 runtime 状态能否回到可用；
 *  5) 少于 4 个字符的口令在 lastError 里是否漏出；
 *  6) `lan:inbox` 处理是否无条件再 publish（与对端 push 组合成互推环的驱动条件）。
 *
 * 第一轮（task-4）里用来固化缺陷的 `it.fails` 已全部转成常规断言：本文件现在是
 * **复验（task-9）**的证据，每条都断言契约要求的行为（修复后应绿）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSyncPluginsForTest, registerSyncPlugin } from '@aurora/shared'
import type { MessageKey, SyncConfig, SyncSnapshot, SyncTrackRef } from '@aurora/shared'
import type { Track } from '@/types'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useSyncStore } from '@/stores/syncStore'
import { migratePersistedSyncState } from '@/stores/syncStore'
import {
  applySyncedPlaylists,
  initPlaylistSync,
  disposePlaylistSync,
  resetPlaylistSyncForTest,
  snapshotFromStores,
  syncOnce,
  syncPlaceholderId,
} from '../playlistSync.service'

const mocks = vi.hoisted(() => ({
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

const metaRef = (over: Partial<Track> = {}): SyncTrackRef => {
  const t = track(over)
  return {
    kind: 'meta',
    platform: 'aurora',
    onlineId: 'online-1',
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
  }
}

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
  createdAt: 1,
  updatedAt: 100,
  tracks: [] as SyncTrackRef[],
  ...over,
})

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

const register = (over: Partial<Parameters<typeof registerSyncPlugin>[0]> = {}) => {
  const plugin = {
    id: 'test-sync',
    displayNameKey: 'sync.plugin.webdav.name' as MessageKey,
    version: '1.0.0',
    fields: [],
    pull: vi.fn(async () => [] as SyncSnapshot[]),
    push: vi.fn(async () => {}),
    ...over,
  }
  registerSyncPlugin(plugin as Parameters<typeof registerSyncPlugin>[0])
  return plugin
}

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
  mocks.platform.lanSync = null
  mocks.platform.onLanSyncInbox = undefined
  mocks.platform.sync.device.mockClear()
  mocks.platform.sync.getCredential.mockClear()
  mocks.platform.sync.getCredential.mockResolvedValue({})
  useSyncStore.getState().addConfig(configOf())
})

describe('收敛性：本地时间戳是否会被远端推进', () => {
  // 修复后（task-8 S-1）：内容相同但远端时间戳更新 → 只采纳时间戳，不当作内容更新。
  it('内容相同但 updatedAt 落后时采纳远端时间戳，且不算内容更新', () => {
    usePlaylistStore.setState({
      playlists: [{ id: 'pl-1', name: '长途飞行', createdAt: 1, updatedAt: 100, trackIds: [] }],
    })
    const remote = snapshotOf([playlistOf({ name: '长途飞行', updatedAt: 500 })])

    const outcome = applySyncedPlaylists(remote)

    // 只改时间戳，成员/名称都没动 → 不计入 updated（那是内容变更的计数）
    expect(outcome.updated).toBe(0)
    expect(usePlaylistStore.getState().playlists[0]?.updatedAt).toBe(500)
  })

  it('连续两轮同步：时间戳被采纳后第二轮 changed=false（不再每轮都判变更）', async () => {
    usePlaylistStore.setState({
      playlists: [{ id: 'pl-1', name: '长途飞行', createdAt: 1, updatedAt: 100, trackIds: [] }],
    })
    register({ pull: vi.fn(async () => [snapshotOf([playlistOf({ name: '长途飞行', updatedAt: 500 })])]) })

    const first = await syncOnce(useSyncStore.getState().configs[0]!)
    const second = await syncOnce(useSyncStore.getState().configs[0]!)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(usePlaylistStore.getState().playlists[0]?.updatedAt).toBe(500)
  })
})

describe('隐私：快照字段白名单', () => {
  it('序列化结果不含播放统计 / 喜欢 / 音源凭证 / 音频地址', () => {
    mocks.library.tracks = [
      { ...track({ playCount: 9, liked: true }), lastPlayedAt: 1234, sourceId: 'sid-1' } as Track,
    ]
    usePlaylistStore.setState({
      playlists: [
        { id: 'pl-1', name: '长途飞行', createdAt: 1, updatedAt: 2, trackIds: ['track-local-1'] },
      ],
    })

    const text = JSON.stringify(snapshotFromStores({ deviceId: 'dev-local', deviceName: '本机' }))

    expect(text).not.toContain('playCount')
    expect(text).not.toContain('liked')
    expect(text).not.toContain('lastPlayedAt')
    expect(text).not.toContain('sourceId')
    expect(text).not.toContain('http')
  })
})

describe('破坏性风险：删除与占位登记', () => {
  it('快照里没有的本地歌单不会被删（只有墓碑才删）', () => {
    usePlaylistStore.setState({
      playlists: [
        { id: 'pl-1', name: '本机独有', createdAt: 1, updatedAt: 1, trackIds: [] },
        { id: 'pl-2', name: '两边都有', createdAt: 2, updatedAt: 2, trackIds: [] },
      ],
    })

    const outcome = applySyncedPlaylists(snapshotOf([playlistOf({ id: 'pl-2', updatedAt: 90 })]))

    expect(usePlaylistStore.getState().playlists.map((p) => p.id).sort()).toEqual(['pl-1', 'pl-2'])
    expect(outcome.removed).toBe(0)
  })

  it('同一份快照应用两次不会重复登记占位曲目', () => {
    const ref = metaRef()
    const snapshot = snapshotOf([playlistOf({ tracks: [ref] })])
    const id = syncPlaceholderId(ref)

    const first = applySyncedPlaylists(snapshot)
    const second = applySyncedPlaylists(snapshot)

    expect(first.placeholders).toBe(1)
    expect(second.placeholders).toBe(0)
    expect(Object.keys(usePlaylistStore.getState().importedTracks)).toEqual([id])
    expect(usePlaylistStore.getState().playlists[0]?.trackIds).toEqual([id])
  })
})

describe('串行锁与状态机', () => {
  it('失败后锁释放、runtime 状态能回到 ok（不会永久 running）', async () => {
    let fail = true
    const plugin = register({
      pull: vi.fn(async () => {
        if (fail) throw new Error('boom')
        return [] as SyncSnapshot[]
      }),
    })
    const config = useSyncStore.getState().configs[0]!

    const failed = await syncOnce(config)
    expect(failed.ok).toBe(false)
    expect(useSyncStore.getState().runtime['cfg-1']?.state).toBe('failed')

    fail = false
    const ok = await syncOnce(config)
    expect(ok.ok).toBe(true)
    expect(useSyncStore.getState().runtime['cfg-1']?.state).toBe('ok')
    expect(plugin.pull).toHaveBeenCalledTimes(2)
  })
})

describe('口令脱敏', () => {
  // 修复后（task-8 S-6）：脱敏不再按长度设阈值，3 个字符的口令同样要抹。
  it('短于 4 个字符的口令也不应出现在 lastError 里', async () => {
    const secret = 'abc'
    mocks.platform.sync.getCredential.mockResolvedValue({ password: secret })
    register({
      pull: vi.fn(async () => {
        throw new Error(`bad password ${secret}`)
      }),
    })

    await syncOnce(useSyncStore.getState().configs[0]!)

    const lastError = useSyncStore.getState().runtime['cfg-1']?.lastError ?? ''
    expect(lastError).not.toContain(secret)
  })
})

describe('局域网互推环的驱动条件', () => {
  it('changed=false 时仍然 push（每轮都写对端）', async () => {
    const plugin = register({
      pull: vi.fn(async () => [snapshotOf([], { deviceId: 'dev-remote' })]),
    })

    await syncOnce(useSyncStore.getState().configs[0]!)

    expect(plugin.push).toHaveBeenCalledTimes(1)
  })

  // 修复后（task-8 B-1）：收件箱只在「合并结果带来了对端还没有的内容」时才回推一次，
  // 同一份内容再到达不会继续放大 —— 两台互指的机器停在不动点上。
  it('lan:inbox 收到「没有变化」的快照不再回推（首轮写一次即收敛）', async () => {
    const publish = vi.fn(async () => {})
    mocks.platform.lanSync = {
      status: vi.fn(async () => ({
        running: true,
        port: 45871,
        code: 'ABCDEFGHJK',
        deviceId: 'dev-local',
        deviceName: '本机',
      })),
      setEnabled: vi.fn(),
      rotateCode: vi.fn(),
      discover: vi.fn(async () => []),
      publish,
      takeInbox: vi.fn(async () => []),
      pullPeer: vi.fn(async () => [] as SyncSnapshot[]),
      pushPeer: vi.fn(async () => {}),
    }
    const plugin = register()
    let inbox: ((snapshots: SyncSnapshot[]) => void) | undefined
    mocks.platform.onLanSyncInbox = (callback) => {
      inbox = callback
      return () => {}
    }
    initPlaylistSync()
    expect(inbox).toBeTypeOf('function')

    // 与本地完全一致的空歌单快照：merge 后 changed=false，也没有对端缺的内容 → 不回推
    inbox?.([snapshotOf([])])
    // 收件箱之后那一轮自动同步仍会写第一份（首轮必写），除此之外不再有 publish
    await vi.waitFor(() => expect(plugin.pull).toHaveBeenCalled())
    expect(publish.mock.calls.length).toBe(1)

    // 同一份内容再到达：publish 不增长（旧实现这里会一路放大）。
    // 这一轮连 pull 都不会再跑 —— 收件箱触发的自动同步有 5s 冷却。
    inbox?.([snapshotOf([])])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(publish.mock.calls.length).toBe(1)
    expect(plugin.pull).toHaveBeenCalledTimes(1)
  })
})

describe('B-2 接缝与 S-3 秘密字段（复验补充）', () => {
  it('addConfig / updateConfig 落盘前剥掉 settings 里的秘密字段', () => {
    useSyncStore.getState().addConfig(
      configOf({ id: 'cfg-secret', settings: { host: 'nas.local', port: 45871, code: 'ABCDEFGHJK' } })
    )
    expect(useSyncStore.getState().configs.find((c) => c.id === 'cfg-secret')?.settings).toEqual({
      host: 'nas.local',
      port: 45871,
    })

    useSyncStore.getState().updateConfig('cfg-secret', {
      settings: { host: 'nas.local', port: 45872, code: 'ZZZZZZZZZZ', password: 'pw' },
    })
    expect(useSyncStore.getState().configs.find((c) => c.id === 'cfg-secret')?.settings).toEqual({
      host: 'nas.local',
      port: 45872,
    })
  })

  it('历史配置的 settings.code 在迁移时被剥离，并在引擎启动时交给凭证网关', async () => {
    const migrated = migratePersistedSyncState({
      configs: [
        {
          id: 'cfg-old',
          pluginId: 'lan-sync',
          name: '老配置',
          settings: { host: '192.168.1.9', port: 45871, code: 'ABCDEFGHJK' },
          direction: 'bidirectional',
          autoSync: true,
          enabled: true,
        },
      ],
    })
    expect(migrated.configs[0]?.settings).toEqual({ host: '192.168.1.9', port: 45871 })

    mocks.platform.lanSync = null
    initPlaylistSync()
    await vi.waitFor(() =>
      expect(mocks.platform.sync.saveCredential).toHaveBeenCalledWith('cfg-old', { code: 'ABCDEFGHJK' })
    )
    disposePlaylistSync()
  })
})

/**
 * 对抗性复验（task-9，B-1）的**双设备收敛证据**。
 *
 * 为什么不在单例引擎上模拟：互推环的两端是**两台设备各自的引擎实例**，它们的
 * 「上次推出去的内容哈希」「收件箱触发冷却」「本地歌单」互不相干。用一个模块实例
 * 交替改 store 只能证明「单侧不动点」，证不了「A→B→A 的往返会停」。
 *
 * 这里用 `vi.resetModules()` 给每台设备各自一份**独立模块图**（独立的
 * `playlistSync.service` 单例状态 + 独立的 zustand store + 独立的 shared 同步注册表），
 * 再用一个假 `LanSyncBridge` 把 `publish`/`pushPeer` 投递到对端的 `lan:inbox` 回调，
 * `pullPeer` 读对端当前快照 —— 等价于真实链路里「HTTP PUT → 主进程收件箱 → 事件 → 引擎」。
 *
 * 断言的是协议层性质，不是实现细节：
 *  - 往返轮数有界（10 轮内队列排空）；
 *  - 排空后两台设备的 `snapshotContentHash` 相等（内容一致）；
 *  - publish 调用次数收敛（各自最多一次「首轮必写」，之后不再增长）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  library: {
    tracks: [] as unknown[],
    librarySources: [] as unknown[],
    likedTracks: new Set<string>(),
    // 只有歌单参与本文件的两台设备往返；收藏记录留空即可（形状与 store 对齐）
    likeRecords: {} as Record<string, unknown>,
    setLiked: (_trackId: string, _liked: boolean) => {},
    applyLikeRecords: (_records: Record<string, unknown>) => {},
  },
  device: { deviceId: 'dev-a', deviceName: '设备 A' },
  credentials: { code: 'ABCDEFGHJK' } as Record<string, string>,
  platform: {
    supportsPlaylistSync: true,
    lanSync: null as unknown,
    syncFetch: undefined as unknown,
    onLanSyncInbox: undefined as
      | undefined
      | ((callback: (snapshots: unknown[]) => void) => () => void),
    sync: {
      device: vi.fn(async () => mocks.device),
      getCredential: vi.fn(async () => mocks.credentials),
      saveCredential: vi.fn(async () => ({ ok: true, saved: true, encryptionAvailable: true })),
      credentialState: vi.fn(async () => ({ saved: true, encryptionAvailable: true })),
      clearCredential: vi.fn(async () => ({ ok: true, saved: false, encryptionAvailable: true })),
    },
  },
}))

vi.mock('@/services/platform', () => ({ platform: mocks.platform }))
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: { getState: () => mocks.library, subscribe: () => () => {} },
}))

type PlaylistRow = { id: string; name: string; createdAt: number; updatedAt: number; trackIds: string[] }

interface Device {
  id: 'a' | 'b'
  svc: typeof import('../playlistSync.service')
  playlists: typeof import('@/stores/playlistStore')['usePlaylistStore']
  syncs: typeof import('@/stores/syncStore')['useSyncStore']
  shared: typeof import('@aurora/shared')
  device: { deviceId: string; deviceName: string }
  bridge: { pullPeer: ReturnType<typeof vi.fn>; pushPeer: ReturnType<typeof vi.fn> }
  counters: { publish: number; push: number }
  bus: { toPeer: unknown[] }
  inbox: (snapshots: unknown[]) => void
  snapshot: () => unknown
}

const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 载入一台「设备」：一份全新的模块图 + 一份假桥。
 *
 * `bus.toPeer` 是这个假桥的投递队列（真实链路里是「HTTP PUT 到对端 → 对端收件箱」）。
 * `deliver` 由测试在两端都载入后接上：投递时直接叫对端的收件箱处理器。
 */
async function loadDevice(id: 'a' | 'b', deliver: () => void): Promise<Device> {
  vi.resetModules()
  const device =
    id === 'a' ? { deviceId: 'dev-a', deviceName: '设备 A' } : { deviceId: 'dev-b', deviceName: '设备 B' }
  mocks.device = device

  const counters = { publish: 0, push: 0 }
  const bus = { toPeer: [] as unknown[] }
  const bridge = {
    status: vi.fn(async () => ({
      running: true,
      port: id === 'a' ? 45871 : 45872,
      code: 'ABCDEFGHJK',
      deviceId: device.deviceId,
      deviceName: device.deviceName,
    })),
    setEnabled: vi.fn(async () => {}),
    rotateCode: vi.fn(async () => ({ code: 'ABCDEFGHJK', changedAt: 1 })),
    discover: vi.fn(async () => []),
    publish: vi.fn(async (snapshot: unknown) => {
      counters.publish += 1
      bus.toPeer.push(snapshot)
      deliver()
    }),
    takeInbox: vi.fn(async () => [] as unknown[]),
    // 对端当前快照在测试外层注入（见各测试的 mockImplementation）
    pullPeer: vi.fn(async () => [] as unknown[]),
    pushPeer: vi.fn(async (_target: unknown, snapshot: unknown) => {
      counters.push += 1
      bus.toPeer.push(snapshot)
      deliver()
    }),
  }

  let inboxHandler: (snapshots: unknown[]) => void = () => {}
  mocks.platform.lanSync = bridge
  mocks.platform.onLanSyncInbox = (callback) => {
    inboxHandler = callback
    return () => {}
  }

  const svc = await import('../playlistSync.service')
  const playlists = await import('@/stores/playlistStore')
  const syncs = await import('@/stores/syncStore')
  const shared = await import('@aurora/shared')

  playlists.usePlaylistStore.setState({
    playlists: [],
    currentPlaylistId: null,
    importedTracks: {},
    syncTombstones: {},
  })
  syncs.useSyncStore.setState({
    configs: [
      {
        id: `cfg-${id}`,
        pluginId: 'lan-sync',
        name: `到 ${id === 'a' ? 'B' : 'A'}`,
        settings: { host: '127.0.0.1', port: 45871 },
        direction: 'bidirectional',
        autoSync: true,
        enabled: true,
      },
    ],
    runtime: {},
    device: null,
    lan: { status: null, peers: [], scanning: false },
  })

  // init 里 `void ensureDevice()` 是异步的：等它落进本设备的 deviceCache 再切下一台
  svc.initPlaylistSync()
  await flush()

  return {
    id,
    svc,
    playlists: playlists.usePlaylistStore,
    syncs: syncs.useSyncStore,
    shared,
    device,
    bridge: bridge as unknown as Device['bridge'],
    counters,
    bus,
    inbox: (snapshots) => inboxHandler(snapshots),
    snapshot: () => svc.snapshotFromStores(device),
  }
}

describe('B-1 复验：两台设备的互推环会收敛到不动点', () => {
  beforeEach(() => {
    mocks.library.tracks = []
    mocks.library.librarySources = []
    mocks.credentials = { code: 'ABCDEFGHJK' }
  })

  it('A 新建歌单 → A↔B 往返若干轮后内容一致、publish 收敛到 0', async () => {
    // deliver 在两端都载入后接上：假桥投递 → 对端收件箱处理器（真实链路里是 IPC 事件）
    let deliverA: () => void = () => {}
    let deliverB: () => void = () => {}
    const A = await loadDevice('a', () => deliverA())
    const B = await loadDevice('b', () => deliverB())

    // 两台设备各自有同一份歌单（内容与时间戳都相同）
    const shared0: PlaylistRow = { id: 'pl-0', name: '共享歌单', createdAt: 10, updatedAt: 100, trackIds: [] }
    A.playlists.setState({ playlists: [{ ...shared0 }] })
    B.playlists.setState({ playlists: [{ ...shared0 }] })

    // 互相读对端快照（等价于 GET /v1/snapshot）
    A.bridge.pullPeer.mockImplementation(async () => [B.snapshot()])
    B.bridge.pullPeer.mockImplementation(async () => [A.snapshot()])

    deliverA = () => {
      if (A.bus.toPeer.length === 0) return
      const payload = A.bus.toPeer.splice(0, A.bus.toPeer.length)
      B.inbox(payload)
    }
    deliverB = () => {
      if (B.bus.toPeer.length === 0) return
      const payload = B.bus.toPeer.splice(0, B.bus.toPeer.length)
      A.inbox(payload)
    }

    // A 上新建一份歌单（用户操作），随后触发一轮同步
    A.playlists.setState({
      playlists: [
        { ...shared0 },
        { id: 'pl-1', name: 'A 新建', createdAt: 20, updatedAt: 200, trackIds: [] },
      ],
    })
    await A.svc.syncAllNow()
    await flush()

    // 场景有效性：A 的这轮同步确实往对端写了东西（否则下面的收敛断言是空转）
    expect(A.counters.publish + A.counters.push).toBeGreaterThan(0)

    // 往返排空：每轮把两端队列互投，直到没有新快照或到达上限
    let rounds = 0
    let publishesInLastRound = -1
    for (; rounds < 10; rounds++) {
      const before = A.counters.publish + B.counters.publish
      deliverA()
      deliverB()
      await flush()
      const after = A.counters.publish + B.counters.publish
      publishesInLastRound = after - before
      const queued = A.bus.toPeer.length + B.bus.toPeer.length
      if (publishesInLastRound === 0 && queued === 0) break
    }

    const snapA = A.snapshot() as Parameters<typeof A.shared.snapshotContentHash>[0]
    const snapB = B.snapshot() as Parameters<typeof B.shared.snapshotContentHash>[0]

    // 1) 轮数有界（旧实现会一直互推，循环跑满上限）
    expect(rounds).toBeLessThan(10)
    // 2) 内容一致：两台设备（两份模块图）用同一份纯函数算哈希，必须相等
    expect(A.shared.snapshotContentHash(snapA)).toBe(B.shared.snapshotContentHash(snapB))
    // 3) 收敛后不再 publish
    expect(publishesInLastRound).toBe(0)
    // 4) 首次写入次数有界：每台设备最多一次「首轮必写」，之后靠 hash 门控停下
    expect(A.counters.publish).toBeLessThanOrEqual(1)
    expect(B.counters.publish).toBeLessThanOrEqual(1)
    // 5) 两端歌单集合一致，且 A 的新歌单确实传播过去了
    const idsA = A.playlists.getState().playlists.map((p) => p.id).sort()
    const idsB = B.playlists.getState().playlists.map((p) => p.id).sort()
    expect(idsA).toEqual(['pl-0', 'pl-1'])
    expect(idsB).toEqual(idsA)

    // 6) 手动再触发一轮：内容没变 → 一次都不再写（不动点，不依赖冷却计时器）
    const beforeManual = A.counters.publish + A.counters.push + B.counters.publish + B.counters.push
    await A.svc.syncAllNow()
    await B.svc.syncAllNow()
    await flush()
    const afterManual = A.counters.publish + A.counters.push + B.counters.publish + B.counters.push
    expect(afterManual).toBe(beforeManual)

    A.svc.disposePlaylistSync()
    B.svc.disposePlaylistSync()
  })
})

/**
 * 一键配对（`docs/playlist-sync.md` §16）在**渲染层**的编排测试。
 *
 * 密码学与状态机在两个宿主的桥里（桌面主进程 / Android 原生插件），各自的测试
 * 钉各自的实现。这一层要钉的是「配对成功之后到底发生了什么」，因为这里错了比
 * 配对失败更难发现：
 *  1) **码先落、配置后进 store**：顺序反了会出现「卡片在、立即同步必失败」；
 *  2) 两端都建配置（发起方在 `pairWithLanPeer`，应答方在 `completeLanPairing`）；
 *  3) 失败原因原样透传（UI 靠枚举查 i18n，不做字符串匹配）；
 *  4) 建配置失败（码已过期/被取走）必须回 `auth`，不能悄悄留下一条没凭据的配置。
 *
 * 全部打桩：不碰真实网络、不写磁盘、不读真实用户目录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LAN_SYNC_PLUGIN_ID, lanSyncPlugin, registerSyncPlugin, setLanSyncBridge } from '@aurora/shared'
import type { LanPairPeer, LanPairStartResult, LanPeerInfo, SyncSnapshot } from '@aurora/shared'
import { usePlaylistStore } from '@/stores/playlistStore'
import { useSyncStore } from '@/stores/syncStore'
import {
  completeLanPairing,
  pairWithLanPeer,
  resetPlaylistSyncForTest,
  respondLanPairRequest,
} from '../playlistSync.service'

const mocks = vi.hoisted(() => ({
  platform: {
    supportsPlaylistSync: true,
    lanSync: null as unknown,
    sync: {
      device: vi.fn(async () => ({ deviceId: 'dev-local', deviceName: '本机' })),
      getCredential: vi.fn(async () => ({ code: '23456789AB' }) as Record<string, string>),
      saveCredential: vi.fn(async () => ({ ok: true, saved: true, encryptionAvailable: true })),
      credentialState: vi.fn(async () => ({ saved: true, encryptionAvailable: true })),
      clearCredential: vi.fn(async () => ({ ok: true, saved: false, encryptionAvailable: true })),
    },
  },
  library: {
    tracks: [] as unknown[],
    librarySources: [] as unknown[],
    likedTracks: new Set<string>(),
    likeRecords: {} as Record<string, unknown>,
    setLiked: (_trackId: string, _liked: boolean) => {},
    applyLikeRecords: (_records: Record<string, unknown>) => {},
  },
  onLanSyncInbox: undefined as
    | undefined
    | ((callback: (snapshots: SyncSnapshot[]) => void) => () => void),
}))

vi.mock('@/services/platform', () => ({ platform: mocks.platform }))
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: { getState: () => mocks.library, subscribe: () => () => {} },
}))

/** 假局域网桥：配对调用是核心观测点，其余方法给最小可用实现 */
const fakeBridge = () => ({
  status: vi.fn(async () => ({
    running: true,
    port: 45871,
    code: 'ABCDEFGHJK',
    deviceId: 'dev-local',
    deviceName: '本机',
  })),
  setEnabled: vi.fn(async () => ({
    running: true,
    port: 45871,
    code: 'ABCDEFGHJK',
    deviceId: 'dev-local',
    deviceName: '本机',
  })),
  rotateCode: vi.fn(async () => ({
    running: true,
    port: 45871,
    code: 'ABCDEFGHJK',
    deviceId: 'dev-local',
    deviceName: '本机',
  })),
  discover: vi.fn(async () => [] as LanPeerInfo[]),
  publish: vi.fn(async () => {}),
  takeInbox: vi.fn(async () => [] as SyncSnapshot[]),
  pullPeer: vi.fn(async () => [] as SyncSnapshot[]),
  pushPeer: vi.fn(async () => {}),
  pairStart: vi.fn(async (peer: LanPairPeer): Promise<LanPairStartResult> => ({ ok: true, peer })),
  pairRespond: vi.fn(async () => ({ accepted: true })),
  pairCancel: vi.fn(async () => {}),
  adoptPairedCode: vi.fn(async (_configId: string, _deviceId: string) => true),
})

const peer = (over: Partial<LanPeerInfo> = {}): LanPeerInfo => ({
  deviceId: 'dev-peer',
  deviceName: '书房台式机',
  host: '192.168.1.20',
  port: 45871,
  protocol: 1,
  lastSeenAt: Date.now(),
  ...over,
})

const pairedPeer = (over: Partial<LanPairPeer> = {}): LanPairPeer => ({
  deviceId: 'dev-peer',
  deviceName: '书房台式机',
  host: '192.168.1.20',
  port: 45871,
  ...over,
})

const configsOf = () => useSyncStore.getState().configs

let bridge: ReturnType<typeof fakeBridge>
/** 个别用例会临时替换 store 的改名动作，afterEach 里恢复，避免污染后续用例 */
let addedConfigSpy: { restore?: () => void } = {}

beforeEach(() => {
  resetPlaylistSyncForTest()
  bridge = fakeBridge()
  setLanSyncBridge(bridge as never)
  vi.mocked(mocks.platform.sync.getCredential).mockResolvedValue({ code: '23456789AB' })
  // 内置插件在共享包模块求值期注册；这里再注册一次是幂等的（同 id 替换实现、保留位置）
  registerSyncPlugin(lanSyncPlugin)
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
})

afterEach(() => {
  addedConfigSpy.restore?.()
  addedConfigSpy = {}
})

describe('pairWithLanPeer：发起方', () => {
  it('配对成功后建一条双向目标，并把码落到**这条配置**名下', async () => {
    const outcome = await pairWithLanPeer(peer())

    expect(outcome.ok).toBe(true)
    const configs = configsOf()
    expect(configs).toHaveLength(1)
    const config = configs[0]!
    expect(config.pluginId).toBe(LAN_SYNC_PLUGIN_ID)
    expect(config.name).toBe('书房台式机')
    expect(config.direction).toBe('bidirectional')
    expect(config.autoSync).toBe(true)
    expect(config.enabled).toBe(true)
    expect(config.settings).toMatchObject({
      host: '192.168.1.20',
      port: 45871,
      peerDeviceId: 'dev-peer',
    })
    // 码必须落在 store 里这条配置的 id 上：换成 pluginId 或设备名会让另一条配置拿不到码
    expect(bridge.adoptPairedCode).toHaveBeenCalledWith(config.id, 'dev-peer')
  })

  it('先落码、再入 store：入 store 时凭证必须已经可读（顺序反了会「配对成功却同步失败」）', async () => {
    const order: string[] = []
    const originalAddConfig = useSyncStore.getState().addConfig
    useSyncStore.setState({
      addConfig: (config) => {
        order.push('addConfig')
        originalAddConfig(config)
      },
    })
    addedConfigSpy.restore = () => useSyncStore.setState({ addConfig: originalAddConfig })
    bridge.adoptPairedCode.mockImplementationOnce(async () => {
      order.push('adopt')
      return true
    })

    await pairWithLanPeer(peer())

    expect(order).toEqual(['adopt', 'addConfig'])
  })

  it('对端拒绝 → 原样透传 denied，且不建配置', async () => {
    bridge.pairStart.mockResolvedValueOnce({ ok: false, reason: 'denied' })

    const outcome = await pairWithLanPeer(peer())

    expect(outcome).toEqual({ ok: false, reason: 'denied' })
    expect(configsOf()).toHaveLength(0)
    expect(bridge.adoptPairedCode).not.toHaveBeenCalled()
  })

  it('连不上 → 透传 unreachable', async () => {
    bridge.pairStart.mockResolvedValueOnce({ ok: false, reason: 'unreachable' })

    await expect(pairWithLanPeer(peer())).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })

  it('桥抛错（宿主没接上/序列化失败）按 unreachable 报，不把异常漏给 UI', async () => {
    bridge.pairStart.mockRejectedValueOnce(new Error('ipc closed'))

    await expect(pairWithLanPeer(peer())).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })

  it('码没落住（配对过期/被取走）→ auth，且不留一条没凭据的配置', async () => {
    bridge.adoptPairedCode.mockResolvedValueOnce(false)

    const outcome = await pairWithLanPeer(peer())

    expect(outcome).toEqual({ ok: false, reason: 'auth' })
    expect(configsOf()).toHaveLength(0)
  })

  it('没有局域网桥 → unsupported（UI 据此提示改用「手动填码」）', async () => {
    setLanSyncBridge(null)

    await expect(pairWithLanPeer(peer())).resolves.toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('completeLanPairing：应答方', () => {
  it('配对完成后同样建一条双向目标（两端对称，否则对端改动推不回来）', async () => {
    const config = await completeLanPairing(pairedPeer())

    expect(config).not.toBeNull()
    expect(configsOf()).toHaveLength(1)
    expect(configsOf()[0]!.direction).toBe('bidirectional')
    expect(bridge.adoptPairedCode).toHaveBeenCalledWith(config!.id, 'dev-peer')
  })

  it('码没落住 → 返回 null 且不建配置', async () => {
    bridge.adoptPairedCode.mockResolvedValueOnce(false)

    await expect(completeLanPairing(pairedPeer())).resolves.toBeNull()
    expect(configsOf()).toHaveLength(0)
  })
})

describe('respondLanPairRequest：确认框的两个按钮', () => {
  it('允许 → 回 true', async () => {
    await expect(respondLanPairRequest('pair-1', true)).resolves.toBe(true)
    expect(bridge.pairRespond).toHaveBeenCalledWith('pair-1', true)
  })

  it('拒绝 → 宿主回 accepted:false 时如实返回 false（不假装成功）', async () => {
    bridge.pairRespond.mockResolvedValueOnce({ accepted: false })

    await expect(respondLanPairRequest('pair-1', false)).resolves.toBe(false)
  })

  it('桥抛错 → false，不把异常抛进 React 事件循环', async () => {
    bridge.pairRespond.mockRejectedValueOnce(new Error('gone'))

    await expect(respondLanPairRequest('pair-1', true)).resolves.toBe(false)
  })
})

/**
 * `lan-sync` 插件（`docs/playlist-sync.md` §7）。
 *
 * 本文件聚焦 T6 改动的两点，其余（错误透传、桥缺失、探测）顺带覆盖：
 *
 * 1. **配对码走凭证网关**：`code` 字段的 kind 是 `password`，值由宿主注入
 *    `ctx.secrets.code`，**不进 `settings`**（否则进 localStorage）；`settings.code`
 *    只在 secrets 缺值时才读，作为老配置的兼容路径。
 * 2. 桥只搬参数：`targetOf()` 组出的 `LanSyncTarget` 必须带上解密后的配对码，
 *    并且去掉用户抄写时的空格、统一大写（主机侧据此派生 HMAC）。
 *
 * 全程用假的 `LanSyncBridge`，不起网络、不硬编码任何地址。
 */
import { describe, expect, it, vi } from 'vitest'
import { toErrorInfo } from '../../../i18n/errors'
import { lanSyncPlugin } from '../lanSyncPlugin'
import { setLanSyncBridge } from '../registry'
import type {
  LanPeerInfo,
  LanSyncBridge,
  LanSyncStatus,
  LanSyncTarget,
  SyncConfig,
  SyncContext,
  SyncSnapshot,
} from '../types'

const DEVICE = { deviceId: 'device-aaaa', deviceName: '工作站' }

const snapshot: SyncSnapshot = {
  format: 'aurora-playlist-sync/1',
  deviceId: 'device-aaaa',
  deviceName: '工作站',
  revision: 2,
  updatedAt: 1_000,
  playlists: [],
}

const config = (settings: Record<string, string> = {}): SyncConfig => ({
  id: 'cfg-lan',
  pluginId: 'lan-sync',
  name: '书房的台式机',
  settings: { host: '192.168.1.20', port: '45871', ...settings },
  direction: 'bidirectional',
  autoSync: false,
  enabled: true,
})

const status: LanSyncStatus = {
  running: true,
  port: 45871,
  code: 'ABCDE12345',
  deviceId: DEVICE.deviceId,
  deviceName: DEVICE.deviceName,
}

/** 只记录调用参数的假桥 */
function fakeBridge(over: Partial<LanSyncBridge> = {}): {
  bridge: LanSyncBridge
  pulls: LanSyncTarget[]
  pushes: { target: LanSyncTarget; snapshot: SyncSnapshot }[]
} {
  const pulls: LanSyncTarget[] = []
  const pushes: { target: LanSyncTarget; snapshot: SyncSnapshot }[] = []
  const bridge: LanSyncBridge = {
    status: async () => status,
    setEnabled: async () => status,
    rotateCode: async () => status,
    discover: async () => [] as LanPeerInfo[],
    publish: async () => undefined,
    takeInbox: async () => [],
    pullPeer: async (target) => {
      pulls.push(target)
      return [snapshot]
    },
    pushPeer: async (target, pushed) => {
      pushes.push({ target, snapshot: pushed })
    },
    ...over,
  }
  return { bridge, pulls, pushes }
}

const context = (secrets: Record<string, string>, bridge: LanSyncBridge): SyncContext => ({
  fetch: globalThis.fetch,
  secrets,
  device: DEVICE,
  lan: bridge,
})

describe('lanSyncPlugin：字段形态', () => {
  it('配对码的 kind 是 password（不进 settings / 不进 localStorage）', () => {
    const code = lanSyncPlugin.fields.find((field) => field.key === 'code')
    expect(code?.kind).toBe('password')
  })

  it('字段键名保持裸键 host / port / code（与 config.settings 写入对齐）', () => {
    expect(lanSyncPlugin.fields.map((field) => field.key)).toEqual(['host', 'port', 'code'])
  })

  it('没有桥时 available() 为 false', () => {
    setLanSyncBridge(null)
    expect(lanSyncPlugin.available?.()).toBe(false)

    const { bridge } = fakeBridge()
    setLanSyncBridge(bridge)
    expect(lanSyncPlugin.available?.()).toBe(true)
    setLanSyncBridge(null)
  })
})

describe('lanSyncPlugin.pull：配对码来源', () => {
  it('优先读 ctx.secrets.code（密码字段），去掉抄写时的空格并大写', async () => {
    const { bridge, pulls } = fakeBridge()
    await lanSyncPlugin.pull?.(config({ code: 'OLD-SETTINGS' }), context({ code: 'abcde 12345' }, bridge))

    expect(pulls).toHaveLength(1)
    expect(pulls[0]).toMatchObject({ host: '192.168.1.20', port: 45871, code: 'ABCDE12345' })
  })

  it('secrets 里没有 code 时回退 settings.code（老配置兼容路径）', async () => {
    const { bridge, pulls } = fakeBridge()
    await lanSyncPlugin.pull?.(config({ code: 'fghij 67890' }), context({}, bridge))

    expect(pulls[0].code).toBe('FGHIJ67890')
  })

  it('secrets 里是空白串时也回退 settings（凭证网关里存了个空值不该让同步直接失败）', async () => {
    const { bridge, pulls } = fakeBridge()
    await lanSyncPlugin.pull?.(config({ code: 'ZZZZZ00000' }), context({ code: '   ' }, bridge))

    expect(pulls[0].code).toBe('ZZZZZ00000')
  })

  it('端口缺省 45871；settings 里的 port 越界时抛 lanUnreachable', async () => {
    const { bridge, pulls } = fakeBridge()
    await lanSyncPlugin.pull?.(config({ port: '' }), context({ code: 'ABCDE12345' }, bridge))
    expect(pulls[0].port).toBe(45871)

    await expect(
      lanSyncPlugin.pull?.(config({ port: '70000' }), context({ code: 'ABCDE12345' }, bridge))
    ).rejects.toMatchObject({ code: 'sync.error.lanUnreachable' })
  })
})

describe('lanSyncPlugin.push：写入内容就是引擎给的那份快照', () => {
  it('把 target 与 snapshot 原样交给桥（插件自己不合并）', async () => {
    const { bridge, pushes } = fakeBridge()
    await lanSyncPlugin.push?.(config(), snapshot, context({ code: 'ABCDE12345' }, bridge))

    expect(pushes).toHaveLength(1)
    expect(pushes[0].target.code).toBe('ABCDE12345')
    expect(pushes[0].snapshot).toBe(snapshot)
  })
})

describe('lanSyncPlugin：桥缺失 / 桥错误', () => {
  it('没有桥时抛 sync.error.lanDisabled', async () => {
    setLanSyncBridge(null)
    const ctx: SyncContext = { fetch: globalThis.fetch, secrets: {}, device: DEVICE }
    let code = ''
    try {
      await lanSyncPlugin.pull?.(config({ code: 'ABCDE12345' }), ctx)
    } catch (error) {
      code = toErrorInfo(error).code
    }
    expect(code).toBe('sync.error.lanDisabled')
  })

  it('桥抛结构化错误时原样透传（不包成中文，不改码）', async () => {
    const structured = new Error(
      'AURORA_ERR:' + JSON.stringify({ code: 'sync.error.lanAuth', params: {} })
    )
    const { bridge } = fakeBridge({
      pullPeer: async () => {
        throw structured
      },
    })

    await expect(
      lanSyncPlugin.pull?.(config({ code: 'ABCDE12345' }), context({ code: 'ABCDE12345' }, bridge))
    ).rejects.toBe(structured)
  })

  it('桥抛非结构化错误时包成 sync.error.unknown', async () => {
    const { bridge } = fakeBridge({
      pullPeer: async () => {
        throw new Error('ECONNREFUSED 192.168.1.20:45871')
      },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    let code = ''
    try {
      await lanSyncPlugin.pull?.(config({ code: 'ABCDE12345' }), context({ code: 'ABCDE12345' }, bridge))
    } catch (error) {
      code = toErrorInfo(error).code
    }
    expect(code).toBe('sync.error.unknown')
  })
})

/**
 * Linux provider（MPRIS over D-Bus）单测。
 *
 * 这一层守的是两条「交付后才失效」的性质：
 *   1. **provider 绝不把异常抛给上层**——轮询循环被一次异常打死，表现是「功能时灵时不灵」，
 *      现场极难复现；
 *   2. **单个坏播放器不拖垮整次列举**——一个卡死/属性读不出来的播放器若让整份名单为空，
 *      互斥功能会整块静默失效，日志里却只有一条空列表。
 *
 * 所以这里注入假 bus 把每个失败分支钉住，不依赖真实 session bus（真 D-Bus 的联调
 * 由临时 smoke 脚本覆盖，不入库）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createLinuxProvider,
  type LinuxBusLike,
  type LinuxProxyObjectLike,
} from '../providers/linux'

/** 假播放器的可配置行为；缺省是「能正常报告 Playing/Paused」 */
interface FakePlayer {
  status?: unknown
  identity?: unknown
  statusFails?: boolean
  identityFails?: boolean
  /** PlaybackStatus 永不返回：模拟播放器卡死 */
  statusHangs?: boolean
  /** 内省里不列 org.freedesktop.DBus.Properties（部分实现如此） */
  hideProperties?: boolean
  /** 内省本身失败：模拟代理取不到 */
  introspectFails?: boolean
  pauseFails?: boolean
  playFails?: boolean
  /** 被调用了多少次 Pause()/Play()（验证成功路径确实发出去） */
  pauseCalls?: number
  playCalls?: number
}

interface FakeBusOptions {
  names?: string[]
  players?: Record<string, FakePlayer>
  listNamesFails?: boolean
  /** bus name → 持有者 PID；未列出的名字返回一个肯定不是自己的 PID */
  pids?: Record<string, number>
  /** 这些 name 的 PID 查询会失败（模拟方法不可用 / 对端已退出） */
  pidFails?: string[]
}

interface RawCall {
  destination?: string
  member?: string
  iface?: string
  body?: unknown[]
}

interface FakeBus {
  bus: LinuxBusLike
  disconnect: ReturnType<typeof vi.fn>
  errorListeners: Array<(error: unknown) => void>
  rawCalls: RawCall[]
}

/**
 * 假 session bus：只实现 provider 用到的那几个成员。
 *
 * 同时模拟了真实 bus 的两个关键行为：
 *   - `getInterface` 找不到接口时**同步抛错**（dbus-next 的 ProxyObject 就是这样）；
 *   - 方法调用失败时 reject（对端已退出 / 播放器拒绝）。
 */
function createFakeBus(options: FakeBusOptions = {}): FakeBus {
  const names = options.names ?? []
  const players = options.players ?? {}
  const disconnect = vi.fn()
  const errorListeners: Array<(error: unknown) => void> = []
  const rawCalls: RawCall[] = []

  const bus: LinuxBusLike = {
    getProxyObject: async (name: string): Promise<LinuxProxyObjectLike> => {
      if (name === 'org.freedesktop.DBus') {
        return {
          getInterface: (iface: string) => {
            if (iface !== 'org.freedesktop.DBus') throw new Error(`interface not found: ${iface}`)
            return {
              ListNames: async () => {
                if (options.listNamesFails) throw new Error('ListNames 失败')
                return names
              },
              GetConnectionUnixProcessID: async (name: string) => {
                if (options.pidFails?.includes(name)) throw new Error('PID 查询失败')
                return options.pids?.[name] ?? 100000
              },
            }
          },
        }
      }

      const player = players[name]
      if (!player) throw new Error(`no such player: ${name}`)
      if (player.introspectFails) throw new Error('Introspect 失败')

      return {
        getInterface: (iface: string) => {
          if (iface === 'org.freedesktop.DBus.Properties') {
            if (player.hideProperties) throw new Error(`interface not found: ${iface}`)
            return {
              Get: async (ifaceName: string, property: string) => {
                if (ifaceName === 'org.mpris.MediaPlayer2.Player' && property === 'PlaybackStatus') {
                  if (player.statusHangs) return new Promise(() => {})
                  if (player.statusFails) throw new Error('PlaybackStatus 读取失败')
                  return { signature: 's', value: player.status ?? 'Playing' }
                }
                if (ifaceName === 'org.mpris.MediaPlayer2' && property === 'Identity') {
                  if (player.identityFails) throw new Error('Identity 读取失败')
                  return { signature: 's', value: player.identity ?? name }
                }
                throw new Error(`未知属性: ${ifaceName}.${property}`)
              },
            }
          }
          if (iface === 'org.mpris.MediaPlayer2.Player') {
            return {
              Pause: async () => {
                if (player.pauseFails) throw new Error('Pause 失败')
                player.pauseCalls = (player.pauseCalls ?? 0) + 1
              },
              Play: async () => {
                if (player.playFails) throw new Error('Play 失败')
                player.playCalls = (player.playCalls ?? 0) + 1
              },
            }
          }
          throw new Error(`interface not found: ${iface}`)
        },
      }
    },

    // 只有「内省不列 Properties」的兜底路径会走到这里（原始方法调用）
    call: async (message: unknown) => {
      const msg = message as RawCall
      rawCalls.push({
        destination: msg.destination,
        member: msg.member,
        iface: msg.iface,
        body: msg.body,
      })
      const player = msg.destination ? players[msg.destination] : undefined
      if (!player) throw new Error(`no such player: ${msg.destination}`)

      if (msg.member === 'Get') {
        const property = msg.body?.[1]
        if (property === 'PlaybackStatus') {
          if (player.statusFails) throw new Error('PlaybackStatus 读取失败')
          return { body: [{ signature: 's', value: player.status ?? 'Playing' }] }
        }
        if (property === 'Identity') {
          if (player.identityFails) throw new Error('Identity 读取失败')
          return { body: [{ signature: 's', value: player.identity ?? msg.destination }] }
        }
        throw new Error(`未知属性: ${String(property)}`)
      }
      if (msg.member === 'Pause' && player.pauseFails) throw new Error('Pause 失败')
      if (msg.member === 'Play' && player.playFails) throw new Error('Play 失败')
      return { body: [] }
    },

    on: (event: 'error', listener: (error: unknown) => void) => {
      if (event === 'error') errorListeners.push(listener)
    },

    disconnect,
  }

  return { bus, disconnect, errorListeners, rawCalls }
}

/** 按顺序返回不同 bus 的工厂（验证「断开后重连」） */
function createRotatingBusFactory(buses: LinuxBusLike[]) {
  const remaining = [...buses]
  return vi.fn(() => remaining.shift() ?? buses[buses.length - 1])
}

describe('契约', () => {
  it('kind 是 linux，轮询间隔 1000ms', () => {
    const { bus } = createFakeBus()
    const provider = createLinuxProvider({ busFactory: () => bus })
    expect(provider.kind).toBe('linux')
    expect(provider.pollingIntervalMs).toBe(1000)
  })
})

describe('list：列举', () => {
  it('只列举 org.mpris.MediaPlayer2.*，并排除本应用自己', async () => {
    const { bus } = createFakeBus({
      names: [
        'org.mpris.MediaPlayer2.aurora-music', // 默认自身名
        'org.mpris.MediaPlayer2.Aurora-Beta', // 名字含 aurora，一律排除
        'org.mpris.MediaPlayer2.spotify',
        'org.freedesktop.Notifications', // 非 MPRIS
        ':1.42', // unique name
      ],
      players: {
        'org.mpris.MediaPlayer2.spotify': { status: 'Playing', identity: 'Spotify' },
      },
    })
    const provider = createLinuxProvider({ busFactory: () => bus })

    await expect(provider.list()).resolves.toEqual([
      { id: 'org.mpris.MediaPlayer2.spotify', label: 'Spotify', status: 'Playing' },
    ])
  })

  it('options.selfNames 追加要排除的名字', async () => {
    const { bus } = createFakeBus({
      names: ['org.mpris.MediaPlayer2.my-own-player', 'org.mpris.MediaPlayer2.spotify'],
      players: {
        // 给自身名也配上可读属性：若没被排除，它会出现在结果里
        'org.mpris.MediaPlayer2.my-own-player': { status: 'Playing', identity: 'Mine' },
        'org.mpris.MediaPlayer2.spotify': { status: 'Paused', identity: 'Spotify' },
      },
    })
    const provider = createLinuxProvider({
      busFactory: () => bus,
      selfNames: ['org.mpris.MediaPlayer2.my-own-player'],
    })

    const players = await provider.list()
    expect(players.map((player) => player.id)).toEqual(['org.mpris.MediaPlayer2.spotify'])
  })

  it('按 PID 归属排除自己（Chromium 会把本应用播放暴露成 chromium.instance<pid>）', async () => {
    const { bus } = createFakeBus({
      names: ['org.mpris.MediaPlayer2.chromium.instance4242', 'org.mpris.MediaPlayer2.spotify'],
      pids: { 'org.mpris.MediaPlayer2.chromium.instance4242': 4242 },
      players: {
        'org.mpris.MediaPlayer2.chromium.instance4242': { status: 'Playing', identity: 'Chromium' },
        'org.mpris.MediaPlayer2.spotify': { status: 'Paused', identity: 'Spotify' },
      },
    })
    const provider = createLinuxProvider({ busFactory: () => bus, selfPids: [4242] })

    const players = await provider.list()
    expect(players.map((player) => player.id)).toEqual(['org.mpris.MediaPlayer2.spotify'])
  })

  it('PID 查不出来时保留该播放器（宁可漏排自己，也不误排真实播放器）', async () => {
    const { bus } = createFakeBus({
      names: ['org.mpris.MediaPlayer2.spotify'],
      pidFails: ['org.mpris.MediaPlayer2.spotify'],
      players: { 'org.mpris.MediaPlayer2.spotify': { status: 'Playing', identity: 'Spotify' } },
    })
    const provider = createLinuxProvider({ busFactory: () => bus, selfPids: [4242] })

    const players = await provider.list()
    expect(players.map((player) => player.id)).toEqual(['org.mpris.MediaPlayer2.spotify'])
  })

  it('未知 PlaybackStatus 按 Stopped 处理（脏数据不该被当成"别人在出声"）', async () => {
    const { bus } = createFakeBus({
      names: ['org.mpris.MediaPlayer2.weird'],
      players: { 'org.mpris.MediaPlayer2.weird': { status: 'Buffering', identity: 'Weird' } },
    })
    const provider = createLinuxProvider({ busFactory: () => bus })

    await expect(provider.list()).resolves.toEqual([
      { id: 'org.mpris.MediaPlayer2.weird', label: 'Weird', status: 'Stopped' },
    ])
  })

  it('单个播放器失败不影响其他播放器；Identity 失败回落为 bus name', async () => {
    const { bus } = createFakeBus({
      names: [
        'org.mpris.MediaPlayer2.spotify',
        'org.mpris.MediaPlayer2.vlc',
        'org.mpris.MediaPlayer2.dead',
        'org.mpris.MediaPlayer2.weird',
      ],
      players: {
        'org.mpris.MediaPlayer2.spotify': { status: 'Playing', identity: 'Spotify' },
        'org.mpris.MediaPlayer2.vlc': { statusFails: true }, // 属性读不出来 → 跳过
        'org.mpris.MediaPlayer2.dead': { introspectFails: true }, // 代理取不到 → 跳过
        'org.mpris.MediaPlayer2.weird': { status: 'Paused', identityFails: true },
      },
    })
    const provider = createLinuxProvider({ busFactory: () => bus })

    await expect(provider.list()).resolves.toEqual([
      { id: 'org.mpris.MediaPlayer2.spotify', label: 'Spotify', status: 'Playing' },
      {
        id: 'org.mpris.MediaPlayer2.weird',
        label: 'org.mpris.MediaPlayer2.weird',
        status: 'Paused',
      },
    ])
  })

  it('对端无响应时按超时跳过，不拖垮整次列举', async () => {
    const { bus } = createFakeBus({
      names: ['org.mpris.MediaPlayer2.stuck', 'org.mpris.MediaPlayer2.spotify'],
      players: {
        'org.mpris.MediaPlayer2.stuck': { statusHangs: true },
        'org.mpris.MediaPlayer2.spotify': { status: 'Playing', identity: 'Spotify' },
      },
    })
    const provider = createLinuxProvider({ busFactory: () => bus, callTimeoutMs: 20 })

    const players = await provider.list()
    expect(players.map((player) => player.id)).toEqual(['org.mpris.MediaPlayer2.spotify'])
  })

  it('ListNames 失败时返回空数组（不抛错）', async () => {
    const { bus } = createFakeBus({ listNamesFails: true })
    const provider = createLinuxProvider({ busFactory: () => bus })

    await expect(provider.list()).resolves.toEqual([])
  })

  it('内省未列出 Properties 接口时退回原始 Properties.Get', async () => {
    const { bus, rawCalls } = createFakeBus({
      names: ['org.mpris.MediaPlayer2.spotify'],
      players: {
        'org.mpris.MediaPlayer2.spotify': {
          status: 'Paused',
          identity: 'Spotify',
          hideProperties: true,
        },
      },
    })
    const provider = createLinuxProvider({ busFactory: () => bus })

    await expect(provider.list()).resolves.toEqual([
      { id: 'org.mpris.MediaPlayer2.spotify', label: 'Spotify', status: 'Paused' },
    ])
    expect(rawCalls.map((call) => call.member)).toEqual(['Get', 'Get'])
  })
})

describe('pause / play', () => {
  it('成功路径确实调用 Player.Pause() / Player.Play()', async () => {
    const player: FakePlayer = { status: 'Playing', identity: 'Spotify' }
    const { bus } = createFakeBus({
      names: ['org.mpris.MediaPlayer2.spotify'],
      players: { 'org.mpris.MediaPlayer2.spotify': player },
    })
    const provider = createLinuxProvider({ busFactory: () => bus })

    await provider.pause('org.mpris.MediaPlayer2.spotify')
    await provider.play('org.mpris.MediaPlayer2.spotify')

    expect(player.pauseCalls).toBe(1)
    expect(player.playCalls).toBe(1)
  })

  it('所有异常在内部吞掉（契约：不向调用方抛错）', async () => {
    const { bus } = createFakeBus({
      names: ['org.mpris.MediaPlayer2.spotify'],
      players: {
        'org.mpris.MediaPlayer2.spotify': { pauseFails: true, playFails: true },
      },
    })
    const provider = createLinuxProvider({ busFactory: () => bus })

    // 播放器拒绝
    await expect(provider.pause('org.mpris.MediaPlayer2.spotify')).resolves.toBeUndefined()
    await expect(provider.play('org.mpris.MediaPlayer2.spotify')).resolves.toBeUndefined()
    // 播放器已退出（代理取不到）
    await expect(provider.pause('org.mpris.MediaPlayer2.gone')).resolves.toBeUndefined()
    // 非 MPRIS 名字：不向任意服务发调用，也静默成功
    await expect(provider.pause('org.freedesktop.DBus')).resolves.toBeUndefined()
    await expect(provider.play('not-a-bus-name')).resolves.toBeUndefined()
  })
})

describe('连接管理', () => {
  it('没有 session bus 时列举为空、控制静默成功、dispose 不抛错', async () => {
    const provider = createLinuxProvider({
      busFactory: () => {
        throw new Error('DBUS_SESSION_BUS_ADDRESS 缺失')
      },
    })

    await expect(provider.list()).resolves.toEqual([])
    await expect(provider.pause('org.mpris.MediaPlayer2.spotify')).resolves.toBeUndefined()
    await expect(provider.dispose()).resolves.toBeUndefined()
  })

  it('懒连接：构造时不连，第一次 list() 才连', async () => {
    const { bus } = createFakeBus()
    const busFactory = vi.fn(() => bus)
    const provider = createLinuxProvider({ busFactory })

    expect(busFactory).not.toHaveBeenCalled()
    await provider.list()
    expect(busFactory).toHaveBeenCalledTimes(1)
    await provider.list()
    expect(busFactory).toHaveBeenCalledTimes(1) // 同一连接复用
  })

  it('dispose 幂等；断开后下一次调用重连', async () => {
    const first = createFakeBus({ names: [], players: {} })
    const second = createFakeBus({
      names: ['org.mpris.MediaPlayer2.spotify'],
      players: { 'org.mpris.MediaPlayer2.spotify': { status: 'Playing' } },
    })
    const busFactory = createRotatingBusFactory([first.bus, second.bus])
    const provider = createLinuxProvider({ busFactory })

    await provider.list()
    expect(busFactory).toHaveBeenCalledTimes(1)

    await provider.dispose()
    await provider.dispose() // 幂等：不会再断一次
    expect(first.disconnect).toHaveBeenCalledTimes(1)

    const players = await provider.list()
    expect(busFactory).toHaveBeenCalledTimes(2)
    expect(players.map((player) => player.id)).toEqual(['org.mpris.MediaPlayer2.spotify'])
  })

  it('挂上 error 兜底监听；连接报错后丢弃连接并在下次调用重连', async () => {
    const first = createFakeBus({ names: [], players: {} })
    const second = createFakeBus({ names: [], players: {} })
    const busFactory = createRotatingBusFactory([first.bus, second.bus])
    const provider = createLinuxProvider({ busFactory })

    await provider.list()
    expect(first.errorListeners).toHaveLength(1)

    // 未监听 'error' 时 dbus-next 会让进程崩掉；这里必须既不抛也不留死连接
    expect(() => first.errorListeners[0]?.(new Error('连接断开'))).not.toThrow()
    expect(first.disconnect).toHaveBeenCalledTimes(1)

    await provider.list()
    expect(busFactory).toHaveBeenCalledTimes(2)
  })
})

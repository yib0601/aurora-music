/**
 * 快照解析与墓碑清理（`docs/playlist-sync.md` §3 / §5）。
 *
 * 这里的断言都围绕一个前提：快照来自**别的设备**，是不可信输入。所以除了
 * "能读回来"之外，更要验证"读不回来的时候是整份拒绝还是逐条丢弃"，以及错误码
 * 是否落在 §15.2 规定的那两个字上（前端靠错误码选文案，码错了界面就会显示兜底文案）。
 */
import { describe, expect, it } from 'vitest'
import { toErrorInfo } from '../../../i18n/errors'
import {
  SYNC_TOMBSTONE_TTL_MS,
  isSnapshotOfDevice,
  isTombstoneExpired,
  parseSnapshot,
  pruneSnapshot,
  serializeSnapshot,
  snapshotContentHash,
} from '../snapshot'
import { SYNC_SNAPSHOT_FORMAT, type SyncSnapshot, type SyncedPlaylist } from '../types'

const NOW = 1_760_000_000_000
const DAY = 24 * 60 * 60 * 1000

function goodSnapshot(over: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    format: SYNC_SNAPSHOT_FORMAT,
    deviceId: 'dev-aaaa',
    deviceName: '我的笔记本',
    revision: 7,
    updatedAt: 1_000,
    playlists: [
      {
        id: 'pl-1',
        name: '通勤',
        createdAt: 10,
        updatedAt: 20,
        tracks: [{ kind: 'local', title: '歌', artist: '人', album: '专辑', duration: 210, path: '/m/a.mp3' }],
      },
    ],
    ...over,
  }
}

/** 取结构化错误码（auroraError 的 message 是 'AURORA_ERR:{json}' 信封） */
function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return toErrorInfo(error).code
  }
  throw new Error('预期抛错，但没有抛')
}

function paramsOf(run: () => unknown): Record<string, string | number> {
  try {
    run()
  } catch (error) {
    return toErrorInfo(error).params ?? {}
  }
  throw new Error('预期抛错，但没有抛')
}

describe('serializeSnapshot / parseSnapshot', () => {
  it('序列化后能原样解析回来', () => {
    const snapshot = goodSnapshot()
    expect(parseSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot)
  })

  it('坏 JSON 整份拒绝，错误码是 snapshotInvalid 且带文件名', () => {
    expect(codeOf(() => parseSnapshot('{ 半截', 'dev-bbbb.json'))).toBe('sync.error.snapshotInvalid')
    expect(paramsOf(() => parseSnapshot('{ 半截', 'dev-bbbb.json')).file).toBe('dev-bbbb.json')
    // 没有文件名时也要能出文案（落 '?'）
    expect(paramsOf(() => parseSnapshot('null')).file).toBe('?')
  })

  it('JSON 不是对象（数组/字符串/数字）同样按损坏处理', () => {
    for (const text of ['[]', '"hello"', '42']) {
      expect(codeOf(() => parseSnapshot(text))).toBe('sync.error.snapshotInvalid')
    }
  })

  it('格式版本不符抛 snapshotVersion，且优先于结构校验', () => {
    expect(paramsOf(() => parseSnapshot(JSON.stringify({ format: 'aurora-playlist-sync/2' }))).format).toBe(
      'aurora-playlist-sync/2'
    )
    expect(codeOf(() => parseSnapshot(JSON.stringify({ format: 'aurora-playlist-sync/2' })))).toBe(
      'sync.error.snapshotVersion'
    )
    // 连 deviceId/playlists 都没有：仍然先报版本问题，不报"格式不正确"
    expect(codeOf(() => parseSnapshot(JSON.stringify({ format: 'something-else' })))).toBe(
      'sync.error.snapshotVersion'
    )
    // 完全缺 format 时也走版本分支（format 落 '?'）
    expect(paramsOf(() => parseSnapshot('{}')).format).toBe('?')
  })

  it('缺 deviceId 或 playlists 不是数组 → snapshotInvalid', () => {
    expect(codeOf(() => parseSnapshot(JSON.stringify({ format: SYNC_SNAPSHOT_FORMAT, playlists: [] })))).toBe(
      'sync.error.snapshotInvalid'
    )
    expect(
      codeOf(() => parseSnapshot(JSON.stringify({ format: SYNC_SNAPSHOT_FORMAT, deviceId: 'd', playlists: {} })))
    ).toBe('sync.error.snapshotInvalid')
  })

  it('歌单缺 id / updatedAt 非法 → 整份拒绝（它无法参与 LWW）', () => {
    const base = { format: SYNC_SNAPSHOT_FORMAT, deviceId: 'd', playlists: [] as unknown[] }
    const cases: unknown[] = [
      { updatedAt: 1, name: 'no-id' },
      { id: 'x', name: 'no-time' },
      { id: 'x', updatedAt: 0 },
      { id: 'x', updatedAt: 'soon' },
      { id: 'x', updatedAt: 1, tracks: 'oops' },
      'not-an-object'
    ]
    for (const playlist of cases) {
      expect(codeOf(() => parseSnapshot(JSON.stringify({ ...base, playlists: [playlist] })))).toBe(
        'sync.error.snapshotInvalid'
      )
    }
  })

  it('曲目引用逐条净化：坏条目丢弃，好条目保留', () => {
    const parsed = parseSnapshot(
      JSON.stringify({
        ...goodSnapshot(),
        playlists: [
          {
            id: 'pl-1',
            name: '混合',
            createdAt: 1,
            updatedAt: 2,
            tracks: [
              { kind: 'local', title: 'ok', artist: '', album: '', duration: 1, path: '/a.mp3' },
              { kind: 'local', title: '空路径', artist: '', album: '', duration: 1, path: '  ' },
              { kind: 'storage', title: 'ok2', artist: '', album: '', duration: 1, pluginId: 'webdav', relPath: 'x/y.mp3' },
              { kind: 'storage', title: '缺路径', artist: '', album: '', duration: 1, pluginId: 'webdav' },
              { kind: 'meta', title: '在线', artist: '', album: '', duration: 1, onlineId: 'abc', platform: 'qq', coverUrl: '' },
              { kind: 'future', title: '未来档位', artist: '', album: '', duration: 1 },
              null
            ]
          }
        ]
      })
    )

    const tracks = parsed.playlists[0].tracks
    expect(tracks).toHaveLength(3)
    expect(tracks[0]).toMatchObject({ kind: 'local', path: '/a.mp3' })
    expect(tracks[1]).toMatchObject({ kind: 'storage', pluginId: 'webdav', relPath: 'x/y.mp3' })
    // 空的可选字段不落地，避免快照里存一堆空串
    expect(tracks[2]).toEqual({ kind: 'meta', title: '在线', artist: '', album: '', duration: 1, onlineId: 'abc', platform: 'qq' })
  })

  it('createdAt 缺失时回落到 updatedAt；负时长归零', () => {
    const parsed = parseSnapshot(
      JSON.stringify({
        format: SYNC_SNAPSHOT_FORMAT,
        deviceId: 'd',
        playlists: [
          { id: 'p', name: 'n', updatedAt: 500, tracks: [{ kind: 'meta', title: 't', artist: '', album: '', duration: -3 }] }
        ]
      })
    )
    expect(parsed.playlists[0].createdAt).toBe(500)
    expect(parsed.playlists[0].tracks[0].duration).toBe(0)
  })
})

describe('isSnapshotOfDevice', () => {
  it('deviceId 相同才算自己的', () => {
    const snapshot = goodSnapshot()
    expect(isSnapshotOfDevice(snapshot, 'dev-aaaa')).toBe(true)
    expect(isSnapshotOfDevice(snapshot, 'dev-bbbb')).toBe(false)
  })

  it('空 deviceId 永不匹配（含两侧都空）', () => {
    expect(isSnapshotOfDevice(goodSnapshot(), '')).toBe(false)
    expect(isSnapshotOfDevice(goodSnapshot({ deviceId: '' }), '')).toBe(false)
    expect(isSnapshotOfDevice(goodSnapshot({ deviceId: 'dev-aaaa' }), '  ')).toBe(false)
  })
})

describe('墓碑 TTL 与 pruneSnapshot', () => {
  const tombstone = (deletedAt: number): SyncedPlaylist => ({
    id: 'gone',
    name: '已删',
    createdAt: 1,
    updatedAt: deletedAt,
    deletedAt,
    tracks: [],
  })
  const alive: SyncedPlaylist = { id: 'alive', name: '在', createdAt: 1, updatedAt: 2, tracks: [] }

  it('TTL 是 90 天', () => {
    expect(SYNC_TOMBSTONE_TTL_MS).toBe(90 * DAY)
  })

  it('恰好到 TTL 仍算未过期（边界用严格大于）', () => {
    expect(isTombstoneExpired(tombstone(NOW - SYNC_TOMBSTONE_TTL_MS), NOW)).toBe(false)
    expect(isTombstoneExpired(tombstone(NOW - SYNC_TOMBSTONE_TTL_MS - 1), NOW)).toBe(true)
  })

  it('活跃歌单不算墓碑', () => {
    expect(isTombstoneExpired(alive, NOW)).toBe(false)
  })

  it('清理只丢过期墓碑，活跃歌单与新鲜墓碑都留下', () => {
    const snapshot = goodSnapshot({
      playlists: [alive, tombstone(NOW - DAY), tombstone(NOW - SYNC_TOMBSTONE_TTL_MS - DAY)]
    })
    const pruned = pruneSnapshot(snapshot, NOW)

    expect(pruned.playlists.map((p) => p.id)).toEqual(['alive', 'gone'])
    expect(pruned.playlists[1].deletedAt).toBe(NOW - DAY)
    // 清理不是"用户改了歌单"，不能刷新时间戳
    expect(pruned.updatedAt).toBe(snapshot.updatedAt)
    expect(pruned.revision).toBe(snapshot.revision)
  })

  it('没有可清理的内容时返回同一个引用（上层可据此跳过写盘）', () => {
    const snapshot = goodSnapshot({ playlists: [alive, tombstone(NOW - DAY)] })
    expect(pruneSnapshot(snapshot, NOW)).toBe(snapshot)
  })
})

describe('isTombstoneExpired：deletedAt 的非墓碑取值（T6 / verifier S-7）', () => {
  const at = (over: Partial<SyncedPlaylist>): SyncedPlaylist => ({
    id: 'pl-x',
    name: 'x',
    createdAt: 1,
    updatedAt: NOW - DAY * 400,
    tracks: [],
    ...over,
  })

  it('deletedAt 为 0 不是墓碑：再老的歌单也不算过期', () => {
    // 「没删」的另一种 JSON 写法；修复前会被当成墓碑并回落到 updatedAt 起算 → 整条丢失
    expect(isTombstoneExpired(at({ deletedAt: 0 }), NOW)).toBe(false)
  })

  it('deletedAt 为 undefined / NaN / Infinity / 负数 都不算墓碑', () => {
    expect(isTombstoneExpired(at({}), NOW)).toBe(false)
    expect(isTombstoneExpired(at({ deletedAt: Number.NaN }), NOW)).toBe(false)
    expect(isTombstoneExpired(at({ deletedAt: Number.POSITIVE_INFINITY }), NOW)).toBe(false)
    expect(isTombstoneExpired(at({ deletedAt: -1 }), NOW)).toBe(false)
  })

  it('正有限数才起算：恰好 TTL 未过期，TTL+1 过期', () => {
    expect(isTombstoneExpired(at({ deletedAt: NOW - SYNC_TOMBSTONE_TTL_MS }), NOW)).toBe(false)
    expect(isTombstoneExpired(at({ deletedAt: NOW - SYNC_TOMBSTONE_TTL_MS - 1 }), NOW)).toBe(true)
  })

  it('pruneSnapshot 不丢 deletedAt: 0 的老歌单', () => {
    const snapshot = goodSnapshot({ playlists: [at({ id: 'keep', deletedAt: 0 })] })
    expect(pruneSnapshot(snapshot, NOW).playlists.map((p) => p.id)).toEqual(['keep'])
  })
})

describe('snapshotContentHash：跨设备可比的"内容"哈希（T6 / verifier B-1、N-1）', () => {
  const ref = (over: Record<string, unknown> = {}) => ({
    kind: 'local' as const,
    title: '歌',
    artist: '人',
    album: '',
    duration: 210,
    path: '/m/a.mp3',
    ...over,
  })

  const playlist = (over: Record<string, unknown> = {}) => ({
    id: 'pl-1',
    name: '通勤',
    createdAt: 10,
    updatedAt: 20,
    tracks: [ref()],
    ...over,
  })

  const snapshotOf = (
    deviceId: string,
    playlists: SyncSnapshot['playlists'],
    over: Partial<SyncSnapshot> = {}
  ): SyncSnapshot => goodSnapshot({ deviceId, playlists, ...over })

  it('内容不变时哈希不变：换 deviceId / deviceName / revision / 快照级 updatedAt 都不影响', () => {
    const a = snapshotOf('dev-aaaa', [playlist()], { revision: 1, updatedAt: 1_000 })
    const b = snapshotOf('dev-bbbb', [playlist()], { revision: 99, updatedAt: 9_999, deviceName: '另一台' })

    expect(snapshotContentHash(a)).toBe(snapshotContentHash(b))
  })

  it('歌单集合的**顺序**不参与（按 id 排序后再哈希）', () => {
    const p1 = playlist({ id: 'pl-1' })
    const p2 = playlist({ id: 'pl-2', name: '睡前' })

    expect(snapshotContentHash(snapshotOf('dev-a', [p1, p2]))).toBe(
      snapshotContentHash(snapshotOf('dev-b', [p2, p1]))
    )
  })

  it('改名 / 加曲 / 删曲 / 曲目换序 / 歌单删除时间变化 → 哈希都变', () => {
    const base = snapshotContentHash(snapshotOf('dev-a', [playlist()]))
    const hashOf = (playlists: SyncSnapshot['playlists']) =>
      snapshotContentHash(snapshotOf('dev-a', playlists))

    expect(hashOf([playlist({ name: '通勤（改）' })])).not.toBe(base)
    expect(hashOf([playlist({ tracks: [ref(), ref({ path: '/m/b.mp3' })] })])).not.toBe(base)
    expect(hashOf([playlist({ tracks: [] })])).not.toBe(base)
    expect(
      hashOf([playlist({ tracks: [ref({ path: '/m/b.mp3' }), ref()] })])
    ).not.toBe(base)
    expect(hashOf([playlist({ deletedAt: 30, updatedAt: 30 })])).not.toBe(base)
  })

  it('曲目内部顺序参与（用户手动排的序），但元数据不同也算内容不同', () => {
    const ordered = snapshotOf('dev-a', [playlist({ tracks: [ref({ path: '/m/a.mp3' }), ref({ path: '/m/b.mp3' })] })])
    const swapped = snapshotOf('dev-a', [playlist({ tracks: [ref({ path: '/m/b.mp3' }), ref({ path: '/m/a.mp3' })] })])
    const otherTitle = snapshotOf('dev-a', [playlist({ tracks: [ref({ title: '别的歌' })] })])

    expect(snapshotContentHash(ordered)).not.toBe(snapshotContentHash(swapped))
    expect(snapshotContentHash(ordered)).not.toBe(snapshotContentHash(otherTitle))
  })

  it('空快照也有稳定哈希（不同设备一致）', () => {
    const empty = snapshotContentHash(snapshotOf('dev-a', []))
    expect(empty).toBe(snapshotContentHash(snapshotOf('dev-b', [], { revision: 5 })))
    expect(empty).toMatch(/^[0-9a-z]+$/)
  })

  it('稳定的十六进制/36 进制串，同输入重复调用同结果', () => {
    const snapshot = snapshotOf('dev-a', [playlist()])
    expect(snapshotContentHash(snapshot)).toBe(snapshotContentHash(snapshot))
    expect(snapshotContentHash(snapshot)).toMatch(/^[0-9a-z]{1,13}$/)
  })
})

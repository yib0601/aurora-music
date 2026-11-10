/**
 * 曲目引用的双向转换（`docs/playlist-sync.md` §4 五档解析 / §15.2）。
 *
 * 为什么这批用例值得写细：解析结果是"歌单里那一行到底指哪首歌"。错一档的症状是
 * 用户在对端看到"同名但播不了/播错版本"，而且本地一切正常——只有跨设备才复现。
 * 所以每个档位都单独验证"命中"与"落空"，还额外验证"档位之间的优先级"：
 * 精确路径必须压过同名同长（否则同一首歌的两个版本会互相抢位）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildMatchIndex,
  resolveSyncTrackRef,
  toSyncTrackRef,
  type SyncMatchTrack,
} from '../trackRef'
import type { SyncTrackRef } from '../types'

function track(over: Partial<SyncMatchTrack> & { id: string }): SyncMatchTrack {
  return { title: '', artist: '', duration: 0, path: '', ...over }
}

const localRef = (path: string, over: Partial<Extract<SyncTrackRef, { kind: 'local' }>> = {}) =>
  ({ kind: 'local', path, title: '', artist: '', album: '', duration: 0, ...over }) as SyncTrackRef

describe('第 1 档：本机路径精确', () => {
  const index = buildMatchIndex([track({ id: 'a', path: '/Music/Album/A.mp3' })])

  it('原样路径命中', () => {
    expect(resolveSyncTrackRef(localRef('/Music/Album/A.mp3'), index)).toBe('a')
  })

  it('归一化后命中：反斜杠转斜杠 + 忽略大小写', () => {
    // 同一份歌单被 Windows 设备写进快照，本机是 Linux：路径分隔符与大小写都不同
    expect(resolveSyncTrackRef(localRef('C:\\Music\\Album\\A.MP3'), buildMatchIndex([
      track({ id: 'win', path: 'c:/music/album/a.mp3' })
    ]))).toBe('win')
  })

  it('大小写不同的两条记录中，原样路径优先于归一化命中', () => {
    const both = buildMatchIndex([
      track({ id: 'exact', path: '/Music/a.mp3' }),
      track({ id: 'normalized', path: '/music/A.mp3' })
    ])
    expect(resolveSyncTrackRef(localRef('/Music/a.mp3'), both)).toBe('exact')
  })

  it('路径完全不存在时落到后面的档位，而不是直接失败', () => {
    const withMeta = buildMatchIndex([
      track({ id: 'meta-hit', path: '/elsewhere/x.mp3', title: '歌', artist: '人', duration: 200 })
    ])
    expect(
      resolveSyncTrackRef(localRef('/Music/A.mp3', { title: '歌', artist: '人', duration: 200 }), withMeta)
    ).toBe('meta-hit')
  })
})

describe('第 2 档：同名 + 时长容差（trackIdentity 口径）', () => {
  const index = buildMatchIndex([
    track({ id: 't1', path: '/lib/1.mp3', title: '晴天', artist: '周杰伦', duration: 269 })
  ])

  it('时长差在 1 秒内算同一首', () => {
    expect(
      resolveSyncTrackRef(localRef('', { title: '晴天', artist: '周杰伦', duration: 268 }), index)
    ).toBe('t1')
    expect(
      resolveSyncTrackRef(localRef('', { title: ' 晴天 ', artist: '周杰伦', duration: 270 }), index)
    ).toBe('t1')
  })

  it('时长差超过容差不算', () => {
    expect(
      resolveSyncTrackRef(localRef('', { title: '晴天', artist: '周杰伦', duration: 275 }), index)
    ).toBeNull()
  })

  it('任一侧时长为 0（未知）不算相符——缺证据不等于相符', () => {
    expect(resolveSyncTrackRef(localRef('', { title: '晴天', artist: '周杰伦', duration: 0 }), index)).toBeNull()
    const unknownDuration = buildMatchIndex([
      track({ id: 'u', path: '/lib/2.mp3', title: '晴天', artist: '周杰伦', duration: 0 })
    ])
    expect(
      resolveSyncTrackRef(localRef('', { title: '晴天', artist: '周杰伦', duration: 269 }), unknownDuration)
    ).toBeNull()
  })

  it('歌手不同不算同一首（同名翻唱不能被认领）', () => {
    expect(
      resolveSyncTrackRef(localRef('', { title: '晴天', artist: '别人', duration: 269 }), index)
    ).toBeNull()
  })

  it('多份副本时优先能直接播的：本机文件 > 远端存储 > 纯在线', () => {
    const copies = buildMatchIndex([
      track({ id: 'a-online', path: '', title: '歌', artist: '人', duration: 100 }),
      track({ id: 'b-storage', path: 'webdav:lib-1/歌.mp3', title: '歌', artist: '人', duration: 100 }),
      track({ id: 'c-local', path: '/Music/歌.mp3', title: '歌', artist: '人', duration: 100 })
    ])
    expect(resolveSyncTrackRef(localRef('', { title: '歌', artist: '人', duration: 100 }), copies)).toBe('c-local')
  })
})

describe('第 3 档：storage 相对路径', () => {
  const tracks = [
    track({ id: 'lib1', path: 'webdav:lib-1/Music/Album/A.mp3', sourceId: 'lib-1' }),
    track({ id: 'lib2', path: 'webdav:lib-2/Music/Album/A.mp3', sourceId: 'lib-2' })
  ]

  const storageRef = (pluginId: string, relPath: string) =>
    ({ kind: 'storage', pluginId, relPath, title: '', artist: '', album: '', duration: 0 }) as SyncTrackRef

  it('同来源相对路径精确命中', () => {
    const index = buildMatchIndex(tracks, {
      storagePluginIdOf: (sourceId) => (sourceId === 'lib-2' ? 'smb' : 'webdav')
    })
    expect(resolveSyncTrackRef(storageRef('smb', 'Music/Album/A.mp3'), index)).toBe('lib2')
    expect(resolveSyncTrackRef(storageRef('webdav', 'Music/Album/A.mp3'), index)).toBe('lib1')
  })

  it('没有 pluginId 映射时，所有来源的精确路径都排在宽松匹配之前', () => {
    const looseFirst = [
      track({ id: 'aaa-loose', path: 'webdav:lib-2/Other/A.mp3' }),
      track({ id: 'zzz-exact', path: 'webdav:lib-1/Music/Album/A.mp3' })
    ]
    const index = buildMatchIndex(looseFirst)
    // lib-2 的 basename 也能蒙对，但 lib-1 是整条坐标相等：精确必须赢
    expect(resolveSyncTrackRef(storageRef('webdav', 'Music/Album/A.mp3'), index)).toBe('zzz-exact')
  })

  it('精确落空后走后缀/文件名宽松匹配', () => {
    const index = buildMatchIndex([track({ id: 'x', path: 'webdav:lib-1/别的目录/A.mp3' })])
    expect(resolveSyncTrackRef(storageRef('webdav', 'Music/Album/A.mp3'), index)).toBe('x')
  })

  it('相对路径里的反斜杠与前置斜杠会被归一化', () => {
    const index = buildMatchIndex(tracks)
    expect(resolveSyncTrackRef(storageRef('webdav', '\\Music\\Album\\A.mp3'), index)).toBe('lib1')
  })

  it('索引里没有远端来源时落空', () => {
    const localOnly = buildMatchIndex([track({ id: 'l', path: '/Music/A.mp3' })])
    expect(resolveSyncTrackRef(storageRef('webdav', 'Music/A.mp3'), localOnly)).toBeNull()
  })
})

describe('第 4 档：在线身份认领', () => {
  const online = new Map<string, string>([
    ['qq:abc', 'trk-qq'],
    ['bare-id', 'trk-bare']
  ])
  const index = buildMatchIndex([track({ id: 'local', path: '/Music/x.mp3' })], { online })
  const metaRef = (over: Partial<Extract<SyncTrackRef, { kind: 'meta' }>> = {}) =>
    ({ kind: 'meta', title: '', artist: '', album: '', duration: 0, ...over }) as SyncTrackRef

  it('带 platform 的键优先', () => {
    expect(resolveSyncTrackRef(metaRef({ onlineId: 'abc', platform: 'qq' }), index)).toBe('trk-qq')
  })

  it('只有裸 onlineId 时也能认领', () => {
    expect(resolveSyncTrackRef(metaRef({ onlineId: 'bare-id', platform: 'netease' }), index)).toBe('trk-bare')
  })

  it('认领表里没有就落空（在线搜索归引擎，不在纯函数里做）', () => {
    expect(resolveSyncTrackRef(metaRef({ onlineId: 'nope', platform: 'qq' }), index)).toBeNull()
  })
})

describe('第 5 档：全部落空返回 null', () => {
  const index = buildMatchIndex([track({ id: 'x', path: '/Music/a.mp3', title: '歌', artist: '人', duration: 100 })])

  it('五项线索全不匹配时返回 null，且不抛错', () => {
    const ref = {
      kind: 'storage',
      pluginId: 'webdav',
      relPath: '不存在的目录/别的歌.mp3',
      title: '另一首',
      artist: '另一个',
      album: '',
      duration: 300
    } as SyncTrackRef
    expect(resolveSyncTrackRef(ref, index)).toBeNull()
  })

  it('空索引不炸', () => {
    expect(resolveSyncTrackRef(localRef('/Music/a.mp3'), buildMatchIndex([]))).toBeNull()
  })
})

describe('toSyncTrackRef：本机曲目 → 快照引用', () => {
  it('空 path → meta，并带上在线身份字段', () => {
    const ref = toSyncTrackRef(
      track({
        id: 'a',
        title: '歌',
        artist: '人',
        album: '专辑',
        duration: 210,
        path: '',
        onlineId: 'abc',
        platform: 'qq',
        coverUrl: 'https://img/x.jpg'
      })
    )
    expect(ref).toEqual({
      kind: 'meta',
      title: '歌',
      artist: '人',
      album: '专辑',
      duration: 210,
      onlineId: 'abc',
      platform: 'qq',
      coverUrl: 'https://img/x.jpg'
    })
  })

  it('空 path 且没有在线身份时，meta 里不出现空串字段', () => {
    const ref = toSyncTrackRef(track({ id: 'a', title: '歌', artist: '人', path: '', onlineId: '  ' }))
    expect(ref).toEqual({ kind: 'meta', title: '歌', artist: '人', album: '', duration: 0 })
  })

  it('webdav: 坐标 → storage，pluginId 由调用方注入', () => {
    const ref = toSyncTrackRef(track({ id: 'a', path: 'webdav:lib-1/Music/A.mp3', title: '歌' }), (sourceId) =>
      sourceId === 'lib-1' ? 'sftp' : undefined
    )
    expect(ref).toMatchObject({ kind: 'storage', pluginId: 'sftp', relPath: 'Music/A.mp3' })
  })

  it('注入函数取不到时按 scheme 回落', () => {
    expect(toSyncTrackRef(track({ id: 'a', path: 'webdav:lib-9/A.mp3' }))).toMatchObject({
      kind: 'storage',
      pluginId: 'webdav',
      relPath: 'A.mp3'
    })
    expect(toSyncTrackRef(track({ id: 'a', path: 'web:session-1/A.mp3' }))).toMatchObject({
      kind: 'storage',
      pluginId: 'web',
      relPath: 'A.mp3'
    })
  })

  it('普通本机路径 → local，album 与时长原样带上', () => {
    const ref = toSyncTrackRef(track({ id: 'a', path: 'C:\\Music\\A.mp3', album: '专辑', duration: 100 }))
    expect(ref).toEqual({
      kind: 'local',
      path: 'C:\\Music\\A.mp3',
      title: '',
      artist: '',
      album: '专辑',
      duration: 100
    })
  })

  it('往返一致：本机曲目 → 引用 → 解析回同一条 id', () => {
    const source = track({ id: 'rt', path: '/Music/a.mp3', title: '歌', artist: '人', duration: 100 })
    const index = buildMatchIndex([source])
    expect(resolveSyncTrackRef(toSyncTrackRef(source), index)).toBe('rt')
  })
})

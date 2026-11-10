/**
 * 对抗性验证（verifier 任务 task-4）用的**临时证据测试**。
 *
 * 复核 docs/playlist-sync.md §4 的五档曲目解析优先级，以及跨设备的四个真实场景：
 *  1) 本机绝对路径不同（大小写 / Windows 反斜杠）仍能落回同一个 trackId；
 *  2) WebDAV 相对路径相同但 sourceId 不同（同插件不同挂载）；
 *  3) 只剩 title+artist+duration（时长容差 1s）；
 *  4) 同名不同版本（时长差 > 1s）不该被误配；
 *  5) 在线身份（onlineId+platform）优先于裸 onlineId。
 */
import { describe, expect, it } from 'vitest'
import { buildMatchIndex, resolveSyncTrackRef, toSyncTrackRef } from '../index'
import type { SyncMatchTrack, SyncTrackRef } from '../index'

const t = (over: Partial<SyncMatchTrack> = {}): SyncMatchTrack => ({
  id: 'local-1',
  title: '夜曲',
  artist: '周杰伦',
  duration: 226,
  path: '/music/album/01 song.flac',
  ...over,
})

const ref = (over: Partial<SyncTrackRef> = {}): SyncTrackRef => ({
  kind: 'local',
  path: '/music/album/01 song.flac',
  title: '夜曲',
  artist: '周杰伦',
  album: '',
  duration: 226,
  ...over,
})

describe('第一档：本机绝对路径（跨平台差异）', () => {
  it('路径大小写不同仍命中（第二遍归一化比较）', () => {
    const index = buildMatchIndex([t({ path: '/Music/Album/01 Song.flac' })])
    expect(resolveSyncTrackRef(ref({ path: '/music/album/01 song.flac' }), index)).toBe('local-1')
  })

  it('Windows 反斜杠路径与正斜杠互相命中', () => {
    const index = buildMatchIndex([t({ path: 'C:\\Music\\Album\\01 song.flac' })])
    const macStyle: SyncTrackRef = {
      kind: 'local',
      path: 'c:/music/album/01 song.flac',
      title: '夜曲',
      artist: '周杰伦',
      album: '',
      duration: 226,
    }
    expect(resolveSyncTrackRef(macStyle, index)).toBe('local-1')
  })
})

describe('第二档：title+artist+duration（时长容差）', () => {
  it('时长差 1s 内按元数据命中', () => {
    const index = buildMatchIndex([t({ path: '/other/place.flac', duration: 226.5 })])
    const remote = ref({ path: '/not/here.flac', duration: 227 })
    expect(resolveSyncTrackRef(remote, index)).toBe('local-1')
  })

  it('同名不同版本（时长差 > 1s）不误配，返回 null', () => {
    const index = buildMatchIndex([t({ path: '/other/place.flac', duration: 260 })])
    const remote = ref({ path: '/not/here.flac', duration: 226 })
    expect(resolveSyncTrackRef(remote, index)).toBeNull()
  })
})

describe('第三档：storage 相对路径（sourceId 不同但插件相同）', () => {
  it('同插件不同挂载的同一相对路径能命中', () => {
    const track = t({
      path: 'webdav:sid-new/Music/Album/01 song.flac',
      sourceId: 'sid-new',
    })
    const index = buildMatchIndex([track], {
      storagePluginIdOf: (sourceId) => (sourceId === 'sid-old' || sourceId === 'sid-new' ? 'webdav' : undefined),
    })
    const remote: SyncTrackRef = {
      kind: 'storage',
      pluginId: 'webdav',
      relPath: 'Music/Album/01 song.flac',
      title: '夜曲',
      artist: '周杰伦',
      album: '',
      duration: 226,
    }

    expect(resolveSyncTrackRef(remote, index)).toBe('local-1')
  })

  it('相对路径带反斜杠/前导斜杠也能命中', () => {
    const index = buildMatchIndex([t({ path: 'webdav:sid-new/Music/Album/01 song.flac', sourceId: 'sid-new' })], {
      storagePluginIdOf: () => 'webdav',
    })
    const remote: SyncTrackRef = {
      kind: 'storage',
      pluginId: 'webdav',
      relPath: '\\Music\\Album\\01 song.flac',
      title: '夜曲',
      artist: '周杰伦',
      album: '',
      duration: 226,
    }

    expect(resolveSyncTrackRef(remote, index)).toBe('local-1')
  })
})

describe('第四档：在线身份', () => {
  const onlineRef = (over: Partial<SyncTrackRef> = {}): SyncTrackRef =>
    ({
      kind: 'meta',
      onlineId: '003abc',
      platform: 'aurora',
      title: '别的歌',
      artist: '别人',
      album: '',
      duration: 180,
      ...over,
    }) as SyncTrackRef

  it('platform+onlineId 命中', () => {
    const index = buildMatchIndex([], {
      online: new Map([['aurora:003abc', 'local-1']]),
    })
    expect(resolveSyncTrackRef(onlineRef(), index)).toBe('local-1')
  })

  it('onlineId 相同但 platform 不同不误配', () => {
    const index = buildMatchIndex([], {
      online: new Map([['netease:003abc', 'local-1']]),
    })
    expect(resolveSyncTrackRef(onlineRef(), index)).toBeNull()
  })
})

describe('toSyncTrackRef：本地曲目如何编码', () => {
  it('storage 路径按来源 scheme 编码成相对路径（不把绝对路径带出去）', () => {
    const out = toSyncTrackRef(t({ path: 'webdav:sid-1/Music/01 song.flac', sourceId: 'sid-1' }), () => 'webdav')

    expect(out.kind).toBe('storage')
    if (out.kind === 'storage') {
      expect(out.pluginId).toBe('webdav')
      expect(out.relPath).toBe('Music/01 song.flac')
    }
  })

  it('没有任何路径的占位曲目编码成 meta，不伪造 local path', () => {
    const out = toSyncTrackRef(t({ path: '', id: 'sync:x' }))
    expect(out.kind).toBe('meta')
    expect('path' in out).toBe(false)
  })
})

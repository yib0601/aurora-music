import { describe, it, expect } from 'vitest'
import { buildLibraryBuckets, libraryBucketKey, matchLibraryDuration } from '../hallTrackDuration'
import type { Track } from '@/types'

/**
 * 歌单/榜单详情页的「源条目缺时长时用本地曲库补值」。
 *
 * 实测上报场景：乐源对无权益曲目回落兜底音源，条目 duration 恒为 0（用户歌单
 * 「周杰伦」5/5 条如此）。补上本地同曲的准确时长，播放器的提示音闸门才有
 * 「元数据 vs 实际时长」这条判据可用。
 *
 * 这里钉住四件事：能补上；只在本地确有同一首歌时才补；补不到必须是 0（不猜）；
 * 判定沿用 shared 的既有口径（见下方「括号备注」一例，本模块刻意不另立标准）。
 */
function libTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'lib-1',
    path: '/music/zhou.mp3',
    title: '反方向的钟',
    artist: '周杰伦',
    album: '',
    duration: 260,
    addedAt: 0,
    playCount: 0,
    liked: false,
    ...overrides,
  }
}

const bucketsOf = (tracks: Track[]) => buildLibraryBuckets(tracks)

describe('matchLibraryDuration', () => {
  it('歌名 + 歌手都命中：借本地时长', () => {
    const buckets = bucketsOf([libTrack()])
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, buckets)).toBe(260)
  })

  it('源歌名带括号备注 / 全角差异：归一化后仍命中（与歌单导入同一判据）', () => {
    const buckets = bucketsOf([libTrack({ title: '反方向的钟 (Remastered)' })])
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, buckets)).toBe(260)
  })

  it('歌手未知（源或本地为空）：标题分 + 中性分达标，照借', () => {
    const buckets = bucketsOf([libTrack({ artist: '' })])
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, buckets)).toBe(260)
  })

  it('本地没有同一首歌（归一化歌名连相似都谈不上）：返回 0，不瞎猜', () => {
    const buckets = bucketsOf([libTrack()])
    expect(matchLibraryDuration({ title: '完全另一首歌', artist: '另一个歌手' }, buckets)).toBe(0)
  })

  it('歌手对不上、标题只是包含关系：总分低于接受分，返回 0', () => {
    const buckets = bucketsOf([libTrack({ artist: '某翻唱歌手' })])
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, buckets)).toBe(0)
  })

  /**
   * 同名多版本（Live / Remix 后缀）。本模块**不另立版本判据**，直接沿用 shared 的
   * normalizeName：方括号/圆括号里的备注会被整段剥掉，所以 `反方向的钟 (Live)` 与
   * `反方向的钟` 判为同一首，其时长会被借用。
   *
   * 这是刻意的取舍——借来的时长只用于「元数据 vs 实际时长」这条闸门判据，用它换来
   * 的是「无权益回落条目时长恒为 0」这条通路能被堵住，代价仅限于「版本间时长差
   * 落在 10 秒内」的极窄窗口。反过来若在这里长出一套更严的版本判定，就会与歌单导入、
   * 封面匹配的既有口径分叉，同一首歌在不同功能里判定不一致更难解释。
   */
  it('括号里的版本备注被剥掉：Live/Remix 后缀仍视为同一首（与 shared 口径一致）', () => {
    expect(
      matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, bucketsOf([libTrack({ title: '反方向的钟 (Live)', duration: 320 })]))
    ).toBe(320)
    expect(
      matchLibraryDuration({ title: '反方向的钟 (Remix)', artist: '周杰伦' }, bucketsOf([libTrack({ duration: 260 })]))
    ).toBe(260)
  })

  it('不带括号的版本后缀属于歌名本身：差异过大则不匹配', () => {
    // 「反方向的钟 live 版」归一化后是「反方向的钟live版」，与「反方向的钟」是多出后缀的
    // 包含关系 → 标题分 0.9，歌手分 1 → 总分 1.9 达标，会借到时长（包含关系在阈值之上）
    expect(
      matchLibraryDuration({ title: '反方向的钟 live 版', artist: '周杰伦' }, bucketsOf([libTrack({ duration: 260 })]))
    ).toBe(260)
    // 而只是共用前缀的完全另一首歌（「反方向的钟声」）不该被当成同一首
    expect(
      matchLibraryDuration({ title: '反方向的钟声', artist: '另一个人' }, bucketsOf([libTrack()]))
    ).toBe(0)
  })

  it('本地候选自身时长为 0：跳过（0 是「未知」不是「0 秒」）', () => {
    const buckets = bucketsOf([libTrack({ duration: 0 })])
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, buckets)).toBe(0)
  })

  it('本地时长为负 / NaN：同样跳过，不把坏值当秒数', () => {
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, bucketsOf([libTrack({ duration: -3 })]))).toBe(0)
    expect(
      matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, bucketsOf([libTrack({ duration: Number.NaN })]))
    ).toBe(0)
  })

  it('同桶多候选时取总分最高的那首', () => {
    const buckets = bucketsOf([
      libTrack({ id: 'other', title: '反方向的钟 钢琴版', artist: '群星', duration: 100 }),
      libTrack({ id: 'exact', title: '反方向的钟', artist: '周杰伦', duration: 260 }),
    ])
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, buckets)).toBe(260)
  })

  it('空曲库 / 空标题：返回 0，不抛错', () => {
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, bucketsOf([]))).toBe(0)
    expect(matchLibraryDuration({ title: '', artist: '' }, bucketsOf([libTrack()]))).toBe(0)
  })

  it('返回值是 0 这条哨兵而非 null / undefined：调用方可直接用 `|| ` 落回原值', () => {
    const empty = bucketsOf([])
    expect(matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, empty)).toBe(0)
    expect(typeof matchLibraryDuration({ title: '反方向的钟', artist: '周杰伦' }, empty)).toBe('number')
  })
})

describe('libraryBucketKey / buildLibraryBuckets', () => {
  it('分桶键取归一化歌名前两字', () => {
    expect(libraryBucketKey('反方向的钟')).toBe('反方')
    expect(libraryBucketKey('  反方向的钟 (Remastered) ')).toBe('反方')
  })

  it('归一化后为空的条目不入桶', () => {
    const buckets = bucketsOf([libTrack({ title: '!!!', duration: 200 })])
    expect(buckets.size).toBe(0)
  })

  it('分桶不改变匹配结果：桶内顺序与曲库顺序一致', () => {
    const a = libTrack({ id: 'a' })
    const b = libTrack({ id: 'b' })
    expect(bucketsOf([a, b]).get('反方')).toEqual([a, b])
  })
})
import {
  normalizeName,
  parsePlaylistText,
  artistScore,
  scoreOnlineResult,
  matchTracksByNames,
} from '../importMatch'
import type { OnlineTrackSearchResult } from '../types'

describe('normalizeName', () => {
  it('去除空白并转小写', () => {
    expect(normalizeName('  Hotel California  ')).toBe('hotelcalifornia')
  })
  it('去除括号内的版本/备注说明', () => {
    expect(normalizeName('七里香 (Live)')).toBe('七里香')
    expect(normalizeName('七里香（伴奏）')).toBe('七里香')
  })
  it('全角转半角并去掉标点', () => {
    expect(normalizeName('ＮＥＷ　ＷＯＲＬＤ！')).toBe('newworld')
  })
  it('空串返回空串', () => {
    expect(normalizeName('   ')).toBe('')
  })
})

describe('parsePlaylistText', () => {
  it('解析「歌名 - 歌手」行', () => {
    const songs = parsePlaylistText('七里香 - 周杰伦\n晴天-周杰伦')
    expect(songs).toEqual([
      { title: '七里香', artist: '周杰伦' },
      { title: '晴天', artist: '周杰伦' },
    ])
  })
  it('剥离序号前缀（1. / 02、）', () => {
    const songs = parsePlaylistText('1. 七里香 - 周杰伦\n02、晴天 - 周杰伦')
    expect(songs.map((s) => s.title)).toEqual(['七里香', '晴天'])
  })
  it('无歌手分隔符时 artist 为空（只按标题匹配）', () => {
    expect(parsePlaylistText('七里香')).toEqual([{ title: '七里香', artist: '' }])
  })
  it('跳过空行与 URL 行', () => {
    const songs = parsePlaylistText('\nhttps://music.163.com/playlist?id=1\n晴天 - 周杰伦\n')
    expect(songs).toEqual([{ title: '晴天', artist: '周杰伦' }])
  })
  it('限制最多 1000 首，防止误粘超大文本', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `歌${i} - 某人`).join('\n')
    expect(parsePlaylistText(text).length).toBe(1000)
  })
})

describe('打分函数', () => {
  it('artistScore：一方为空视为未知，返回中性分', () => {
    expect(artistScore('', '周杰伦')).toBe(0.5)
    expect(artistScore('周杰伦', '')).toBe(0.5)
  })
  it('artistScore：包含关系得高分', () => {
    expect(artistScore('周杰伦', '周杰伦/温岚')).toBeGreaterThan(0.8)
  })
  it('scoreOnlineResult：标题不达标直接 0', () => {
    const r: OnlineTrackSearchResult = {
      id: 's-1', title: '夜曲', artist: '周杰伦', album: '', duration: 0,
      audioUrl: 'https://x/a.mp3', source: 's', sourceName: 's',
    }
    expect(scoreOnlineResult(r, { title: '七里香', artist: '周杰伦' })).toBe(0)
  })
  it('scoreOnlineResult：标题+歌手匹配得高分', () => {
    const r: OnlineTrackSearchResult = {
      id: 's-1', title: '七里香', artist: '周杰伦', album: '', duration: 0,
      audioUrl: 'https://x/a.mp3', source: 's', sourceName: 's',
    }
    expect(scoreOnlineResult(r, { title: '七里香', artist: '周杰伦' })).toBeGreaterThan(1)
  })
})

describe('matchTracksByNames', () => {
  const tracks = [
    { id: 't1', title: '七里香', artist: '周杰伦' },
    { id: 't2', title: '七里香', artist: '其他歌手' },
    { id: 't3', title: '晴天', artist: '周杰伦' },
  ].map((t) => ({ ...t, path: '', album: '', duration: 0, addedAt: 0, playCount: 0, liked: false }))

  it('标题+歌手精确匹配', () => {
    const res = matchTracksByNames([{ title: '七里香', artist: '周杰伦' }], tracks)
    expect(res.map((t) => t?.id)).toEqual(['t1'])
  })
  it('括号备注不影响匹配', () => {
    const res = matchTracksByNames([{ title: '晴天（Live）', artist: '周杰伦' }], tracks)
    expect(res.map((t) => t?.id)).toEqual(['t3'])
  })
  it('未匹配返回 null 占位', () => {
    expect(matchTracksByNames([{ title: '不存在的歌', artist: '' }], tracks)).toEqual([null])
  })
  it('同一首本地歌不会被两行重复占用', () => {
    const res = matchTracksByNames(
      [{ title: '晴天', artist: '周杰伦' }, { title: '晴天', artist: '周杰伦' }],
      tracks
    )
    expect(res[0]?.id).toBe('t3')
    expect(res[1]).toBeNull()
  })
})

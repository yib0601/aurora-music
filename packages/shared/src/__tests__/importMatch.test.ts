import {
  normalizeName,
  parsePlaylistText,
  artistScore,
  isDurationMismatch,
  scoreOnlineResult,
  matchTracksByNames,
  matchTracksByPaths,
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
  it('跳过含链接的分享文案整行（无解析源回退时不能把链接当歌名）', () => {
    const songs = parsePlaylistText('分享周杰伦创建的歌单「测试」：https://music.163.com/playlist?id=123 (来自网易云音乐)')
    expect(songs).toEqual([])
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

  /** 造一条候选（默认时长未知 = 0） */
  const candidate = (over: Partial<OnlineTrackSearchResult> = {}): OnlineTrackSearchResult => ({
    id: 's-1',
    title: '七里香',
    artist: '周杰伦',
    album: '',
    duration: 0,
    audioUrl: 'https://x/a.mp3',
    source: 's',
    sourceName: 's',
    ...over,
  })

  it('同名不同版本：目标没有版本标记、候选有 → 直接淘汰（哪怕标题与歌手全同）', () => {
    // 归一化会把「(变速版)」整段剥掉，「雨天 (变速版)」的标题分因此是满分；
    // 这道闸门就是为它加的（实测：274s 的原唱被判给 115s 的变速版）
    const speed = candidate({ title: '雨天 (变速版)', artist: '汪苏泷', duration: 115 })
    expect(scoreOnlineResult(speed, { title: '雨天', artist: '汪苏泷', duration: 274 })).toBe(0)
    expect(scoreOnlineResult(candidate({ title: '七里香 (Live)' }), { title: '七里香', artist: '周杰伦' })).toBe(0)
  })

  it('版本标记对齐才放行：目标自己就是该版本时，同标记候选仍是正主', () => {
    const score = scoreOnlineResult(candidate({ title: '七里香 (Live)' }), {
      title: '七里香 (Live)',
      artist: '周杰伦',
    })
    expect(score).toBeGreaterThan(1)
  })

  it('时长差得离谱 → 淘汰；任一侧未知则不判', () => {
    const want = { title: '雨天', artist: '汪苏泷', duration: 274 }
    expect(scoreOnlineResult(candidate({ title: '雨天', artist: '汪苏泷', duration: 115 }), want)).toBe(0)
    // 差 31s / 274s ≈ 11%（< 15%）→ 仍在容忍度内，不因这点差别否掉
    expect(scoreOnlineResult(candidate({ title: '雨天', artist: '汪苏泷', duration: 243 }), want)).toBeGreaterThan(1)
    // 目标没给时长（导入文本常见）或源没给时长：不做判据
    expect(scoreOnlineResult(candidate({ title: '雨天', artist: '汪苏泷', duration: 115 }), { title: '雨天', artist: '汪苏泷' })).toBeGreaterThan(1)
    expect(scoreOnlineResult(candidate({ title: '雨天', artist: '汪苏泷' }), want)).toBeGreaterThan(1)
  })

  it('isDurationMismatch：阈值取 max(20s, 15%)，长曲目按比例放宽', () => {
    expect(isDurationMismatch(0, 274)).toBe(false)
    expect(isDurationMismatch(115, 274)).toBe(true)
    expect(isDurationMismatch(243, 274)).toBe(false)
    // 8 分钟的交响乐：差 60s（≈12.5%）在比例容忍度内
    expect(isDurationMismatch(480, 540)).toBe(false)
    expect(isDurationMismatch(480, 620)).toBe(true)
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

/** 存储坐标匹配：重点是「不得跨来源串味」与精确匹配的优先级 */
describe('matchTracksByPaths', () => {
  const track = (id: string, path: string) => ({ id, path })

  it('整条路径相同优先于文件名相同', () => {
    const tracks = [
      track('nas-b', 'webdav:lib-b/Music/01 序曲.mp3'),
      track('nas-a', 'webdav:lib-a/Music/01 序曲.mp3'),
    ]
    // 同名文件在更靠前的来源里先出现，但精确路径必须赢
    const res = matchTracksByPaths(['webdav:lib-a/Music/01 序曲.mp3'], tracks)
    expect(res.map((t) => t.id)).toEqual(['nas-a'])
  })

  it('不同网络存储上的同名文件不会互相串味', () => {
    const tracks = [
      track('nas-b', 'webdav:lib-b/Music/01 序曲.mp3'),
      track('nas-a', 'webdav:lib-a/别的目录/01 序曲.mp3'),
    ]
    // 歌单来自 lib-a，但库里的 lib-a 曲目目录不同：只能按同来源内的文件名匹配到 nas-a
    const res = matchTracksByPaths(['webdav:lib-a/Music/01 序曲.mp3'], tracks)
    expect(res.map((t) => t.id)).toEqual(['nas-a'])
  })

  it('来源不同时连文件名都不匹配（宁可漏配也不绑错）', () => {
    const tracks = [track('nas-b', 'webdav:lib-b/Music/01 序曲.mp3')]
    expect(matchTracksByPaths(['webdav:lib-a/Music/01 序曲.mp3'], tracks)).toEqual([])
  })

  it('远端曲目不会被本机同名文件匹配，反之亦然', () => {
    const tracks = [
      track('local', '/home/me/Music/01 序曲.mp3'),
      track('remote', 'webdav:lib-a/Music/01 序曲.mp3'),
    ]
    expect(matchTracksByPaths(['/home/me/Music/01 序曲.mp3'], tracks).map((t) => t.id)).toEqual(['local'])
    expect(matchTracksByPaths(['webdav:lib-a/Music/01 序曲.mp3'], tracks).map((t) => t.id)).toEqual(['remote'])
  })

  it('本机路径仍支持换挂载点的宽松匹配（回归保护）', () => {
    const tracks = [track('local', '/mnt/new/Music/Album/a.mp3')]
    expect(matchTracksByPaths(['/home/old/Music/Album/a.mp3'], tracks).map((t) => t.id)).toEqual(['local'])
  })

  it('Windows 盘符路径不被误判为来源', () => {
    const tracks = [
      track('c1', 'C:\\Music\\a.mp3'),
      track('d1', 'D:\\Music\\a.mp3'),
    ]
    // 两者都视为「本机无来源」，宽松匹配按曲库顺序取第一个未占用的
    const res = matchTracksByPaths(['C:\\Music\\a.mp3'], tracks)
    expect(res.map((t) => t.id)).toEqual(['c1'])
  })

  it('反斜杠与大小写差异不影响匹配', () => {
    const tracks = [track('t1', 'C:\\Music\\A.MP3')]
    expect(matchTracksByPaths(['c:/music/a.mp3'], tracks).map((t) => t.id)).toEqual(['t1'])
  })

  it('同一首歌只被占用一次', () => {
    const tracks = [track('t1', '/m/a.mp3')]
    const res = matchTracksByPaths(['/m/a.mp3', '/m/a.mp3'], tracks)
    expect(res.map((t) => t.id)).toEqual(['t1'])
  })

  it('无法匹配的路径被跳过而不报错', () => {
    const tracks = [track('t1', '/m/a.mp3')]
    expect(matchTracksByPaths(['/other/zzz.mp3'], tracks)).toEqual([])
    expect(matchTracksByPaths([], tracks)).toEqual([])
  })
})

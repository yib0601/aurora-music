import { describe, it, expect } from 'vitest'
import type { OnlineTrackSearchResult } from '../types'
import {
  artistMatches,
  cleanTitleForQuery,
  firstArtistOf,
  hasKnownArtist,
  hasVersionMarker,
  hasVersionMarkerStrict,
  normalizeForMatch,
  pickCoverCandidate,
  titleVariants,
  tradToSimp,
} from '../coverMatch'

/** 真实歌源结果（本机 QQ_Music 源实测抓取，只保留判定相关字段） */
function cand(
  title: string,
  artist: string,
  duration: number,
  coverUrl: string | null,
  album = ''
): OnlineTrackSearchResult {
  return {
    id: `${title}-${artist}`,
    title,
    artist,
    album,
    duration,
    coverUrl: coverUrl ?? undefined,
    audioUrl: 'http://127.0.0.1:3201/s/xxx.mp3',
    source: 'src-my',
    sourceName: 'MY',
  }
}

const COVER = 'http://127.0.0.1:3201/c/abc'

/** 「杀死那个石家庄人 / 万能青年旅店 / 344.25s」——库内真实条目与真实检索结果 */
const SHIJIAZHUANG: OnlineTrackSearchResult[] = [
  cand('杀死那个石家庄人 (Live)', '万能青年旅店', 463, null),
  cand('杀死那个石家庄人 (2023「冀西南林路行」巡演上海站)', '万能青年旅店', 158, null),
  cand('万能青年旅店 (杀死那个石家庄人)', '一条小童童', 350, COVER, '留声地带'),
  cand('万能青年旅店《杀死那个石家庄人》', '醉美谋女郎', 344, COVER, '治愈歌曲背后的故事'),
  cand('杀死那个石家庄人 (Remix)', '陈嘉楠', 132, null),
  cand('杀死那个石家庄人 (2013长江迷笛音乐节)', '万能青年旅店', 463, null),
  cand('杀死那个石家庄人 (翻唱)', '万能青年旅店', 295, COVER, '老姜翻唱'),
  cand('张洲', '万能青年旅店', 263, COVER, '音乐肖像'),
  cand('喜剧', '万能青年旅店', 247, COVER, '废人们 都在忙什么？'),
  cand('万能青年旅店 (秦皇岛)', '是婉慧吖', 487, COVER, '城市的回音'),
  cand('不万能的喜剧 (Acoustic)', '万能青年旅店', 249, COVER, '废人们 都在忙什么？'),
  cand('万能青年旅店 (杀死那个石家庄人)', '语海小公主', 351, COVER, '你是年少的欢喜'),
  cand('杀死那个石家庄人', '就是南方凯', 183, COVER, '翻唱专辑'),
  cand('杀死那个石家庄人 (吉他版烟嗓版)', '小千禧', 70, COVER, '陪我到最后'),
  cand('Comedy', '万能青年旅店', 249, COVER, '废人们 都在忙什么？'),
  cand('那个石家庄人', '万能青年旅店', 325, COVER, '废人们 都在忙什么？'),
  cand('万能青年旅店-杀死那个石家庄人 (中流砥同志 bootleg)', '中流砥同志', 256, COVER),
  cand('万能青年旅店《洋鸟消夏录》', '一只柯豪呀', 77, COVER, '岁月流音'),
  cand('万能青年旅店-杀死那个石家庄人 (盛乾栩 remix)', '盛乾栩', 54, COVER),
  cand('万能青年旅店 (不万能的喜剧)', '是文川吖', 340, COVER),
]

/** 「浪漫手机 / 周杰伦 / 240s」——原版条目存在，应命中 */
const LANGMAN: OnlineTrackSearchResult[] = [
  cand('浪漫手机', '周杰伦', 240, COVER, '十一月的萧邦'),
  cand('浪漫手机 (​DJ IónaLee版)', '周杰伦', 189, null),
  cand('浪漫手机 (DJ 阿若版)', '周杰伦', 115, null),
  cand('浪漫手机 (升调版)', '周杰伦', 235, null),
  cand('菊花台+安静+晴天+上海一九四三+浪漫手机+暗号+听妈妈的话+星晴+简单爱', '周杰伦', 838, null),
  cand('红尘客栈', '周杰伦', 274, COVER, '十二新作'),
  cand('一路向北', '周杰伦', 294, COVER, 'J III MP3 Player'),
  cand('晴天', '周杰伦', 269, COVER, '叶惠美'),
]

describe('归一化与清洗', () => {
  it('繁→简映射用于歌名与歌手', () => {
    expect(tradToSimp('反方向的鐘')).toBe('反方向的钟')
    expect(normalizeForMatch('愛在西元前')).toBe('爱在西元前')
    expect(normalizeForMatch('周杰倫')).toBe(normalizeForMatch('周杰伦'))
  })

  it('剔除打标工具追加的演唱者后缀', () => {
    expect(cleanTitleForQuery('反方向的鐘－周杰倫', '周杰倫')).toBe('反方向的鐘')
    expect(cleanTitleForQuery('杀死那个石家庄人 - 万能青年旅店', '万能青年旅店')).toBe('杀死那个石家庄人')
    // 半角后缀是普通词（Live）时不能剔除，否则丢掉版本信息
    expect(cleanTitleForQuery('杀死那个石家庄人 - Live', '万能青年旅店')).toBe('杀死那个石家庄人 - Live')
  })

  it('第一艺术家取合唱标签首项', () => {
    expect(firstArtistOf('周杰倫、方文山')).toBe('周杰倫')
    expect(firstArtistOf('卡门,青年海伦')).toBe('卡门')
    expect(firstArtistOf('A feat. B')).toBe('A')
  })

  it('占位歌手视为未知', () => {
    expect(hasKnownArtist('未知艺术家')).toBe(false)
    expect(hasKnownArtist('')).toBe(false)
    expect(hasKnownArtist('万能青年旅店')).toBe(true)
  })

  it('标题变体覆盖「歌手 (歌名)」与书名号搬运条目', () => {
    expect(titleVariants('万能青年旅店 (杀死那个石家庄人)', '一条小童童')).toContain('杀死那个石家庄人')
    expect(titleVariants('万能青年旅店《杀死那个石家庄人》', '醉美谋女郎')).toContain('杀死那个石家庄人')
    expect(titleVariants('杀死那个石家庄人', '万能青年旅店')).toEqual(['杀死那个石家庄人'])
  })
})

describe('版本标记', () => {
  it('识别 live/remix/翻唱等版本词', () => {
    expect(hasVersionMarker('杀死那个石家庄人 (Live)')).toBe(true)
    expect(hasVersionMarker('杀死那个石家庄人 (翻唱)')).toBe(true)
    expect(hasVersionMarker('不万能的喜剧 (Acoustic)')).toBe(true)
    expect(hasVersionMarker('万能青年旅店-杀死那个石家庄人 (盛乾栩 remix)')).toBe(true)
    expect(hasVersionMarker('万能青年旅店《杀死那个石家庄人》')).toBe(true)
  })

  it('不误伤含年份或含「版」的正常歌名', () => {
    expect(hasVersionMarker('2002年的第一场雪')).toBe(false)
    expect(hasVersionMarker('杀死那个石家庄人')).toBe(false)
    expect(hasVersionMarker('我的地盘')).toBe(false)
  })

  it('专辑名标记不吃书名号', () => {
    expect(hasVersionMarkerStrict('老姜翻唱')).toBe(true)
    expect(hasVersionMarkerStrict('十一月的萧邦')).toBe(false)
  })
})

describe('歌手门禁', () => {
  it('一致、包含、歌手串任一段命中都算对上', () => {
    expect(artistMatches('万能青年旅店', '万能青年旅店')).toBe(true)
    expect(artistMatches('周杰伦', '周杰倫')).toBe(true)
    expect(artistMatches('周杰伦', '周杰伦、方文山')).toBe(true)
    expect(artistMatches('卡门', '卡门,青年海伦')).toBe(true)
  })

  it('蹭名条目对不上', () => {
    expect(artistMatches('万能青年旅店', '醉美谋女郎')).toBe(false)
    expect(artistMatches('万能青年旅店', '一条小童童')).toBe(false)
    expect(artistMatches('万能青年旅店', '')).toBe(false)
  })

  it('本地歌手未知时放行', () => {
    expect(artistMatches('', '任何人')).toBe(true)
    expect(artistMatches('未知艺术家', '任何人')).toBe(true)
  })
})

describe('pickCoverCandidate：真实检索结果', () => {
  it('杀死那个石家庄人：带封面的候选全是翻唱/搬运，返回 null 而不是贴错图', () => {
    const picked = pickCoverCandidate(SHIJIAZHUANG, {
      title: '杀死那个石家庄人',
      artist: '万能青年旅店',
      duration: 344.25333333333333,
    })
    // 旧实现会选中「万能青年旅店《杀死那个石家庄人》 / 醉美谋女郎」（标题相似且时长同档）
    expect(picked).toBeNull()
  })

  it('浪漫手机：命中原版条目本身', () => {
    const picked = pickCoverCandidate(LANGMAN, {
      title: '浪漫手机',
      artist: '周杰伦',
      duration: 240.0,
    })
    expect(picked?.title).toBe('浪漫手机')
    expect(picked?.artist).toBe('周杰伦')
    expect(picked?.album).toBe('十一月的萧邦')
  })

  it('本地为繁体标签时同样命中简体候选', () => {
    const picked = pickCoverCandidate(LANGMAN, {
      title: '浪漫手機',
      artist: '周杰倫',
      duration: 240,
    })
    expect(picked?.title).toBe('浪漫手机')
  })
})

describe('pickCoverCandidate：边界', () => {
  const target = { title: '永不失联的爱', artist: '周兴哲', duration: 260 }

  it('无候选返回 null', () => {
    expect(pickCoverCandidate([], target)).toBeNull()
  })

  it('候选无封面地址一律排除', () => {
    expect(pickCoverCandidate([cand('永不失联的爱', '周兴哲', 260, null)], target)).toBeNull()
  })

  it('非 http(s) 的封面地址排除', () => {
    expect(
      pickCoverCandidate([cand('永不失联的爱', '周兴哲', 260, 'file:///tmp/a.jpg')], target)
    ).toBeNull()
  })

  it('歌手对不上直接排除，即使标题完全一致', () => {
    expect(pickCoverCandidate([cand('永不失联的爱', '某某翻唱', 260, COVER)], target)).toBeNull()
  })

  it('「歌名+歌手」组合型标题且歌手正确可命中', () => {
    const picked = pickCoverCandidate([cand('周兴哲 (永不失联的爱)', '周兴哲', 260, COVER)], target)
    expect(picked?.title).toBe('周兴哲 (永不失联的爱)')
  })

  it('弱包含关系必须有时长佐证', () => {
    // 「那个石家庄人」包含于目标标题，但时长差 19s
    expect(
      pickCoverCandidate([cand('那个石家庄人', '万能青年旅店', 325, COVER)], {
        title: '杀死那个石家庄人',
        artist: '万能青年旅店',
        duration: 344,
      })
    ).toBeNull()
    // 时长接近则接受（现场现场版被标成短标题的常见情形）
    expect(
      pickCoverCandidate([cand('那个石家庄人', '万能青年旅店', 344, COVER)], {
        title: '杀死那个石家庄人',
        artist: '万能青年旅店',
        duration: 344,
      })?.title
    ).toBe('那个石家庄人')
  })

  it('带版本标记的同名候选不选', () => {
    expect(
      pickCoverCandidate([cand('永不失联的爱 (Live)', '周兴哲', 260, COVER)], target)
    ).toBeNull()
    expect(
      pickCoverCandidate([cand('永不失联的爱', '周兴哲', 260, COVER, '演唱会现场辑')], target)
    ).toBeNull()
  })

  it('歌手未知时仍按标题+时长挑选', () => {
    const picked = pickCoverCandidate([cand('永不失联的爱', '某某', 260, COVER)], {
      title: '永不失联的爱',
      artist: '未知艺术家',
      duration: 260,
    })
    expect(picked?.title).toBe('永不失联的爱')
  })

  it('优先与本地时长几乎一致的那一档', () => {
    const picked = pickCoverCandidate(
      [
        cand('永不失联的爱', '周兴哲', 305, COVER, '另一版'),
        cand('永不失联的爱', '周兴哲', 261, COVER, '原版专辑'),
      ],
      target
    )
    expect(picked?.album).toBe('原版专辑')
  })

  it('同名同歌手多条时，时长更近者胜出', () => {
    const picked = pickCoverCandidate(
      [
        cand('永不失联的爱', '周兴哲', 268, COVER, 'A'),
        cand('永不失联的爱', '周兴哲', 260, COVER, 'B'),
      ],
      target
    )
    expect(picked?.album).toBe('B')
  })
})
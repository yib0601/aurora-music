import {
  DURATION_MATCH_TOLERANCE,
  dedupeTracksForDisplay,
  isLocalCopy,
  preferTrackCopy,
} from '../trackIdentity'

type T = {
  id: string
  title: string
  artist: string
  duration: number
  sourceId?: string
  addedAt?: number
}

const track = (id: string, over: Partial<T> = {}): T => ({
  id,
  title: '反方向的钟',
  artist: '周杰伦',
  duration: 235,
  ...over,
})

describe('preferTrackCopy', () => {
  it('本机副本优先，与入库早晚无关', () => {
    const local = track('local', { addedAt: 999 })
    const remote = track('remote', { sourceId: 'lib-a', addedAt: 1 })
    expect(preferTrackCopy(local, remote).id).toBe('local')
    expect(preferTrackCopy(remote, local).id).toBe('local')
  })

  it('都是远端时取入库更早的（第一次扫描到的）', () => {
    const first = track('a', { sourceId: 'lib-a', addedAt: 100 })
    const second = track('b', { sourceId: 'lib-b', addedAt: 200 })
    expect(preferTrackCopy(second, first).id).toBe('a')
    expect(preferTrackCopy(first, second).id).toBe('a')
  })

  it('入库时间相同或缺失时按 id 稳定排序', () => {
    const a = track('aaa', { sourceId: 'lib-a', addedAt: 100 })
    const b = track('bbb', { sourceId: 'lib-b', addedAt: 100 })
    expect(preferTrackCopy(b, a).id).toBe('aaa')
    const noTime1 = track('aaa', { sourceId: 'lib-a' })
    const noTime2 = track('bbb', { sourceId: 'lib-b' })
    expect(preferTrackCopy(noTime2, noTime1).id).toBe('aaa')
  })

  it('isLocalCopy 以 sourceId 为准', () => {
    expect(isLocalCopy(track('x'))).toBe(true)
    expect(isLocalCopy(track('x', { sourceId: 'lib-a' }))).toBe(false)
  })
})

describe('dedupeTracksForDisplay', () => {
  it('歌名+歌手+时长全同 → 合并，本机副本胜出', () => {
    const tracks = [
      track('nas', { sourceId: 'lib-a', addedAt: 1 }),
      track('local', { addedAt: 500 }),
    ]
    const res = dedupeTracksForDisplay(tracks)
    expect(res.tracks.map((t) => t.id)).toEqual(['local'])
    expect(res.hidden).toBe(1)
  })

  it('只剩远端时保留第一次扫描到的那份', () => {
    const tracks = [
      track('nas-b', { sourceId: 'lib-b', addedAt: 300 }),
      track('nas-a', { sourceId: 'lib-a', addedAt: 100 }),
    ]
    expect(dedupeTracksForDisplay(tracks).tracks.map((t) => t.id)).toEqual(['nas-a'])
  })

  it('时长差在容差内视为同一首', () => {
    const tracks = [
      track('local', { duration: 235.02 }),
      track('nas', { sourceId: 'lib-a', duration: 235.9 }),
    ]
    const res = dedupeTracksForDisplay(tracks)
    expect(res.tracks.map((t) => t.id)).toEqual(['local'])
  })

  it('时长差超出容差视为不同曲目（原版 / 加长版）', () => {
    const tracks = [
      track('short', { duration: 235 }),
      track('long', { sourceId: 'lib-a', duration: 300 }),
    ]
    const res = dedupeTracksForDisplay(tracks)
    expect(res.tracks.map((t) => t.id)).toEqual(['short', 'long'])
    expect(res.hidden).toBe(0)
  })

  it('歌名相同但歌手不同 → 不合并', () => {
    const tracks = [
      track('a', { artist: '周杰伦' }),
      track('b', { artist: '其他歌手', sourceId: 'lib-a' }),
    ]
    expect(dedupeTracksForDisplay(tracks).tracks.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('保留 (Live)/(Remix) 等版本差异，不做去括号归一化', () => {
    const tracks = [
      track('studio', { title: '七里香' }),
      track('live', { title: '七里香 (Live)', sourceId: 'lib-a' }),
    ]
    expect(dedupeTracksForDisplay(tracks).tracks.map((t) => t.id)).toEqual(['studio', 'live'])
  })

  it('任一侧时长为 0（解析失败）不算"时长相同"', () => {
    const tracks = [
      track('local', { duration: 0 }),
      track('nas', { sourceId: 'lib-a', duration: 235 }),
    ]
    expect(dedupeTracksForDisplay(tracks).tracks.map((t) => t.id)).toEqual(['local', 'nas'])
  })

  it('歌名/歌手的大小写与多余空白不影响判定', () => {
    const tracks = [
      track('local', { title: '  Reverse   Clock ', artist: 'JAY' }),
      track('nas', { sourceId: 'lib-a', title: 'reverse clock', artist: 'jay ' }),
    ]
    expect(dedupeTracksForDisplay(tracks).tracks.map((t) => t.id)).toEqual(['local'])
  })

  it('三份及以上副本只留一份', () => {
    const tracks = [
      track('nas-b', { sourceId: 'lib-b', addedAt: 300 }),
      track('nas-a', { sourceId: 'lib-a', addedAt: 100 }),
      track('local', { addedAt: 900 }),
    ]
    const res = dedupeTracksForDisplay(tracks)
    expect(res.tracks.map((t) => t.id)).toEqual(['local'])
    expect(res.hidden).toBe(2)
  })

  it('保持原有顺序，只摘掉落选副本', () => {
    const tracks = [
      track('keep-1', { title: 'A' }),
      track('dup-1', { title: 'B', sourceId: 'lib-a' }),
      track('keep-2', { title: 'B' }),
      track('keep-3', { title: 'C' }),
    ]
    // B 的落选者是 dup-1，B 的胜出者 keep-2 保持它在数组里的位置
    expect(dedupeTracksForDisplay(tracks).tracks.map((t) => t.id)).toEqual(['keep-1', 'keep-2', 'keep-3'])
  })

  it('空数组与单曲不做事、不算隐藏', () => {
    expect(dedupeTracksForDisplay([])).toEqual({ tracks: [], hidden: 0, groups: [] })
    const one = [track('only')]
    expect(dedupeTracksForDisplay(one)).toEqual({ tracks: one, hidden: 0, groups: [] })
  })

  it('groups 明细：逐组给出保留与隐藏副本', () => {
    const tracks = [
      track('nas-b', { sourceId: 'lib-b', addedAt: 300 }),
      track('nas-a', { sourceId: 'lib-a', addedAt: 100 }),
      track('local', { addedAt: 900 }),
      track('other', { title: '晴天' }),
    ]
    const res = dedupeTracksForDisplay(tracks)
    expect(res.groups).toHaveLength(1)
    expect(res.groups[0].kept.id).toBe('local')
    // 隐藏副本保持传入顺序
    expect(res.groups[0].hiddenCopies.map((t) => t.id)).toEqual(['nas-b', 'nas-a'])
  })

  it('groups 只含真实重复组，无重复时为空', () => {
    const res = dedupeTracksForDisplay([
      track('a', { title: 'A' }),
      track('b', { title: 'B', sourceId: 'lib-a' }),
    ])
    expect(res.groups).toEqual([])
  })

  it('无重复时原样返回同一引用（避免无谓的重渲染）', () => {
    const tracks = [track('a', { title: 'A' }), track('b', { title: 'B' })]
    expect(dedupeTracksForDisplay(tracks).tracks).toBe(tracks)
  })

  it('容差边界：恰好等于容差算同一首，略超则不算', () => {
    const at = (d: number, id: string) => [track('local', { duration: d }), track(id, { sourceId: 'lib-a', duration: d + DURATION_MATCH_TOLERANCE })]
    expect(dedupeTracksForDisplay(at(200, 'x')).hidden).toBe(1)
    expect(dedupeTracksForDisplay(at(200, 'x').map((t, i) => (i === 1 ? { ...t, duration: 200 + DURATION_MATCH_TOLERANCE + 0.01 } : t))).hidden).toBe(0)
  })
})

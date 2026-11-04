import { describe, expect, it } from 'vitest'
import { buildFillPlan, splitLyricTokens } from '../lyricFill'

describe('splitLyricTokens：切分不改变原文', () => {
  it('拼回去与原文逐字相同（空白/标点并入前一个单元）', () => {
    const cases = [
      '當時無法為你寫的那首歌 卻是我永遠的遺憾當愛逝去',
      '夜明けの街を歩いて',
      "La la la, sing it with me, don't stop",
      '把这段旋律留在你身边（副歌）',
      '123 ABC 混合 mixed 文本',
    ]
    for (const text of cases) {
      expect(splitLyricTokens(text).join('')).toBe(text)
    }
  })

  it('汉字/假名逐字，拉丁与其它字母文字按词', () => {
    expect(splitLyricTokens('君の声が聞こえる')).toEqual([
      '君',
      'の',
      '声',
      'が',
      '聞',
      'こ',
      'え',
      'る',
    ])
    expect(splitLyricTokens('Hello world')).toEqual(['Hello ', 'world'])
    expect(splitLyricTokens("don't stop")).toEqual(["don't ", 'stop'])
    // 非拉丁但以空格分词的文字不能被并成一个 token（否则折行后填充又是一行亮一行暗）
    expect(splitLyricTokens('Привет мир')).toEqual(['Привет ', 'мир'])
    expect(splitLyricTokens('γεια σου')).toEqual(['γεια ', 'σου'])
  })

  it('行首标点不会丢', () => {
    expect(splitLyricTokens('（啊）').join('')).toBe('（啊）')
    expect(splitLyricTokens('（啊）')[0]).toBe('（')
  })
})

describe('buildFillPlan：普通 LRC 按字数摊时长', () => {
  const line = { time: 10, text: '當時無法為你寫的那首歌 卻是我永遠的遺憾當愛逝去' }

  it('单元数与 token 数一致，区间单调递增且首尾落在行起点之后', () => {
    const plan = buildFillPlan(line, 40)
    expect(plan.segments).toHaveLength(plan.tokens.length)
    const first = plan.segments[0]
    expect(first.start).toBeCloseTo(10, 5)
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i].start).toBeGreaterThanOrEqual(plan.segments[i - 1].start)
      expect(plan.segments[i].end).toBeGreaterThanOrEqual(plan.segments[i].start)
    }
  })

  it('长空档不会把整行拖满整个间奏：估时短于行窗口', () => {
    const plan = buildFillPlan(line, 60)
    const end = plan.segments[plan.segments.length - 1].end
    // 26 个可见字 / 4.2 ≈ 6.2s，而不是 50s 的间奏长度
    expect(end - line.time).toBeLessThan(10)
    expect(end - line.time).toBeGreaterThan(3)
  })

  it('短窗口以窗口为准，不会越界到下一行', () => {
    const plan = buildFillPlan({ time: 10, text: '一二三四五六七八九十' }, 11.5)
    const end = plan.segments[plan.segments.length - 1].end
    expect(end).toBeLessThanOrEqual(11.5 + 1e-9)
    expect(end).toBeGreaterThan(11.4)
  })

  it('每个单元都有可观测时长（纯标点也不为零）', () => {
    const plan = buildFillPlan({ time: 0, text: '，。' }, 10)
    for (const segment of plan.segments) {
      expect(segment.end).toBeGreaterThan(segment.start)
    }
  })
})

describe('buildFillPlan：增强 LRC 用词元自带时间戳', () => {
  it('词元区间取相邻时间戳，末词以 1.2s 收尾且不越过下一行', () => {
    const line = {
      time: 12,
      text: 'Hello world',
      words: [
        { time: 12, text: 'Hello ' },
        { time: 12.5, text: 'world' },
      ],
    }
    const plan = buildFillPlan(line, 15)
    expect(plan.tokens).toEqual(['Hello ', 'world'])
    expect(plan.segments[0]).toEqual({ start: 12, end: 12.5 })
    expect(plan.segments[1].start).toBe(12.5)
    expect(plan.segments[1].end).toBeCloseTo(13.7, 5)
  })

  it('下一行很近时末词收尾被行结束时刻截断', () => {
    const line = {
      time: 12,
      text: 'a b',
      words: [
        { time: 12, text: 'a ' },
        { time: 12.5, text: 'b' },
      ],
    }
    const plan = buildFillPlan(line, 12.8)
    expect(plan.segments[1].end).toBeCloseTo(12.8, 5)
  })
})

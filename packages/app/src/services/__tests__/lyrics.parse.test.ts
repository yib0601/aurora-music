/**
 * parseLRC 的逐字（增强 LRC）解析与行时间窗单测。
 *
 * 为什么单独一个文件：`lyrics.service.test.ts` 打桩的是「取词链路」（平台层、缓存、
 * 去重），而这里是纯函数行为。两者共用同一份 platform / libraryStore 打桩，
 * 因为 service 模块顶层会 import 它们（node 环境下不能真加载 Capacitor 桥）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/platform', () => ({
  platform: {
    readLyrics: vi.fn(async () => null),
    saveLyrics: vi.fn(async () => 'lyrics.lrc'),
    searchLyrics: vi.fn(async () => null),
  },
}))
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: { getState: () => ({ onlineSources: [] }) },
}))

import { findActiveLine, lyricLineWindow, parseLRC } from '../lyrics.service'

describe('parseLRC：标准行级标签', () => {
  it('解析时间并剥掉标签', () => {
    const lines = parseLRC('[00:01.50]第一句\n[00:05.00]第二句')
    expect(lines.map((line) => line.text)).toEqual(['第一句', '第二句'])
    expect(lines[0].time).toBeCloseTo(1.5, 5)
    expect(lines[1].time).toBeCloseTo(5, 5)
  })

  it('一行多个时间戳展开成多条（副歌复用）', () => {
    const lines = parseLRC('[00:10.00][00:40.00]副歌')
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.time)).toEqual([10, 40])
    expect(lines.every((line) => line.text === '副歌')).toBe(true)
  })

  it('分钟支持三位数（现场版 / 播客），毫秒支持 1~3 位', () => {
    const lines = parseLRC('[100:02.5]超长音频')
    expect(lines[0].time).toBeCloseTo(6002.5, 5)
    const words = parseLRC('[00:01.05]<00:01.050>a<00:01.500>b')
    expect(words[0].words?.[0].time).toBeCloseTo(1.05, 5)
  })

  it('纯文本歌词按 5 秒一行兜底，并带上行时间窗', () => {
    const lines = parseLRC('没有时间轴的第一行\n没有时间轴的第二行')
    expect(lines.map((line) => line.time)).toEqual([0, 5])
    expect(lines[0].endTime).toBe(5)
  })

  it('空行与纯标签行被丢弃', () => {
    const lines = parseLRC('[00:01.00]\n\n[00:02.00]有字')
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('有字')
  })
})

describe('parseLRC：逐字时间轴（增强 LRC）', () => {
  it('尖括号标签产出词元，行时间取方括号', () => {
    const lines = parseLRC(
      '[00:12.00]<00:12.00>Hello <00:12.50>world\n[00:15.00]下一句'
    )
    expect(lines).toHaveLength(2)
    const first = lines[0]
    expect(first.time).toBe(12)
    expect(first.words?.map((word) => word.text)).toEqual(['Hello ', 'world'])
    expect(first.words?.map((word) => word.time)).toEqual([12, 12.5])
    // 行结束时刻取下一行起点，供整行填充与末词收尾使用
    expect(first.endTime).toBe(15)
  })

  it('整行只有尖括号标签时，首个词元时间即行时间', () => {
    const lines = parseLRC('<00:03.00>你<00:03.20>好<00:03.60>吗')
    expect(lines).toHaveLength(1)
    expect(lines[0].time).toBeCloseTo(3, 5)
    expect(lines[0].words?.map((word) => word.text)).toEqual(['你', '好', '吗'])
  })

  it('首个标签前的残留文字并入首词（不全丢）', () => {
    const lines = parseLRC('[00:01.00]La <00:01.00>la <00:01.60>land')
    expect(lines[0].words?.map((word) => word.text)).toEqual(['La la ', 'land'])
  })

  it('纯空白词元并回前一个词：词元拼回去必须等于整行文字', () => {
    const lines = parseLRC('[00:01.00]<00:01.00>啊<00:01.10> <00:01.20>哦')
    expect(lines[0].words).toHaveLength(2)
    expect(lines[0].words?.map((word) => word.text)).toEqual(['啊 ', '哦'])
    // 当前行按词元渲染、相邻行按 line.text 渲染，两者折行位置必须一致
    expect(lines[0].words?.map((word) => word.text).join('')).toBe(lines[0].text)
  })

  it('词元时间戳乱序时钳成非降序', () => {
    const lines = parseLRC('[00:01.00]<00:02.00>后<00:01.00>前')
    expect(lines[0].words?.map((word) => word.time)).toEqual([2, 2])
  })

  it('一行多时间戳时退化为纯行级（逐字轴归属不明确）', () => {
    const lines = parseLRC('[00:10.00][00:40.00]<00:10.00>副歌')
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.words === undefined)).toBe(true)
  })

  it('同一时间的多条（原文 + 译文）共用下一行起点', () => {
    const lines = parseLRC('[00:01.00]原文\n[00:01.00]translation\n[00:04.00]下一句')
    expect(lines.map((line) => line.endTime)).toEqual([4, 4, undefined])
  })
})

describe('lyricLineWindow：行时间窗', () => {
  it('有下一行时直接用 endTime', () => {
    const lines = parseLRC('[00:01.00]甲\n[00:04.00]乙')
    expect(lyricLineWindow(lines, 0)).toEqual({ start: 1, end: 4 })
  })

  it('末行按「最后一个词元 + 1.2s」兜底', () => {
    const lines = parseLRC('[00:10.00]<00:10.00>a<00:11.00>b')
    expect(lyricLineWindow(lines, 0)).toEqual({ start: 10, end: 12.2 })
  })

  it('末行无逐字轴时按「行首 + 6s」兜底', () => {
    const lines = parseLRC('[00:10.00]只有一句')
    expect(lyricLineWindow(lines, 0)).toEqual({ start: 10, end: 16 })
  })

  it('越界索引返回零宽窗，不抛错', () => {
    expect(lyricLineWindow([], 3)).toEqual({ start: 0, end: 0 })
  })
})

describe('findActiveLine：与逐字行共存', () => {
  const lines = parseLRC('[00:01.00]<00:01.00>a<00:01.50>b\n[00:03.00]c')

  it('行中途仍停在当前行', () => {
    expect(findActiveLine(lines, 2.4)).toBe(0)
  })

  it('第一行之前返回 -1（前奏态）', () => {
    expect(findActiveLine(lines, 0.2)).toBe(-1)
  })

  it('切到下一行', () => {
    expect(findActiveLine(lines, 3.2)).toBe(1)
  })
})

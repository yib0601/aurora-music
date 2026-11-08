import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CoverPlaceholder } from '@/components/common/CoverPlaceholder'

/**
 * 无封面占位图（`CoverPlaceholder`）的行为契约。
 *
 * 它不是纯装饰：歌源里有一批条目上游就没有专辑（UGC 翻唱/搬运，`coverUrl` 为空），
 * 列表与队列会成片显示占位图，所以这里锁住三件会影响观感的事：
 *   1) 同一首歌在任何一次渲染里拿到**同一张图**（颜色由歌名+歌手稳定派生，不能随机）；
 *   2) 同名不同歌手/不同版本要能区分开（不能全站一张图）；
 *   3) 取不到歌名时退回音符字形，而不是渲染成空白格子。
 *
 * 用 `renderToStaticMarkup` 而非 jsdom：渲染层单测跑在 node 环境（见 vitest.config.ts），
 * 这里只需要静态产物里的渐变与字形，不需要真实 DOM。
 */
function markupOf(title?: string, artist?: string): string {
  return renderToStaticMarkup(createElement(CoverPlaceholder, { title, artist }))
}

/** 从产物里取出渐变主色（形如 `hsl(168, 34%, 27%)`） */
function hueOf(markup: string): string {
  return /hsl\((\d+),/.exec(markup)?.[1] ?? ''
}

/** 从产物里取出字形文本 */
function glyphOf(markup: string): string {
  return /<text[^>]*>([^<]*)<\/text>/.exec(markup)?.[1] ?? ''
}

describe('CoverPlaceholder', () => {
  it('同一首歌两次渲染得到同一张图（颜色与字形都稳定）', () => {
    const a = markupOf('晴天', '周杰伦')
    const b = markupOf('晴天', '周杰伦')
    expect(hueOf(a)).toBe(hueOf(b))
    expect(glyphOf(a)).toBe(glyphOf(b))
    // 唯一允许的差异是 useId 派生的渐变 id
    expect(a.replace(/cp-[^"]+/g, 'cp')).toBe(b.replace(/cp-[^"]+/g, 'cp'))
  })

  it('同名不同歌手能区分（同名翻唱不该全站一张图）', () => {
    expect(hueOf(markupOf('晴天', '周杰伦'))).not.toBe(hueOf(markupOf('晴天', '孙燕姿')))
  })

  it('取歌名首字，拉丁字母转大写', () => {
    expect(glyphOf(markupOf('晴天', '周杰伦'))).toBe('晴')
    expect(glyphOf(markupOf('hello world', 'adele'))).toBe('H')
    // 前导空白不该吃掉字形
    expect(glyphOf(markupOf('  夜曲', '周杰伦'))).toBe('夜')
  })

  it('没有歌名时退回音符字形', () => {
    expect(glyphOf(markupOf(undefined, '周杰伦'))).toBe('♪')
    expect(glyphOf(markupOf('   ', ''))).toBe('♪')
  })

  it('底色只用调色板内的色相（不会抽出橄榄/土黄这类脏色）', () => {
    const allowed = ['168', '190', '210', '232', '258', '286', '316', '342']
    for (const [title, artist] of [
      ['晴天', '周杰伦'],
      ['七月七爱恋', '网络歌手'],
      ['七月七爱恋', '白衣kone'],
      ['Faded', 'Alan Walker'],
      ['', ''],
    ] as const) {
      expect(allowed).toContain(hueOf(markupOf(title, artist)))
    }
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * LyricsView 加载触发与竞态守卫的**结构哨兵**。
 *
 * 为什么是「读源码做结构断言」而不是组件测试：
 *   本仓 vitest 配置是 `environment: 'node'`，且 include 只匹配 `src` 下的 `.test.ts`；
 *   依赖里没有 jsdom / happy-dom / @testing-library/react，全仓也没有任何 `.test.tsx`。
 *   在没有 DOM 环境的前提下，挂载组件是不可行的——而这条不变量**恰恰是本次缺陷的根因**：
 *   `currentTrack` 在播放中会被封面补齐（CoverImage 的 syncPlayerStoreCover）、取址回填、
 *   persist rehydrate 换成新对象，一旦依赖数组回到「依赖对象引用」，每次字段没变的更新
 *   都会重跑加载，而重跑里一次失败/超时的搜索就会把已经显示出来的歌词清成「暂无歌词」。
 *
 *   经实测（2026-10-13 独立验证）：把依赖数组改回 `[loadKey, currentTrack, trackId, lyricsText]`
 *   后，`pnpm --filter @aurora/app test` 与 `tsc` **全绿** —— 即该回归当时没有任何哨兵。
 *   所以这里退而求其次：把「依赖数组里不得出现对象引用」与「竞态守卫必须存在」写成
 *   可自动执行的断言。它抓的是结构，不是运行时行为；一旦有 DOM 环境，应当升级为真正的
 *   组件测试（届时本文件可删）。
 *
 * 断言的稳健性取舍：只匹配语义片段（标识符与依赖数组内容），不做整文件逐字比对，
 * 这样重构注释、调整缩进、增删无关语句都不会误报。
 */

const viewPath = path.resolve(__dirname, '..', 'LyricsView.tsx')
const source = fs.readFileSync(viewPath, 'utf8')

/** 取加载 effect 的依赖数组文本（该 effect 是本文件里唯一含 loadKey 的那个） */
function loadEffectDeps(): string {
  const match = source.match(/\}, \[([^\]]*)\]\)/g)
  if (!match) throw new Error('未找到任何 effect 依赖数组，文件结构可能已大改')
  const withLoadKey = match.filter((m) => m.includes('loadKey'))
  if (withLoadKey.length !== 1) {
    throw new Error(`含 loadKey 的 effect 依赖数组应恰好 1 个，实际 ${withLoadKey.length} 个`)
  }
  return withLoadKey[0]
}

describe('LyricsView：加载触发只由原始值门控（回归哨兵）', () => {
  it('存在按「曲目 id + 外部歌词」派生的加载键', () => {
    expect(source).toMatch(/lyricsLoadKey\(currentTrack,\s*lyricsText\)/)
  })

  it('加载 effect 的依赖数组里不含 currentTrack 对象引用', () => {
    const deps = loadEffectDeps()
    // 这是本次缺陷的核心：依赖对象引用会让「字段没变、只是新引用」的更新也重跑加载
    expect(deps).not.toMatch(/\bcurrentTrack\b/)
    expect(deps).toMatch(/\bloadKey\b/)
  })

  it('加载 effect 的依赖数组里不含 track / trackRef 等对象来源', () => {
    const deps = loadEffectDeps()
    expect(deps).not.toMatch(/\btrack\b/)
    expect(deps).not.toMatch(/\btrackRef\b/)
    // ref 本身不是依赖项，出现即说明写法退化
    expect(deps).not.toMatch(/\.current\b/)
  })

  it('曲目完整字段经 ref 传递（加载 effect 不直接读 currentTrack）', () => {
    expect(source).toMatch(/const trackRef = useRef\(currentTrack\)/)
    expect(source).toMatch(/trackRef\.current = currentTrack/)
  })
})

describe('LyricsView：竞态与降级守卫（回归哨兵）', () => {
  it('存在 cancelled 竞态守卫，且结果落地前先判它', () => {
    expect(source).toMatch(/let cancelled = false/)
    expect(source).toMatch(/if \(cancelled\) return/)
    // 清理函数必须把 cancelled 置真，否则过期结果会落到新曲目上
    expect(source).toMatch(/return \(\) => \{\s*cancelled = true\s*\}/)
  })

  it('结果落地走 nextLyricsText（同曲空结果不降级为空态）', () => {
    expect(source).toMatch(/nextLyricsText\(prev,\s*lrc\)/)
  })

  it('切歌（id 变化）时显式清空，避免 A 歌歌词挂到 B 歌上', () => {
    // 「不降级」这条修复的正确性寄生在「切歌清空 + 竞态守卫」两者同时存在上：
    // 少了任一条，nextLyricsText 会把上一首的歌词留在新曲目上
    expect(source).toMatch(/setLoadedLyrics\(''\)/)
  })

  it('加载链存在拒绝分支处理，loading 不会永久停留', () => {
    // 上游/本地缓存写失败时不得让「正在搜索歌词…」卡住
    expect(source).toMatch(/\.catch\(/)
  })
})
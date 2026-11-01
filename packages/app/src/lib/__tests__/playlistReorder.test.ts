/**
 * 歌单「上移 / 下移」位置换算与边界（moveTargetsAt）。
 *
 * 锁两件事：
 *   1. **边界**：第一行不能上移、最后一行不能下移（返回 -1 ⇒ 菜单项不渲染）。
 *      显示但禁用的菜单项等于留一个永远点不动的入口，所以边界必须是「不渲染」。
 *   2. **下标换算**：展示列表（已过滤掉曲库里已不存在的 id）与 playlist.trackIds
 *      （原始持久化顺序）是两份列表。歌单里有过被移出曲库的歌时，两者下标错位，
 *      直接用渲染下标去 reorder 会换掉相邻的另一首歌——这是用户可见的错。
 */
import { describe, expect, it } from 'vitest'
import { moveTargetsAt } from '@/lib/playlistReorder'

/** 一眼可辨的假 id（uuid 全零 + 序号），不含任何真实路径/凭据 */
const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`

describe('moveTargetsAt — 边界', () => {
  const ids = [id(1), id(2), id(3)]

  it('第一行不能上移', () => {
    const moves = moveTargetsAt(ids, ids, 0)
    expect(moves.up).toBe(-1)
    expect(moves.down).toBe(1)
  })

  it('最后一行不能下移', () => {
    const moves = moveTargetsAt(ids, ids, 2)
    expect(moves.up).toBe(1)
    expect(moves.down).toBe(-1)
  })

  it('中间行两个方向都可以', () => {
    expect(moveTargetsAt(ids, ids, 1)).toEqual({ up: 0, down: 2 })
  })

  it('只有一行时两个方向都不行', () => {
    expect(moveTargetsAt([id(1)], [id(1)], 0)).toEqual({ up: -1, down: -1 })
  })

  it('越界下标一律不支持移动（不抛错）', () => {
    expect(moveTargetsAt(ids, ids, -1)).toEqual({ up: -1, down: -1 })
    expect(moveTargetsAt(ids, ids, 3)).toEqual({ up: -1, down: -1 })
    expect(moveTargetsAt(ids, ids, 1.5)).toEqual({ up: -1, down: -1 })
  })
})

describe('moveTargetsAt — 展示列表与原始顺序错位', () => {
  it('中间有被移出曲库的歌时，目标位置按原始顺序给出', () => {
    // 原始顺序：1, 2(已从曲库移除), 3, 4
    // 展示列表：1, 3, 4 —— 展示下标 1 的歌是 3，它在原始顺序里的下标是 2
    const trackIds = [id(1), id(2), id(3), id(4)]
    const visible = [id(1), id(3), id(4)]

    expect(moveTargetsAt(trackIds, visible, 0)).toEqual({ up: -1, down: 2 })
    expect(moveTargetsAt(trackIds, visible, 1)).toEqual({ up: 0, down: 3 })
    expect(moveTargetsAt(trackIds, visible, 2)).toEqual({ up: 2, down: -1 })
  })

  it('自己不在原始顺序里时不做任何移动（数据不同步）', () => {
    const trackIds = [id(1), id(2)]
    const visible = [id(1), id(2), id(9)]

    expect(moveTargetsAt(trackIds, visible, 2)).toEqual({ up: -1, down: -1 })
  })

  it('相邻的可见曲目不在原始顺序里时，该方向不提供移动', () => {
    // 4 是导入进来但尚未写进 trackIds 的曲目（脏数据）
    const trackIds = [id(1), id(2)]
    const visible = [id(1), id(4), id(2)]

    // 行 1（歌 1）的下方邻居是脏数据 4 → 下移不提供
    expect(moveTargetsAt(trackIds, visible, 0)).toEqual({ up: -1, down: -1 })
    // 行 3（歌 2）的上方邻居同样是脏数据 4 → 上移不提供
    expect(moveTargetsAt(trackIds, visible, 2)).toEqual({ up: -1, down: -1 })
    // 自身即脏数据（行 2 的歌 4）→ 任何方向都不做
    expect(moveTargetsAt(trackIds, visible, 1)).toEqual({ up: -1, down: -1 })
  })
})

describe('moveTargetsAt — 换算结果喂给 reorderTracks 后的实际效果', () => {
  /** 复刻 playlistStore.reorderTracks 的实现（splice 取出再插入） */
  function reorder(trackIds: readonly string[], from: number, to: number): string[] {
    const next = [...trackIds]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  }

  it('对被移出曲库的歌夹在中间的歌单，上移换的是自己而不是邻居', () => {
    const trackIds = [id(1), id(2), id(3)]
    // 2 已从曲库移除 → 展示列表是 [1, 3]
    const visible = [id(1), id(3)]
    // 展示下标 1（歌 3）上移：目标位置必须是歌 1 在原始顺序里的下标 0
    const moves = moveTargetsAt(trackIds, visible, 1)
    expect(moves.up).toBe(0)

    const after = reorder(trackIds, trackIds.indexOf(id(3)), moves.up)
    // 歌 3 挪到歌 1 前面；歌 1 被下推一格（与「上移自己一行」的预期一致）
    expect(after).toEqual([id(3), id(1), id(2)])
  })

  it('首行上移 / 末行下移在 reorder 层也被拦住（不产生位移）', () => {
    const trackIds = [id(1), id(2), id(3)]
    expect(moveTargetsAt(trackIds, trackIds, 0).up).toBe(-1)
    expect(moveTargetsAt(trackIds, trackIds, 2).down).toBe(-1)
  })
})

/**
 * 「挂起自动重扫」的行为回归。
 *
 * 背景：批量替换加密音频时，每下载完一首都会让 fs.watch 按 1500ms 防抖触发一次
 * **整库**重扫（walkDir + 全量 stat + 全量 getTracksByPaths）。一批 40 首会触发十几次
 * 全库扫描，与下载抢磁盘 IO。挂起后这些变动只被记账，恢复时统一补一次。
 *
 * 断言都基于真实 fs.watch + 真实临时目录（不 mock）：要验证的正是「文件系统事件真的
 * 不会再变成一次重扫」，用假 watcher 就什么也没测到。等待时间依赖 1500ms 防抖，
 * 所以每个用例都给足 timeout。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isWatchSuspended, setWatchSuspended, unwatchFolder, watchFolder } from '../watcher'

/** 一个全新临时目录（从 os.tmpdir 派生，不写死本机路径） */
let dir: string
/** 累计的 onRescan 调用次数（跨多次写盘/挂起/恢复） */
let rescans: string[]
/** 等待时长：必须大于 watcher 的 1500ms 防抖 */
const PAST_DEBOUNCE_MS = 2200

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-watcher-'))
  rescans = []
  watchFolder(dir, (folder) => rescans.push(folder))
})

afterEach(() => {
  // 复位：先拆监听再解除挂起，避免用例间串味（挂起是模块级全局状态）
  unwatchFolder(dir)
  setWatchSuspended(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('watcher 挂起 / 恢复', () => {
  it(
    '挂起期间写文件不触发重扫，恢复后恰好补触发一次',
    { timeout: 15000 },
    async () => {
      setWatchSuspended(true)
      expect(isWatchSuspended()).toBe(true)

      fs.writeFileSync(path.join(dir, 'a.mp3'), 'x')
      await sleep(PAST_DEBOUNCE_MS)
      // 超过防抖窗口仍然一次都没扫：这才是「挂起」与「单纯防抖」的区别
      expect(rescans).toEqual([])

      setWatchSuspended(false)
      expect(isWatchSuspended()).toBe(false)
      await sleep(50)
      expect(rescans).toEqual([dir])
    }
  )

  it(
    '挂起期间多次写，恢复后只扫一次',
    { timeout: 15000 },
    async () => {
      setWatchSuspended(true)

      for (let i = 0; i < 4; i++) {
        fs.writeFileSync(path.join(dir, `song-${i}.mp3`), 'x')
        // 故意跨越防抖窗口：若挂起失效，这里会攒出多次重扫而不是一次
        await sleep(300)
      }
      await sleep(PAST_DEBOUNCE_MS)
      expect(rescans).toEqual([])

      setWatchSuspended(false)
      await sleep(50)
      expect(rescans).toEqual([dir])

      // 恢复后再等一个防抖窗口，确认没有迟到的定时器又补一次
      await sleep(PAST_DEBOUNCE_MS)
      expect(rescans).toEqual([dir])
    }
  )

  it(
    '未挂起时正常路径不受影响：写文件后仍会触发一次重扫',
    { timeout: 15000 },
    async () => {
      fs.writeFileSync(path.join(dir, 'normal.mp3'), 'x')
      await sleep(PAST_DEBOUNCE_MS)
      // 对照组：证明上面的用例不是「watcher 压根不工作」才通过的
      expect(rescans.length).toBeGreaterThanOrEqual(1)
      expect(rescans.every((folder) => folder === dir)).toBe(true)
    }
  )
})

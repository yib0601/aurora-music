import { ipcMain, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { isInsideScanRoot } from './scanRoots'
import { isEncryptedAudioName } from '@aurora/shared'

/**
 * 「加密音频 → 用音源重下一份」的**替换**那一半：清理原加密文件。
 *
 * 独立成模块（与 libraryActions.ts 同一套理由）：这条通道有明确的**信任边界**，
 * 需要单独用测试钉住，而 handlers.ts 一旦 import 就会拉起扫描器、插件宿主、
 * 更新器一整套依赖，无法单独测。
 *
 * 边界（三条都要同时成立，缺一条就是一次不可恢复的误删）：
 *   1. **路径必须在已扫描目录内** —— 与 `fs:readFile` 共用 ipc/scanRoots 的授权白名单。
 *      渲染层能删的，只能是它自己扫过、并且是它自己报上来的那个文件。
 *   2. **文件名必须带平台加密标记** —— 白名单目录里也有用户正常的歌。判据复用
 *      shared 的 isEncryptedAudioName（与扫描端同一份词表），因此「认得出的加密文件」
 *      与「删得掉的加密文件」是同一个集合，不会一边认一边删不到。
 *   3. **走 trashItem 而不是 unlink** —— 用户误点一次不该是永久损失。回收站是
 *      系统自带的撤销入口，代价只是多占一点磁盘。
 */
export const LIBRARY_TRASH_SOURCE_CHANNEL = 'library:trashEncryptedSource'

/** 单个文件清理的结果：失败不抛异常（批量场景要逐条记账，不该一条失败打断整批） */
export interface TrashSourceResult {
  ok: boolean
  /** ok=false 时的原因码，供显示端按语言渲染 */
  reason?: 'invalidPath' | 'outsideRoot' | 'notEncrypted' | 'missing' | 'failed'
  /** 原始错误文本（仅 failed 时有） */
  detail?: string
}

export function registerEncryptedSourceIpc() {
  ipcMain.handle(
    LIBRARY_TRASH_SOURCE_CHANNEL,
    async (_event, filePath: string): Promise<TrashSourceResult> => {
      if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) {
        return { ok: false, reason: 'invalidPath' }
      }
      if (!isInsideScanRoot(filePath)) return { ok: false, reason: 'outsideRoot' }
      if (!isEncryptedAudioName(path.basename(filePath))) {
        return { ok: false, reason: 'notEncrypted' }
      }
      // 文件已被用户手动删掉：不是错误结论，按成功返回（目标状态已达成）
      try {
        await fs.promises.access(filePath, fs.constants.F_OK)
      } catch {
        return { ok: true }
      }
      try {
        await shell.trashItem(filePath)
        return { ok: true }
      } catch (err) {
        // 典型原因：Linux 下桌面环境没装回收站实现（无 gio/无 home trash 目录）。
        // 不在这里回退成 unlink —— 那等于把「可撤销」悄悄降级成「不可撤销」，
        // 用户看不到任何区别却再也找不回文件。让结论如实失败，由 UI 告知。
        console.warn('移入回收站失败:', filePath, err)
        return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

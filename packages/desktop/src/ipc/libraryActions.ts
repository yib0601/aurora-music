import { ipcMain, shell } from 'electron'
import fs from 'fs'
import { deleteTrack, getAllTracks, getTrackById } from './database'

/**
 * 曲库级单条动作：从曲库移除单曲、在文件管理器中定位单曲。
 *
 * 与 handlers.ts 里散装的通道分开成模块的理由：这两个通道都有明确的**信任边界**，
 * 需要单独用测试钉住（见 __tests__/libraryActions.test.ts），而 handlers.ts 一旦
 * 被 import 就会拉起扫描器、插件宿主、更新器一整套依赖，无法单独测。
 */

/** 从曲库移除单曲：只删曲库记录与封面缓存，磁盘上的音频文件原样保留 */
export const LIBRARY_REMOVE_TRACK_CHANNEL = 'library:removeTrack'

/** 在文件管理器中定位曲目：入参是**曲目 id**，不是路径 */
export const SHELL_SHOW_ITEM_IN_FOLDER_CHANNEL = 'shell:showItemInFolder'

export function registerLibraryActionIpc() {
  // 从曲库移除单曲。
  //
  // 语义边界（这是本通道唯一需要保证的事）：
  // 1. **绝不删除磁盘上的音频文件**。用户的心智是「这首歌不在我的曲库里了」，
  //    而不是「文件没了」——后者没有撤销入口，一旦实现成删文件就是不可恢复的数据丢失。
  // 2. 删的是 tracks 表记录（封面由 deleteTrack 一并清理缓存文件）。
  //    歌单里的引用靠 playlist_tracks 的外键 ON DELETE CASCADE 自动收敛。
  // 3. 返回移除后的全库，渲染层直接拿来刷新，不必再发一次 db:getAllTracks。
  ipcMain.handle(LIBRARY_REMOVE_TRACK_CHANNEL, (_event, trackId: string) => {
    if (typeof trackId !== 'string' || !trackId.trim()) return getAllTracks()
    const track = getTrackById(trackId)
    if (!track) return getAllTracks()
    deleteTrack(trackId)
    console.log('已从曲库移除单曲（音频文件保留）:', trackId)
    return getAllTracks()
  })

  // 在文件管理器中定位曲目。
  //
  // **入参必须是曲目 id，不接受路径**。原因：
  // 主进程一旦按渲染层给的任意路径调 shell.showItemInFolder，就等于给渲染层开了一个
  // 「在文件管理器里定位/暴露任意本机文件」的接口——这个能力本身不读内容，但它把
  // 用户的文件系统变成可被渲染层探测和展示的对象（配合误操作或一次截图即可定位到
  // 用户的凭据目录、下载目录）。曲库之外没有任何合法的调用场景，
  // 所以这里按 id 反查 path：渲染层能定位的「文件」只能是它本来就看得见的曲库条目。
  //
  // 远端曲目（WebDAV 等，带 sourceId）在主进程有对应的网络地址但**没有本机文件**，
  // 直接返回 false，让渲染层按「无此能力」处理，而不是弹一个空的文件管理器。
  ipcMain.handle(SHELL_SHOW_ITEM_IN_FOLDER_CHANNEL, (_event, trackId: string): boolean => {
    if (typeof trackId !== 'string' || !trackId.trim()) return false
    const track = getTrackById(trackId)
    if (!track || track.sourceId || !track.path) return false
    // 文件已被用户在外部删掉时不必再弹文件管理器：定位一个不存在的文件
    // 在有托盘/无托盘的桌面环境里行为不一致，且用户看到的是空白目录
    try {
      if (!fs.existsSync(track.path)) return false
    } catch {
      return false
    }
    shell.showItemInFolder(track.path)
    return true
  })
}

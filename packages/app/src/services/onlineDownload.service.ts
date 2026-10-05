import { pickDownloadUrl } from '@/lib/onlineTrack'
import type { Track, DownloadQuality, OnlineSourceConfig } from '@/types'

/** 下载结果：saved 已保存 / no-source 取不到地址 / cancelled 用户取消 / failed 下载失败 */
export type OnlineDownloadOutcome = 'saved' | 'no-source' | 'cancelled' | 'failed'

export interface OnlineDownloadDeps {
  /** 按需取址（同 ensurePlayableTrack）；取不到返回 null */
  resolveTrack: (track: Track) => Promise<Track | null>
  /** 实际下载，返回保存路径 */
  downloadFile: (
    payload: { audioUrl: string; title: string; artist?: string; album?: string; coverUrl?: string },
    headers: Record<string, string> | undefined,
    downloadDir: string | undefined
  ) => Promise<{ savedPath: string }>
  /** 读取下载相关配置（音源表 / 默认下载目录 / 下载音质） */
  config: () => { sources: OnlineSourceConfig[]; downloadDir: string | null; quality: DownloadQuality }
  /** 桌面端：未设默认目录时下载走保存对话框，完成后给「设为默认下载目录」入口 */
  isDesktop: boolean
  /** 终态提示（进行中的「正在下载…」由调用方自己发） */
  notify: (
    message: string,
    options?: { type?: 'success' | 'error'; action?: { label: string; onClick: () => void } }
  ) => void
  setDownloadDir: (dir: string) => void
}

/**
 * 下载一首在线歌曲的完整流程（与 UI 解耦，依赖注入便于单测）。
 *
 * 关键点：**下载前必须重新取址**。曲目对象可能来自「最近播放 / 导入歌单 / 重启后的
 * 播放队列」，这些快照按约定剥离了 onlineUrl——歌源直链几十分钟即过期，落盘必失效。
 * 老实现拿 track.onlineUrl 当开关，导致这类在线歌曲既没有下载入口、也下不了；
 * 现在判据（isDownloadableOnlineTrack）与取址都不依赖 track 上是否已有地址。
 *
 * 取到的地址命中别的音源时，完成提示里如实标注，避免用户以为下载的是列表里那一条。
 */
export async function runOnlineDownload(track: Track, deps: OnlineDownloadDeps): Promise<OnlineDownloadOutcome> {
  let resolved = track
  try {
    resolved = (await deps.resolveTrack(track)) || track
  } catch {
    // 取址本身失败（网络/源异常）不阻断：已有地址时直接下载，没有地址则走下面的提示
    resolved = track
  }

  if (!resolved.onlineUrl) {
    deps.notify('无法下载：未配置可用音源，或未搜索到该歌曲', { type: 'error' })
    return 'no-source'
  }

  const { sources, downloadDir, quality } = deps.config()
  const source = sources.find((s) => s.id === resolved.onlineSource)
  const sourceSwitched =
    !!track.onlineSourceName &&
    !!resolved.onlineSourceName &&
    resolved.onlineSourceName !== track.onlineSourceName
  const sourceNote = sourceSwitched ? `\n音源：${resolved.onlineSourceName}` : ''

  try {
    const { savedPath } = await deps.downloadFile(
      // 带上专辑与封面地址：下载完成后封面随文件嵌入（源直链的音频大多无内嵌封面）
      {
        audioUrl: pickDownloadUrl(resolved, quality),
        title: resolved.title,
        artist: resolved.artist,
        album: resolved.album,
        coverUrl: resolved.coverUrl,
      },
      source?.headers,
      downloadDir || undefined
    )

    if (downloadDir || !deps.isDesktop) {
      deps.notify(`下载完成\n已保存到：${savedPath}${sourceNote}`)
    } else {
      // 桌面端本次走了保存对话框：提供「设为默认下载目录」操作，点击后不再每次询问。
      // 移动端没有这个快捷入口——移动端的下载目录是手机存储内的相对路径，
      // 从绝对保存路径反推会存成绝对路径，配置统一走「设置 → 下载 → 默认下载目录」。
      const dir = savedPath.replace(/[\\/][^\\/]*$/, '')
      deps.notify(`下载完成\n已保存到：${savedPath}${sourceNote}`, {
        action: {
          label: '设为默认下载目录',
          onClick: () => {
            deps.setDownloadDir(dir)
            deps.notify(`后续下载将直接保存到「${dir}」，可在「设置 → 下载」中修改`)
          },
        },
      })
    }
    return 'saved'
  } catch (err: any) {
    // 用户在保存对话框点了取消、或没给存储权限，都不算失败，不报错
    if (err?.message === '已取消保存' || err?.message === '缺少存储权限') return 'cancelled'
    deps.notify(err?.message || '下载失败，请稍后重试', { type: 'error' })
    return 'failed'
  }
}
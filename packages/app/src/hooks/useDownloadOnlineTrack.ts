import { useCallback, useRef, useState } from 'react'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { toast, dismissToast } from '@/components/common/Toast'
import { isDesktop } from '@/lib/utils'
import { runOnlineDownload } from '@/services/onlineDownload.service'
import type { Track } from '@/types'

/** 音质回退链、下载地址挑选与「是否给下载入口」的判据见 @/lib/onlineTrack（带单测） */

/**
 * 下载在线歌曲的共享逻辑（搜索浮层 / 歌曲详情页共用）：
 * - 下载前按需取址：缺播放地址时用用户配置的歌源重新搜索取结果（同 ensurePlayableTrack），
 *   因此「最近播放 / 导入歌单 / 重启后的播放队列」里的在线曲目同样可下载
 * - 有默认下载目录则直存（桌面端免保存对话框；移动端存入设置里选定的相对目录）
 * - 桌面端未设置目录时弹保存对话框，并给一个「设为默认下载目录」的快捷入口；
 *   移动端未设置时直接存入默认的 Music/Aurora Music，配置入口在「设置 → 下载」
 * - downloadingIds 暴露下载中状态，调用方据此显示加载态、防重复触发
 *
 * 流程主体在 services/onlineDownload.service（依赖注入、带单测），这里只做
 * 「平台能力装配 + 下载中状态 + 过程提示」。
 */
export function useDownloadOnlineTrack() {
  // 正在下载中的曲目 id 集合（同一首歌不重复触发，图标显示加载态）
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())

  // 下载 guard 用 ref 镜像：开始/结束下载不重建回调，仅通过 isDownloading 更新对应 UI
  const downloadingIdsRef = useRef(downloadingIds)
  downloadingIdsRef.current = downloadingIds

  const download = useCallback(async (track: Track) => {
    if (downloadingIdsRef.current.has(track.id)) return
    // 平台不支持内置下载时不静默吞掉：说清原因，避免「点了没反应」
    const downloadFile = platform.downloadOnlineTrack
    if (!downloadFile) {
      toast('当前平台不支持下载歌曲', { type: 'error' })
      return
    }

    setDownloadingIds((prev) => new Set(prev).add(track.id))
    // 下载发起即提示（桌面端无下载进度回调，这是唯一的过程反馈）；
    // 后续完成/失败/取消提示出现时自动收起，避免多首连下时残留堆叠
    const startToastId = toast(`正在下载「${track.title}」…`, { type: 'info', duration: 60000 })
    try {
      await runOnlineDownload(track, {
        // 动态导入 playlistIO：它与 stores 互相引用，静态引入会拉进详情页首屏包
        resolveTrack: async (t) => (await import('@/services/playlistIO.service')).ensurePlayableTrack(t),
        downloadFile: (payload, headers, downloadDir) => downloadFile(payload, headers, downloadDir),
        config: () => {
          const s = useLibraryStore.getState()
          return { sources: s.onlineSources, downloadDir: s.downloadDir, quality: s.downloadQuality }
        },
        isDesktop: isDesktop(),
        notify: (message, options) => toast(message, options),
        setDownloadDir: (dir) => useLibraryStore.getState().setDownloadDir(dir),
      })
    } finally {
      // 终态提示已发出，收起进行中提示
      dismissToast(startToastId)
      setDownloadingIds((prev) => {
        const next = new Set(prev)
        next.delete(track.id)
        return next
      })
    }
  }, [])

  return { downloadingIds, download }
}

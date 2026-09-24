import { useCallback, useRef, useState } from 'react'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { toast, dismissToast } from '@/components/common/Toast'
import { isDesktop } from '@/lib/utils'
import type { Track, DownloadQuality } from '@/types'

/** 音质回退链：设置的档位不可用时，依次尝试其余档位，最终回退到源默认地址 */
const QUALITY_FALLBACK: Record<DownloadQuality, DownloadQuality[]> = {
  '128': ['128', '320', 'flac'],
  '320': ['320', 'flac', '128'],
  flac: ['flac', '320', '128'],
}

/** 按下载音质设置挑选下载地址：源未提供多音质地址时直接用默认地址 */
export function pickDownloadUrl(track: Track, preferred: DownloadQuality): string {
  const urls = track.onlineQualityUrls
  if (urls) {
    for (const q of QUALITY_FALLBACK[preferred]) {
      if (urls[q]) return urls[q]!
    }
  }
  return track.onlineUrl!
}

/**
 * 下载在线歌曲的共享逻辑（搜索浮层 / 歌曲详情页共用）：
 * - 有默认下载目录则直存（桌面端免保存对话框；移动端存入设置里选定的相对目录）
 * - 桌面端未设置目录时弹保存对话框，并给一个「设为默认下载目录」的快捷入口；
 *   移动端未设置时直接存入默认的 Music/Aurora Music，配置入口在「设置 → 下载」
 * - downloadingIds 暴露下载中状态，调用方据此显示加载态、防重复触发
 */
export function useDownloadOnlineTrack() {
  // 正在下载中的曲目 id 集合（同一首歌不重复触发，图标显示加载态）
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())

  // 下载 guard 用 ref 镜像：开始/结束下载不重建回调，仅通过 isDownloading 更新对应 UI
  const downloadingIdsRef = useRef(downloadingIds)
  downloadingIdsRef.current = downloadingIds

  const download = useCallback(async (track: Track) => {
    if (!track.onlineUrl || downloadingIdsRef.current.has(track.id)) return
    setDownloadingIds((prev) => new Set(prev).add(track.id))
    // 下载发起即提示（桌面端无下载进度回调，这是唯一的过程反馈）；
    // 后续完成/失败/取消提示出现时自动收起，避免多首连下时残留堆叠
    const startToastId = toast(`正在下载「${track.title}」…`, { type: 'info', duration: 60000 })
    try {
      // 取该曲来源配置的附加请求头（Referer/UA 等），保证下载与搜索请求一致
      const source = useLibraryStore.getState().onlineSources.find((s) => s.id === track.onlineSource)
      const downloadDir = useLibraryStore.getState().downloadDir
      // 按设置的下载音质挑选地址（源未提供多音质地址时回退默认地址）
      const audioUrl = pickDownloadUrl(track, useLibraryStore.getState().downloadQuality)
      const { savedPath } = await platform.downloadOnlineTrack!(
        // 带上专辑与封面地址：下载完成后封面随文件嵌入（源直链的音频大多无内嵌封面）
        { audioUrl, title: track.title, artist: track.artist, album: track.album, coverUrl: track.coverUrl },
        source?.headers,
        downloadDir || undefined
      )
      if (downloadDir || !isDesktop()) {
        dismissToast(startToastId)
        toast(`下载完成\n已保存到：${savedPath}`)
      } else {
        // 桌面端本次走了保存对话框：提供「设为默认下载目录」操作，点击后不再每次询问。
        // 移动端没有这个快捷入口——移动端的下载目录是手机存储内的相对路径，
        // 从绝对保存路径反推会存成绝对路径，配置统一走「设置 → 下载 → 默认下载目录」。
        const dir = savedPath.replace(/[\\/][^\\/]*$/, '')
        dismissToast(startToastId)
        toast(`下载完成\n已保存到：${savedPath}`, {
          action: {
            label: '设为默认下载目录',
            onClick: () => {
              useLibraryStore.getState().setDownloadDir(dir)
              toast(`后续下载将直接保存到「${dir}」，可在「设置 → 下载」中修改`)
            },
          },
        })
      }
    } catch (err: any) {
      // 下载终态出现（完成/失败/用户在保存对话框取消）：收起「正在下载」提示
      dismissToast(startToastId)
      // 用户在保存对话框点了取消，不算失败
      if (err?.message !== '已取消保存' && err?.message !== '缺少存储权限') {
        toast(err?.message || '下载失败，请稍后重试', { type: 'error' })
      }
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev)
        next.delete(track.id)
        return next
      })
    }
  }, [])

  return { downloadingIds, download }
}

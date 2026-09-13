import { useState } from 'react'
import { ArrowDownCircle, Download, X } from 'lucide-react'
import type { UpdateInfo } from '@/services/update.service'
import { openDownloadPage, APP_VERSION } from '@/services/update.service'
import { isInAppUpdateAvailable, startInAppDownload } from '@/stores/updateDownloadStore'

/**
 * 新版本提示横幅：启动检测到新版本后在页面顶部展示。
 * 桌面端点击「下载更新」走应用内下载（主进程拉包 + 进度对话框，下载完可直接安装）；
 * Web / 移动端或未匹配到安装包时回退到系统浏览器打开下载页。
 */
export function UpdateBanner({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const [downloading, setDownloading] = useState(false)
  const inAppAvailable = isInAppUpdateAvailable() && !!info.assetUrl && !!info.assetKind

  const handleDownload = () => {
    if (inAppAvailable) {
      const started = startInAppDownload({
        url: info.assetUrl!,
        kind: info.assetKind!,
        version: info.version,
        label: info.assetLabel,
      })
      if (started) {
        // 下载进度由全局对话框展示，横幅完成使命
        onClose()
        return
      }
    }
    // 兜底：浏览器打开下载页（历史行为）
    openDownloadPage(info)
    setDownloading(true)
    setTimeout(onClose, 1200)
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 md:px-8 mb-3">
      <div className="flex items-center gap-3 rounded-xl border border-mint/25 bg-mint/[0.08] px-4 py-2.5 backdrop-blur-md">
      <ArrowDownCircle className="h-5 w-5 text-mint flex-shrink-0" strokeWidth={1.6} />
      <p className="font-text text-[13px] text-white/85 tracking-[-0.15px] min-w-0 flex-1 truncate">
        发现新版本 <span className="text-mint font-semibold">v{info.version}</span>
        {/* 小屏空间有限，隐藏当前版本信息，优先保证新版本号完整展示 */}
        <span className="text-white/50 hidden md:inline">，当前 v{APP_VERSION}</span>
      </p>
      {/* 标出将下载的包类型：dnf 系给 RPM、apt 系给 DEB、便携版给 AppImage */}
      {info.assetLabel && (
        <span className="flex-shrink-0 rounded-full border border-mint/30 bg-mint/10 px-2 py-0.5 font-text text-[11px] text-mint/90">
          {info.assetLabel}
        </span>
      )}
      <button
        onClick={handleDownload}
        title={inAppAvailable ? '应用内下载，完成后可直接安装' : info.installHint || undefined}
        className="flex-shrink-0 pill pill-sm pill-mint"
      >
        <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
        {downloading ? '已打开下载' : '下载更新'}
      </button>
      <button
        onClick={onClose}
        aria-label="关闭更新提示"
        className="btn-icon rounded-full text-white/50 hover:text-white"
      >
        <X className="h-4 w-4" strokeWidth={1.8} />
      </button>
      </div>
    </div>
  )
}

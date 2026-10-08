import { useState } from 'react'
import { ArrowDownCircle, Download, X } from 'lucide-react'
import type { UpdateInfo } from '@/services/update.service'
import { openDownloadPage, APP_VERSION } from '@/services/update.service'
import { isInAppUpdateAvailable, startInAppDownload } from '@/stores/updateDownloadStore'
import { useT } from '@/i18n'

/**
 * 新版本提示横幅：启动检测到新版本后在页面顶部展示。
 * 桌面端点击「下载更新」走应用内下载（主进程拉包 + 进度对话框，下载完可直接安装）；
 * Web / 移动端或未匹配到安装包时回退到系统浏览器打开下载页。
 *
 * 两副形态（同一份状态与动作，只是落点不同）：
 * - `banner`（默认）：内容区首行的整行横幅，占满内容列宽度，移动端窄档用它
 * - `compact`：宽档顶部工具带右端的胶囊（30px 高），与左边的搜索入口同行
 *   两端对齐。整行横幅塞进 44px 带子里会溢出（自带 py-2.5 + 圆角边框），
 *   而带子里若只有左侧一个搜索框、右侧留空 800+px，那个框看着就是孤零零地
 *   飘在窗口顶 —— 这两件事是同一个决定的两面。
 *
 * 文案一律渲染期 t()：`info.assetLabel` / `info.installHint` 是**键**不是句子
 * （见 update.service 的 UpdateInfo），横幅是长期驻留元素，切语言要跟着变。
 */
export function UpdateBanner({
  info,
  onClose,
  variant = 'banner',
}: {
  info: UpdateInfo
  onClose: () => void
  variant?: 'banner' | 'compact'
}) {
  const t = useT()
  const [downloading, setDownloading] = useState(false)
  const inAppAvailable = isInAppUpdateAvailable() && !!info.assetUrl && !!info.assetKind
  // 覆盖安装提示：键 + 命令行原文配套渲染，缺一不给（避免显示半个句子）
  const installHint =
    info.installHint && info.installCommand
      ? t(info.installHint, { command: info.installCommand })
      : info.installHint
        ? t(info.installHint)
        : null
  const downloadTitle = inAppAvailable ? t('update.banner.inAppHint') : installHint || undefined

  const handleDownload = () => {
    if (inAppAvailable) {
      const started = startInAppDownload({
        url: info.assetUrl!,
        altUrls: info.assetUrls,
        kind: info.assetKind!,
        version: info.version,
        label: info.assetLabel,
        size: info.assetSize,
        digest: info.assetDigest,
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

  // 紧凑态：图标 + 版本号 + 下载按钮 + 关闭，压进 36px 高的一枚胶囊（与窗口控制
  // 按钮同档，也贴住 44px 搜索入口的高度带）。整行横幅塞进顶栏带会溢出，
  // 而带子里只有左侧一个入口、右侧全空时那个框就看着孤零零地飘在窗口顶。
  // 当前版本号、包类型标签在带子里放不下（也不值得为它撑高那条带），省略。
  if (variant === 'compact') {
    return (
      <div className="flex items-center gap-1 rounded-full border border-mint/20 bg-mint/[0.06] pl-3 pr-1 h-9 backdrop-blur-ds">
        <ArrowDownCircle className="h-[18px] w-[18px] text-mint flex-shrink-0" strokeWidth={1.6} />
        <p className="font-text text-[13px] text-white/85 tracking-[-0.15px] whitespace-nowrap">
          {t('update.banner.newVersionCompact')} <span className="text-mint font-semibold">v{info.version}</span>
        </p>
        <button
          onClick={handleDownload}
          title={downloadTitle}
          className="ml-1 flex-shrink-0 rounded-full border border-mint/25 bg-mint/[0.1] px-3 h-7 flex items-center gap-1.5 font-text text-[13px] text-mint hover:bg-mint/20 transition-colors whitespace-nowrap"
        >
          <Download className="h-3.5 w-3.5" strokeWidth={2} />
          {t(downloading ? 'update.banner.opened' : 'update.banner.download')}
        </button>
        <button
          onClick={onClose}
          aria-label={t('update.banner.close')}
          className="btn-icon rounded-full text-white/50 hover:text-white"
        >
          <X className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 md:px-8 mb-3">
      <div className="flex items-center gap-3 rounded-[10px] border border-mint/20 bg-mint/[0.06] px-4 py-2.5 backdrop-blur-ds">
      <ArrowDownCircle className="h-5 w-5 text-mint flex-shrink-0" strokeWidth={1.6} />
      {/* 新版本号与当前版本号同句：英文语序不同，整句 + 两个占位符，不拆开拼 */}
      <p className="font-text text-[13px] text-white/85 tracking-[-0.15px] min-w-0 flex-1 truncate">
        {t('update.banner.newVersionFull')} <span className="text-mint font-semibold">v{info.version}</span>
        {/* 小屏空间有限，隐藏当前版本信息，优先保证新版本号完整展示 */}
        <span className="text-white/50 hidden md:inline">
          {t('update.banner.currentVersion', { version: APP_VERSION })}
        </span>
      </p>
      {/* 标出将下载的包类型：dnf 系给 RPM、apt 系给 DEB、便携版给 AppImage */}
      {info.assetLabel && (
        <span className="flex-shrink-0 rounded-full border border-mint/25 bg-mint/[0.08] px-2 py-0.5 font-text text-[11px] text-mint/90">
          {t(info.assetLabel)}
        </span>
      )}
      <button
        onClick={handleDownload}
        title={downloadTitle}
        className="flex-shrink-0 pill pill-sm pill-mint"
      >
        <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
        {t(downloading ? 'update.banner.openedDownload' : 'update.banner.download')}
      </button>
      <button
        onClick={onClose}
        aria-label={t('update.banner.close')}
        className="btn-icon rounded-full text-white/50 hover:text-white"
      >
        <X className="h-4 w-4" strokeWidth={1.8} />
      </button>
      </div>
    </div>
  )
}

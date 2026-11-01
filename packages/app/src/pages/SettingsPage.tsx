import { useEffect, useRef, useState } from 'react'
import { Monitor, Moon, Sun, FolderOpen, Trash2, RefreshCw, Download, CheckCircle2, AlertCircle, ChevronDown, Check, Github, FileText, Copy, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PageLayout } from '@/components/PageLayout'
import { PageTitle } from '@/components/PageHeading'
import { useLibraryStore, defaultAudioCacheLimitMB } from '@/stores/libraryStore'
import type { LogStorageInfo } from '@/types'
import { useAudioDevices } from '@/hooks/useAudioDevices'
import { setOutputDevice } from '@/services/audio.service'
import { platform, DEFAULT_MOBILE_DOWNLOAD_DIR } from '@/services/platform'
import { isDesktop, isMobile } from '@/lib/utils'
import {
  CACHE_LIMIT_MAX_GB,
  CACHE_LIMIT_MIN_GB,
  GB_PRESETS,
  gbToMb,
  mbToGb,
  parseCacheLimitGbDraft,
} from '@/lib/cacheLimit'
import { NAV_LABEL_KEYS } from '@/lib/routes'
import { useLocale, useT } from '@/i18n'
import { useLocaleStore } from '@/stores/localeStore'
import { toast } from '@/components/common/Toast'
import { APP_VERSION, REPO_URL, checkForUpdate, openDownloadPage, type UpdateInfo } from '@/services/update.service'
import { isInAppUpdateAvailable, startInAppDownload, useUpdateDownloadStore } from '@/stores/updateDownloadStore'
import { getAudioCacheUsage, clearAudioCache } from '@/services/audioCache.service'
import { resetCoverCache } from '@/components/common/CoverImage'
import {
  exportLogs,
  getLogInfo,
  revealLogs,
  supportsLogExport,
  supportsLogReveal,
} from '@/services/logging.service'
import { PluginManagerPanel } from '@/components/common/PluginManagerPanel'
import { pluginExecutionAvailable, pluginInstallAvailable } from '@/components/common/pluginManage'
import {
  formatBytes,
  formatNumber,
  LANGUAGE_PREFERENCES,
  LOCALE_LABELS,
  SYSTEM_LANGUAGE_LABELS,
} from '@aurora/shared'
import type { LanguagePreference, Locale, MessageKey } from '@aurora/shared'

/**
 * 打开外部链接。
 * - 桌面端：window.open 被主进程 setWindowOpenHandler 接管，交由系统浏览器（与「检查更新」跳下载页同一链路）
 * - 移动端：Capacitor 的 WebView 未开启多窗口支持，window.open 不可靠；改走 location ——
 *   BridgeWebViewClient 会把非应用内地址交给系统浏览器（launchIntent → ACTION_VIEW），应用页面本身不卸载
 * - Web 端：按普通新标签页打开
 */
function openExternalUrl(url: string) {
  if (isMobile()) {
    window.location.href = url
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * 复制文本到剪贴板，返回是否成功。
 *
 * 为什么不用 navigator.clipboard 一把梭：桌面端与移动端的 WebView 都可能因为
 * 非安全上下文 / 缺用户手势判定而让 clipboard API 返回 rejected，
 * 而「复制路径」这种操作失败时用户是能感知的（剪贴板没变化），所以我们不静默失败，
 * 而是回落到 `document.execCommand('copy')` 这条老路径 —— 它在新旧 WebView 里都还在。
 * 兜底再失败才返回 false，由调用方决定要不要提示。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 降级到 execCommand：不中断流程
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    // 放到视口外：不改变布局，也不会让页面跳动
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * 主题档位。`labelKey` 而不是 `label: string` 是刻意的：这是模块级常量数组，
 * 在这里求值文案会把语言冻结在模块加载那一刻（见 docs/i18n.md 硬规则 1）。
 */
const themeOptions: ReadonlyArray<{
  value: 'dark' | 'light' | 'system'
  labelKey: MessageKey
  icon: typeof Moon
}> = [
  { value: 'dark', labelKey: 'settings.general.theme.dark', icon: Moon },
  { value: 'light', labelKey: 'settings.general.theme.light', icon: Sun },
  { value: 'system', labelKey: 'settings.general.theme.system', icon: Monitor },
]

/**
 * 语言选项的名称规则：具体语言一律用**该语言自身**书写（简体中文 / English），
 * 「跟随系统」按**当前界面语言**书写。名字由 shared 提供，不进字典——
 * 用户看不懂当前界面语言时，母语名是唯一能自救的线索。
 */
function languageOptionLabel(value: LanguagePreference, locale: Locale): string {
  return value === 'system' ? SYSTEM_LANGUAGE_LABELS[locale] : LOCALE_LABELS[value]
}

/** 缓存容量合法区间与换算集中在 @/lib/cacheLimit：UI 只消费它的 GB 口径 */

/** 下载音质档位：值对应歌源协议的 {quality} 占位符与 qualityUrls 键（文案键在渲染期取译文） */
const downloadQualityOptions: ReadonlyArray<{ value: '128' | '320' | 'flac'; labelKey: MessageKey }> = [
  { value: '128', labelKey: 'settings.storage.downloadQuality.standard' },
  { value: '320', labelKey: 'settings.storage.downloadQuality.high' },
  { value: 'flac', labelKey: 'settings.storage.downloadQuality.lossless' },
]

/**
 * 设置分区表：左侧导航、分区标题、滚动锚点三处共用这一份 id/键，避免改一处漏两处。
 * 顺序即用户的任务顺序：先调外观 → 再管曲库来源 → 再管落盘 → 再管在线源 → 最后是版本信息。
 *
 * 分区数刻意收在 5 个：原来的「下载」「缓存」「软件更新」「关于」四个卡片各自只有一两行内容，
 * 平铺出来是四张等重卡片，用户扫读时要逐个读标题才知道哪个是哪个；合并后
 * 「下载 + 缓存」同属落盘语义、「软件更新 + 关于」同属版本语义，导航一眼可辨。
 *
 * 库里那一区复用 `nav.item.library`：页名在侧栏、页头、空态按钮等十几处出现，
 * 另开一份键必然漂移。
 *
 * `available` 是**能力谓词而非布尔值**：查询平台能力要在运行期做，写成模块级布尔值
 * 会把「平台不支持」这件事冻结在模块加载那一刻（且 SSR / 单测里没有 window）。
 * 导航与分区标题都必须用它过滤 —— 少了这一步会出现「导航点了没反应」：
 * 分区被隐藏、锚点却还在，scrollTo 找不到 DOM 就静默什么都不做。
 */
const SETTINGS_SECTIONS: ReadonlyArray<{
  id: string
  labelKey: MessageKey
  available?: () => boolean
}> = [
  { id: 'general', labelKey: 'settings.nav.general' },
  { id: 'library', labelKey: NAV_LABEL_KEYS.library },
  { id: 'storage', labelKey: 'settings.nav.storage' },
  // 「插件」只在**真有插件层**的端出现：桌面端与移动端都有执行通道，
  // 浏览器端两样都没有（插件要主进程网络栈与凭证存储）。那一端整区隐藏，
  // 而不是给一张只有标题、没有任何插件可管的空卡片 —— 用户的结论会是"功能坏了"。
  {
    id: 'plugins',
    labelKey: 'settings.nav.plugins',
    available: () => pluginExecutionAvailable() || pluginInstallAvailable(),
  },
  { id: 'about', labelKey: 'settings.nav.about' },
  // 「诊断日志」排在「关于」之后：它同属「这套软件本身」的语义（版本 / 更新 / 日志
  // 都是排障用的），但用户平时用不到，放在最后不至于抢占常用分区的注意力。
  // 只在平台真接上落盘能力时出现（Web 端没有日志文件可导）。
  { id: 'diagnostics', labelKey: 'settings.nav.diagnostics', available: supportsLogExport },
]

/**
 * 当前端可见的分区（按分区表顺序）。
 *
 * 每次调用现算而不是缓存：能力依赖的平台单例在模块加载后才就绪，
 * 缓存会把「一开始不支持、后来接上了」的场景永久判死。
 */
function visibleSettingsSections(): ReadonlyArray<{ id: string; labelKey: MessageKey }> {
  return SETTINGS_SECTIONS.filter((section) => !section.available || section.available())
}

/** 分区 DOM id：导航、滚动定位与 spy 共用，禁止在别处拼字面量 */
const settingsSectionId = (id: string) => `settings-${id}`

/**
 * 分区导航：桌面端左侧常驻竖排，窄屏退化为顶部胶囊条。
 * 窄屏用 flex-wrap 换行而非横向滚动：5 个中文标签在 390px 宽下会超出屏幕，
 * 横向滚动条会把最后一项藏起来，用户不知道还有分区没看到。
 *
 * **桌面端宽度贴合最长标签**（`grid-cols-[max-content]`），不要写成固定 `w-[152px]`：
 * 定宽 + 文字左对齐时，中文标签实测只占 26–64px，按钮里留下 88–126px 死空白，
 * 「导航文字 → 卡片边框」的净空隙因此涨到 100px 以上——用户抱怨的"间隔太大"正是这个，
 * 与父容器 gap 无关，只调 gap 治不了。max-content 列让 nav 收到最长标签的宽度，
 * 每个按钮仍等宽（grid 子项默认 stretch），一列边缘齐平。
 *
 * **桌面端选中态：左侧 2px mint 竖条 + 白 7% 弱底**，不用实心 mint 色块。
 * 实心块在 114px 宽的窄列里是 36px 高的整块色斑（文字只占 26px，左右各 32px 死内边距），
 * 面积大、色相满，是"丑"的主要来源；且与侧栏主导航的低透语言割裂。
 * 弱底 + 竖条把"选中"拆成两个弱信号：色相只出现在 2px 竖条上，面积降到 1/20，
 * 底色回到中性通道（`white/7%`，浅色主题自动翻成深墨叠色），两套主题都不需要单独调色。
 * 竖条压在 nav 左内衬之外（`-left-3`），与文字左缘对齐成一条轴线。
 *
 * **桌面端另一侧有竖分割线**：导航列与内容列是两个分组，分割线让左列有明确边界，
 * 视线才知道 24px 空隙"属于谁"。间距优先于分割线是常规，但这里左列内容是**导航**——
 * 用户需要随时知道"当前在哪一区"，一条贯穿的分割线比纯间距更能锚定这一列。
 *
 * **桌面端 `content-start` 与 `self-stretch` 是成对的，两个都要留**：nav 被拉伸到内容列
 * 全高后，grid 行若不从顶部起排，`align-content` 默认的 `stretch` 会把 5 行均分到这一整列，
 * 相邻标签中心间距从 40px 涨到 118px（793px 高窗口实测）——"导航太分散"就是这么来的。
 * 只删 `content-start` 症状立刻复发：标签被均匀摊在整列高度上，而不是聚成一组。
 *
 * 窄屏仍是横向胶囊条（实心 mint）：横向 chip 用实心是标准形态，竖条在那里没有意义。
 */
function SettingsNav({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const t = useT()
  return (
    <nav
      data-settings-nav
      className="flex flex-wrap gap-1.5 lg:grid lg:w-fit lg:flex-none lg:flex-shrink-0 lg:grid-cols-[max-content] lg:content-start lg:gap-y-1 lg:self-stretch lg:border-r lg:border-white/[0.06] lg:pr-3"
    >
      {visibleSettingsSections().map(({ id, labelKey }) => {
        const on = active === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-current={on ? 'true' : undefined}
            // 选中态两套写法按断点切换（不用同属性叠加，避免 Tailwind 生成顺序决定胜负）：
            // - 窄屏：实心 mint + 深墨字。前景**刻意硬编码** #030608 而不是用 `text-mint-fg`——
            //   后者是为 Tailwind 的 bg-mint 设计的，浅色下翻成白字，白字 on #009C88 只有 3.44:1
            //   （与 globals.css 的 .btn-primary 同一理由）；深墨字在两种主题的 mint 底上是 14.53:1 / 5.91:1。
            // - 桌面端：弱底 + 竖条（详见上方函数注释），色相只落在 2px 竖条上。
            // 竖条放按钮自身左缘（不是 nav 内衬外侧）：弱底从按钮左缘开始，竖条压在它边缘上，
            // 两者读作一个整体；放在内衬外会隔着 12px 空隙"漂"在左边，像两条无关的元素。
            // 未选中字色 /65 而非 /55：设计系统 §2.5 定的次要文字下限（/55 实测跌到 3.x:1）。
            className={`relative h-8 whitespace-nowrap rounded-full px-3 font-text text-[12px] tracking-[-0.2px] transition-colors duration-200 ease-mineradio lg:h-9 lg:rounded-ds-media lg:pl-3 lg:pr-3.5 lg:text-left lg:text-[13px] lg:before:absolute lg:before:bottom-2 lg:before:left-0 lg:before:top-2 lg:before:w-[2px] lg:before:rounded-r-[2px] lg:before:content-[''] ${
              on
                ? 'bg-mint font-semibold text-[#030608] lg:bg-white/[0.07] lg:font-medium lg:text-white/95 lg:before:bg-mint'
                : 'text-white/65 hover:bg-white/[0.05] hover:text-white/90'
            }`}
          >
            {t(labelKey)}
          </button>
        )
      })}
    </nav>
  )
}

/**
 * 当前分区判定：取「内容列顶部下 96px」这条线以上最后一个分区的 id。
 *
 * 判定线不能用 window.innerHeight 的比例：应用外壳是 `h-screen overflow-hidden` 的固定布局，
 * 可视高度由内容列决定，与窗口高度不成比例（窗口 900、内容列只有 690）。用的是**内容列**的
 * 顶部基线 + 一个标题高度的偏移，两种滚动模式（桌面端列内滚动 / 窄屏整页滚动）都成立。
 *
 * 也不能用"最后滚不到顶就选它"的兜底：内容列最大滚动量有限，「在线源」「关于」永远滚不到
 * 判定线以上，兜底会把 active 永久钉在最后一个分区、前半页导航全部失灵。
 */
function useSettingsSpy() {
  const sections = visibleSettingsSections()
  const [active, setActive] = useState<string>(sections[0].id)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const lockUntilRef = useRef(0)

  // 高亮跟随「判定线以上最后一个分区」，单调语义，与滚动手感一致。
  // 唯一的例外是滚到底：内容不足时最后一个分区永远够不到判定线，
  // 若不兜底，用户明明正看着「关于」、高亮却停在「在线源」。
  const computeActive = () => {
    const scroller = scrollerRef.current
    const line = scroller
      ? scroller.getBoundingClientRect().top + 96
      : window.innerHeight * 0.2
    // 只遍历**当前端可见**的分区：被能力过滤掉的分区没有 DOM 锚点，
    // 遍历它既选不中，也会让「滚到底兜底」落到一个不存在的 id 上
    let next: string = sections[0].id
    for (const { id } of sections) {
      const el = document.getElementById(settingsSectionId(id))
      if (el && el.getBoundingClientRect().top <= line) next = id
    }
    if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      next = sections[sections.length - 1].id
    }
    return next
  }

  useEffect(() => {
    const sync = () => {
      if (Date.now() < lockUntilRef.current) return
      const next = computeActive()
      setActive((prev) => (prev === next ? prev : next))
    }
    sync()
    const scroller = scrollerRef.current
    scroller?.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      scroller?.removeEventListener('scroll', sync)
      window.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
    // 依赖为空：挂载时读一次 ref（此时已绑定），此后只由 scroll/resize 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 滚动到分区：**只滚动内容列**，用 scrollTo 而不是 scrollIntoView。
   *
   * scrollIntoView 会逐级滚动所有可滚祖先，而应用外壳是 `h-screen overflow-hidden` 的
   * 固定布局——它一旦被滚走，页头与整个分区导航就永久移出视口（实测外壳 scrollTop
   * 0 → 236、导航 top 82 → −154）。只动自己那一层，外壳永远不动。
   */
  const scrollTo = (id: string) => {
    setActive(id)
    // 锁定只覆盖平滑滚动的行程：内容列在窗口大小变化时会重排，留一个上限，避免永久锁死
    lockUntilRef.current = Date.now() + 800
    const el = document.getElementById(settingsSectionId(id))
    const scroller = scrollerRef.current
    if (!el) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const smooth: ScrollBehavior = reduceMotion ? 'auto' : 'smooth'
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) {
      // 窄屏：内容列不滚动，页面级锚点滚动（此时没有固定外壳被牵连的问题）
      el.scrollIntoView({ behavior: smooth, block: 'start' })
      return
    }
    // 桌面端：内容列内滚动。目标位置 = 分区相对内容列内容区的偏移 - 12px 顶部呼吸
    const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    const top = scroller.scrollTop + delta - 12
    scroller.scrollTo({ top: Math.max(0, top), behavior: smooth })
  }

  return { active, scrollTo, scrollerRef }
}

/** 设置行：左标签（含一句说明）右控件。整页只用这一种行节奏，避免每项各写一套间距 */
function SettingRow({
  label,
  hint,
  control,
  children,
}: {
  label: string
  hint?: string
  control?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="inset-row px-3 py-3">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="font-text text-caption-strong text-white/85">{label}</p>
          {hint && <p className="font-text text-caption text-white/50 mt-1 leading-[1.5]">{hint}</p>}
        </div>
        {control && <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">{control}</div>}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  )
}

/**
 * 设置分区：卡片 + 标题 + 滚动锚点。
 * 标题从 21px/600 收到 15px/500 —— 分区标题只需"比行标签大一档"，靠字号而非加粗建层级，
 * 中文笔画密，21px 粗体连排五个会把整页压成一片黑。
 */
function SettingsSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={settingsSectionId(id)} data-settings-section={id} className="card-list p-2 pb-3 scroll-mt-2">
      <h2 className="px-3 pt-3 pb-1 font-display text-[15px] font-medium tracking-[-0.2px] text-white/90">{title}</h2>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

export function SettingsPage() {
  const t = useT()
  const locale = useLocale()
  // 语言偏好：读写一律走 localeStore。渲染层由 I18nProvider 负责即时生效，
  // 主进程同步由它的副作用经 electronAPI.i18n.setLocale 发出，这里不额外调用。
  const language = useLocaleStore((s) => s.language)
  const setLanguage = useLocaleStore((s) => s.setLanguage)
  /** 曲库页名：本页多处确认框与提示要引用它，取值在渲染期（模块级求值会冻结语言） */
  const libraryLabel = t(NAV_LABEL_KEYS.library)

  const theme = useLibraryStore((s) => s.theme)
  const setTheme = useLibraryStore((s) => s.setTheme)

  const scanFolders = useLibraryStore((s) => s.scanFolders)
  const downloadDir = useLibraryStore((s) => s.downloadDir)
  const setDownloadDir = useLibraryStore((s) => s.setDownloadDir)
  const downloadQuality = useLibraryStore((s) => s.downloadQuality)
  const setDownloadQuality = useLibraryStore((s) => s.setDownloadQuality)
  const removeScanFolder = useLibraryStore((s) => s.removeScanFolder)

  // 媒体缓存：自定义容量 + 当前占用；平台未实现时隐藏该分区（见下方 supportsAudioCache）
  const audioCacheLimitMB = useLibraryStore((s) => s.audioCacheLimitMB)
  const audioCacheLimitCustomMB = useLibraryStore((s) => s.audioCacheLimitCustomMB)
  const setAudioCacheLimitCustomMB = useLibraryStore((s) => s.setAudioCacheLimitCustomMB)
  const resetAudioCacheLimitToDefault = useLibraryStore((s) => s.resetAudioCacheLimitToDefault)
  const setAudioCacheLimitUnlimited = useLibraryStore((s) => s.setAudioCacheLimitUnlimited)
  const [cacheUsage, setCacheUsage] = useState<{ usedBytes: number; count: number }>({ usedBytes: 0, count: 0 })
  // 输入框是受控的：草稿只在提交时才落库，非法草稿不写入 store。单位是 GB。
  // 「不限制」档（值 0）草稿留空：0 是档位标记而不是用户填的容量，若把它塞进输入框，
  // 用户点到框里再离开就会触发 onBlur 提交，被解析器判成非法并弹「需填 0.5 – 100 GB」，
  // 让人误以为自己的选择出了问题。空串同样是"待填写"的自然表达。
  const cacheLimitDraftOf = (mb: number) => (mb > 0 ? String(mbToGb(mb)) : '')
  const [cacheLimitDraft, setCacheLimitDraft] = useState(cacheLimitDraftOf(audioCacheLimitMB))
  const [cacheLimitInvalid, setCacheLimitInvalid] = useState(false)
  const cacheLimitInputRef = useRef<HTMLInputElement>(null)
  /**
   * 当前值是否恰好等于某个预设档或「不限制」：决定该由哪一行承载选中态。
   * 预设档由第一行的胶囊点亮，第二行只负责展示「不在预设里的手填值」。
   */
  const isPresetCacheLimit =
    audioCacheLimitMB === 0 || GB_PRESETS.some((gb) => gbToMb(gb) === audioCacheLimitMB)
  const supportsAudioCache = typeof platform.getAudioCacheUsage === 'function'
  /** 平台默认容量（MB）：提示行按同一来源换算成 GB 展示，避免与真正生效的默认值漂移 */
  const defaultCacheLimitMB = defaultAudioCacheLimitMB()
  useEffect(() => {
    if (!supportsAudioCache) return
    let mounted = true
    const refresh = async () => {
      const usage = await getAudioCacheUsage()
      if (mounted) setCacheUsage(usage)
    }
    refresh()
    // 播放中缓存占用会变化，低频刷新即可
    const timer = setInterval(refresh, 30000)
    return () => {
      mounted = false
      clearInterval(timer)
    }
  }, [supportsAudioCache])

  // 生效值变化（提交落库 / 切档位 / 恢复默认）后回写输入框，显示的永远是真实生效值
  useEffect(() => {
    setCacheLimitDraft(cacheLimitDraftOf(audioCacheLimitMB))
    setCacheLimitInvalid(false)
  }, [audioCacheLimitMB])

  const refreshCacheUsage = () => {
    void getAudioCacheUsage().then(setCacheUsage)
  }

  const commitCacheLimit = () => {
    // 空草稿视为「未填写」而非「填错」：点了输入框又直接离开不该弹校验文案
    // （「不限制」档下草稿恒为空，那是档位状态，不是用户的输入错误）。
    // 越界与非数字草稿一律返回 null：不写库，只提示合法区间（不做静默钳制）
    if (cacheLimitDraft.trim() === '') {
      setCacheLimitInvalid(false)
      return
    }
    const mb = parseCacheLimitGbDraft(cacheLimitDraft)
    if (mb === null) {
      setCacheLimitInvalid(true)
      return
    }
    setCacheLimitInvalid(false)
    setAudioCacheLimitCustomMB(mb)
    refreshCacheUsage()
  }

  /** 点击档位胶囊：0 是「不限制」专用档，不能走钳制入口（会被钳到 64 MB） */
  const handleSelectCacheLimit = (mb: number) => {
    if (mb === 0) {
      setAudioCacheLimitUnlimited()
    } else {
      setAudioCacheLimitCustomMB(mb)
    }
    refreshCacheUsage()
  }

  const handleResetCacheLimit = () => {
    resetAudioCacheLimitToDefault()
    refreshCacheUsage()
  }

  /** 档位文案：0 是「不限制」的档位标记而非容量数值；GB 值走 Intl 数字格式化，不手写小数位 */
  const cacheLimitLabel = (mb: number) =>
    mb <= 0
      ? t('settings.storage.cache.unlimited')
      : t('settings.storage.cache.gb', { value: formatNumber(Number(mbToGb(mb).toFixed(2)), locale) })

  const handleClearCache = async () => {
    const ok = window.confirm(t('settings.storage.cache.clearConfirm'))
    if (!ok) return
    await clearAudioCache()
    // 封面文件被删除后主进程已把曲库里的 coverPath 置空，这里丢弃会话内缓存的
    // 解析结果并重拉曲库，让封面按需重新提取，而不是一直指向已删文件
    resetCoverCache()
    const tracks = await platform.getAllTracks?.()
    if (tracks) useLibraryStore.getState().setTracks(tracks)
    setCacheUsage({ usedBytes: 0, count: 0 })
    toast(t('settings.storage.cache.cleared'))
  }

  // 平台在运行期不会变，取一次即可；下载目录的文案与路径展示两端不同
  const desktop = isDesktop()
  // 桌面端存绝对路径；移动端存手机存储内的相对路径（选择器返回的形态）
  const downloadDirLabel = desktop
    ? (downloadDir ?? t('settings.storage.downloadDir.desktopUnset'))
    : downloadDir
      ? t('settings.storage.downloadDir.mobilePath', { path: downloadDir })
      : t('settings.storage.downloadDir.mobileUnset', { path: DEFAULT_MOBILE_DOWNLOAD_DIR })

  // 音源配置与网络存储配置**不在本页**：它们按插件归属搬进了各插件自己的设置面板
  // （见 components/plugin/PluginSettingsDialog）。本页只保留与插件无关的曲库设置
  // （扫描目录、下载、缓存），于是"这条配置归谁"不再需要在页面上回答。

  const { devices, selectedDeviceId, setSelectedDeviceId } = useAudioDevices()

  const handleDeviceChange = (deviceId: string) => {
    setSelectedDeviceId(deviceId)
    setOutputDevice(deviceId)
  }

  // 软件更新：手动检查新版本
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateState, setUpdateState] = useState<'idle' | 'latest' | 'error'>('idle')
  // 失败原因（超时 / HTTP 状态码）：一句「检查失败」对排障毫无帮助，两条通道全灭时
  // 用户至少能看出是网络被阻断还是服务端异常
  const [updateError, setUpdateError] = useState<string | null>(null)

  // 内置下载任务状态：横幅与此处共用同一任务，下载中/完成时展示对应入口
  const downloadPhase = useUpdateDownloadStore((s) => s.phase)
  const downloadShow = useUpdateDownloadStore((s) => s.show)

  // ─── 诊断日志 ───
  // 能力探测与音频缓存同一范式：平台没接上落盘能力（Web / 旧版 preload）时
  // 整个分区隐藏，而不是给出一个点了必然失败的按钮。
  const supportsDiagnostics = supportsLogExport()
  const canRevealLogs = supportsLogReveal()
  const [logInfo, setLogInfo] = useState<LogStorageInfo | null>(null)
  const [logExporting, setLogExporting] = useState(false)
  /** 最近一次导出的落盘路径：展示在行内，用户要自己把文件发出来，路径是唯一线索 */
  const [logExportPath, setLogExportPath] = useState<string | null>(null)

  useEffect(() => {
    if (!supportsDiagnostics) return
    let mounted = true
    // 只在进入设置页时取一次：日志文件按天滚动，短时间内不会变，
    // 而 info() 在移动端要逐个 stat 文件，低频调用即可
    void getLogInfo().then((info) => {
      if (mounted) setLogInfo(info)
    })
    return () => {
      mounted = false
    }
  }, [supportsDiagnostics])

  const handleExportLogs = async () => {
    if (logExporting) return
    setLogExporting(true)
    try {
      const result = await exportLogs()
      if (result.ok) {
        setLogExportPath(result.filePath)
        toast(t('settings.diagnostics.export.done', { path: result.filePath }), {
          type: 'success',
          duration: 8000,
          // 路径通常很长且应用内无处可粘贴，给一个复制动作比让用户手抄现实
          action: {
            label: t('settings.diagnostics.export.copyPath'),
            onClick: () => {
              void copyText(result.filePath).then((copied) => {
                if (copied) toast(t('settings.diagnostics.export.copied'))
              })
            },
          },
        })
      } else {
        toast(
          result.reason === 'unsupported'
            ? t('settings.diagnostics.export.unsupported')
            : t('settings.diagnostics.export.failed'),
          { type: 'error', duration: 5000 }
        )
      }
      // 导出会新增文件，占用随之变化 —— 刷新一次状态
      const info = await getLogInfo()
      if (info) setLogInfo(info)
    } finally {
      setLogExporting(false)
    }
  }

  const handleRevealLogs = async () => {
    // 优先定位刚导出的那份文件：用户的心智是「我刚导出的东西在哪」，
    // 没有导出过才退回打开日志目录本身
    const ok = await revealLogs(logExportPath ?? undefined)
    if (!ok) toast(t('settings.diagnostics.reveal.failed'), { type: 'error', duration: 4000 })
  }

  const handleCheckUpdate = async () => {
    if (checking) return
    setChecking(true)
    setUpdateState('idle')
    setUpdateInfo(null)
    setUpdateError(null)
    try {
      const info = await checkForUpdate()
      if (info) {
        setUpdateInfo(info)
      } else {
        setUpdateState('latest')
      }
    } catch (err) {
      setUpdateError(err instanceof Error && err.message ? err.message : null)
      setUpdateState('error')
    } finally {
      setChecking(false)
    }
  }

  // 下载更新：桌面端优先应用内下载（主进程拉包 + 进度对话框 + 下载完直接安装），
  // 其余场景（Web / 移动端 / 无匹配安装包）回退到系统浏览器打开下载页
  const handleDownloadUpdate = () => {
    if (!updateInfo) return
    if (isInAppUpdateAvailable() && updateInfo.assetUrl && updateInfo.assetKind) {
      const started = startInAppDownload({
        url: updateInfo.assetUrl,
        altUrls: updateInfo.assetUrls,
        kind: updateInfo.assetKind,
        version: updateInfo.version,
        // assetLabel 是**文案键**（源：update.service 的 ASSET_LABEL_KEYS），
        // 对话框直接渲染 task.label，所以在这里渲染期取译文
        label: updateInfo.assetLabel ? t(updateInfo.assetLabel) : null,
        size: updateInfo.assetSize,
        digest: updateInfo.assetDigest,
      })
      if (started) return
    }
    openDownloadPage(updateInfo)
  }

  // 移动端文件夹选择器（MobileFolderPicker）由 App 层全局注册与渲染，
  // 这里直接调用 platform.pickFolder() 即可，与 LibraryPage 的"导入音乐"按钮共用同一入口
  const handlePickFolder = async () => {
    const folder = await platform.pickFolder()
    if (folder) {
      useLibraryStore.getState().addScanFolder(folder)
      try {
        await platform.scanFolder?.(folder)
      } catch {
        toast(t('settings.library.scanDirs.pickFailed', { folder }), { type: 'error', duration: 5000 })
      }
    }
  }

  // 选择默认下载目录：设置后下载在线歌曲免对话框直存。
  // 移动端复用同一个目录树选择器，但下传下载场景的文案（默认文案是「选择扫描目录」）；
  // 桌面端走系统原生对话框，忽略该参数。
  const handlePickDownloadDir = async () => {
    const folder = await platform.pickFolder({
      title: t('settings.storage.downloadDir.pickerTitle'),
      description: t('settings.storage.downloadDir.pickerDescription', { path: DEFAULT_MOBILE_DOWNLOAD_DIR }),
    })
    // 移动端选择器返回相对手机存储根的路径；用户在目录树里选了存储根（空串）时按未设置处理，
    // 否则下载的歌曲会散落在存储根目录下
    setDownloadDir(folder || null)
  }

  /**
   * 移除扫描目录：除了解除目录配置，还要把该目录下的曲目从曲库中删除，
   * 否则曲库会残留已移除目录的歌曲（数量对不上、点进去还能播放）。
   * 磁盘文件不受影响，只是不再属于曲库。
   */
  const handleRemoveFolder = async (folder: string) => {
    const prefix = folder.endsWith('/') || folder.endsWith('\\') ? folder : folder + '/'
    const affected = useLibraryStore
      .getState()
      .tracks.filter((t) => t.path === folder || t.path.startsWith(prefix) || t.path.startsWith(prefix.replace(/\//g, '\\'))).length
    const ok = window.confirm(
      affected > 0
        ? t('settings.library.scanDirs.removeConfirmWithCount', { folder, count: affected, library: libraryLabel })
        : t('settings.library.scanDirs.removeConfirm', { folder })
    )
    if (!ok) return
    // 先解除目录配置，避免移除过程中后台扫描又把曲目写回
    removeScanFolder(folder)
    try {
      const remaining = await platform.removeFolder?.(folder)
      if (remaining) useLibraryStore.getState().setTracks(remaining)
    } catch (err) {
      console.warn('移除目录曲目失败，已解除该目录的扫描配置:', err)
    }
  }

  const { active: activeSection, scrollTo: scrollToSection, scrollerRef } = useSettingsSpy()

  return (
    <PageLayout
      // 只收窄内容列：底部留白沿用 PageLayout 默认值——内容列自己滚动后，
      // 其底边仍落在悬浮播放条上方，去掉留白会让「关于」卡片滚到底时压在播放条下面
      className="max-w-[980px]"
      header={
        // 页头只留主标题。原先是「标题 + 一句随分区变化的说明」，但那句说明是分区导航
        // 本身就能传达的信息（导航高亮已经告诉你当前在哪一区），挂在页头上只是噪音。
        // 说明文案已下线；下面内容的首个子元素就是分区标题，与标题之间无需再加第二行。
        <div className="mb-4 md:mb-5">
          <PageTitle>{t('settings.page.title')}</PageTitle>
        </div>
      }
    >
      {/*
        两栏间距：导航列的右分割线到内容卡片之间留 20px。左列自带竖分割线，
        视线有明确边界，20px 足够读出"两个分组"，再大就会让导航像被遗弃在半空。
      */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-5">
        <SettingsNav active={activeSection} onSelect={scrollToSection} />
        <div ref={scrollerRef} className="min-w-0 flex-1 overflow-y-auto scrollbar-thin lg:pr-2 lg:-mr-2">
          <div className="space-y-3 pb-8">
            <SettingsSection id="general" title={t('settings.nav.general')}>
              <div className="px-3 pt-1">
                <p className="font-text text-caption text-white/50 mb-2">{t('settings.general.theme.label')}</p>
                <div className="flex gap-2">
                  {themeOptions.map(({ value, labelKey, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => {
                        setTheme(value)
                        if (value === 'dark') document.documentElement.classList.add('dark')
                        else if (value === 'light') document.documentElement.classList.remove('dark')
                        else {
                          const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
                          document.documentElement.classList.toggle('dark', prefersDark)
                        }
                      }}
                      className={`pill pill-md ${
                        theme === value ? 'pill-mint' : 'pill-soft'
                      }`}
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.6} />
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>
              {/*
                语言项：与主题同一套控件形态（同一行布局 + 同一组胶囊）。
                选项名一律用**该语言自身**书写（简体中文 / English），「跟随系统」按当前语言显示——
                用户看不懂当前界面语言时，母语名是唯一能自救的线索。
                切换只写偏好：渲染层由 I18nProvider 重渲染，主进程语言由它的副作用经 IPC 同步，无需刷新。
              */}
              <div className="px-3 pt-3">
                <p className="font-text text-caption text-white/50 mb-2">
                  {t('settings.general.language.label')}
                </p>
                <div className="flex gap-2">
                  {LANGUAGE_PREFERENCES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={language === value}
                      onClick={() => setLanguage(value)}
                      className={`pill pill-md ${
                        language === value ? 'pill-mint' : 'pill-soft'
                      }`}
                    >
                      {languageOptionLabel(value, locale)}
                    </button>
                  ))}
                </div>
              </div>
              <SettingRow
                label={t('settings.general.outputDevice.label')}
                control={
                  devices.length === 0 ? (
                    <span className="font-text text-caption text-white/50">
                      {t('settings.general.outputDevice.empty')}
                    </span>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inset-field group flex h-9 w-[220px] items-center justify-between gap-2 px-3 font-text text-caption text-white/80"
                        >
                          <span className="truncate text-left">
                            {devices.find((d) => d.deviceId === selectedDeviceId)?.label ??
                              t('settings.general.outputDevice.system')}
                          </span>
                          <ChevronDown className="h-4 w-4 flex-shrink-0 text-white/40 transition-transform duration-200 ease-mineradio group-data-[state=open]:rotate-180" strokeWidth={1.6} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-72 overflow-y-auto scrollbar-thin p-1">
                        {devices.map((d) => (
                          <DropdownMenuItem
                            key={d.deviceId}
                            onClick={() => handleDeviceChange(d.deviceId)}
                            className="gap-2 rounded-xs px-2.5 py-2 text-[13px]"
                          >
                            <span className="truncate">{d.label}</span>
                            {d.deviceId === selectedDeviceId && (
                              <Check className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-mint" strokeWidth={2} />
                            )}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )
                }
              />
            </SettingsSection>

            <SettingsSection id="library" title={libraryLabel}>
              <SettingRow
                label={t('settings.library.scanDirs.label')}
                hint={t('settings.library.scanDirs.hint')}
                control={
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handlePickFolder}>
                    <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    {t('common.action.add')}
                  </Button>
                }
              >
                {scanFolders.length === 0 ? (
                  <p className="font-text text-caption text-white/50">{t('settings.library.scanDirs.empty')}</p>
                ) : (
                  <div className="space-y-2">
                    {scanFolders.map((folder) => (
                      <div key={folder} className="inset-row flex items-center justify-between px-3 py-2.5">
                        <span className="font-text text-caption truncate flex-1 mr-2 text-white/80">{folder}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t('settings.library.scanDirs.removeTitle', { library: libraryLabel })}
                          className="h-7 w-7 rounded-[8px] text-white/40 hover:text-coral hover:bg-coral/10 transition-colors duration-200 ease-mineradio"
                          onClick={() => handleRemoveFolder(folder)}
                        >
                          <Trash2 className="h-4 w-4" strokeWidth={1.6} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </SettingRow>

              {/*
                网络存储**不再在这里**：它不是"曲库页的一个设置"，而是某个存储插件
                （WebDAV / SFTP / SMB）自己的配置。配置按插件归属之后，入口在
                「设置 → 插件」里那个插件的齿轮按钮上，本分区只留本机目录。
                扫描入库、测试连接、账号口令都在那里面 —— 一处入口，不再两处。
              */}
            </SettingsSection>

            {/* 下载与缓存：同属"歌曲落盘"语义——下载音质/目录决定怎么存，
                缓存大小决定播放时占多少磁盘。原先拆成两张卡，各自只有两行内容 */}
            <SettingsSection id="storage" title={t('settings.nav.storage')}>
              <div className="px-3 pt-1">
                <p className="font-text text-caption text-white/50 mb-2">
                  {t('settings.storage.downloadQuality.label')}
                </p>
                <div className="flex gap-2">
                  {downloadQualityOptions.map(({ value, labelKey }) => (
                    <button
                      key={value}
                      onClick={() => setDownloadQuality(value)}
                      className={`pill pill-md ${
                        downloadQuality === value ? 'pill-mint' : 'pill-soft'
                      }`}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {/* 下载目录：桌面端设置后免保存对话框直存；移动端选的是手机存储内的相对目录 */}
              <SettingRow
                label={t('settings.storage.downloadDir.label')}
                hint={desktop ? t('settings.storage.downloadDir.desktopHint') : t('settings.storage.downloadDir.mobileHint')}
                control={
                  <>
                    {downloadDir && (
                      <Button variant="ghost" size="sm" className="h-9 px-3" onClick={() => setDownloadDir(null)}>
                        {desktop ? t('settings.storage.downloadDir.clear') : t('common.action.reset')}
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handlePickDownloadDir}>
                      <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                      {downloadDir ? t('settings.storage.downloadDir.change') : t('common.action.select')}
                    </Button>
                  </>
                }
              >
                <p className="inset-note font-text text-caption text-white/55 px-3 py-2 truncate font-mono">
                  {downloadDirLabel}
                </p>
              </SettingRow>

              {/* 媒体缓存：桌面端与移动端均有实现，Web 等未实现的平台不显示 */}
              {supportsAudioCache && (
                <div className="border-t border-white/[0.06] mx-3 mt-1 pt-3">
                  <SettingRow
                    label={t('settings.storage.cache.label')}
                    hint={
                      // 「不限制」档没有上限可超，继续写「超出上限时自动清理」会自相矛盾
                      audioCacheLimitMB === 0
                        ? t('settings.storage.cache.hintUnlimited', {
                            used: formatBytes(cacheUsage.usedBytes, locale),
                          })
                        : t('settings.storage.cache.hintLimited', {
                            default: cacheLimitLabel(defaultCacheLimitMB),
                            used: formatBytes(cacheUsage.usedBytes, locale),
                          })
                    }
                  >
                    {/* 档位胶囊：预设 GB 档 + 「不限制」，同一套视觉权重，选中态一律 pill-mint。
                        选中判据直接比对落库的 MB，手填值恰好等于某档位时该档位也会亮起。 */}
                    <div className="flex flex-wrap items-center gap-2">
                      {GB_PRESETS.map((gb) => {
                        const presetMB = gbToMb(gb)
                        return (
                          <button
                            key={gb}
                            type="button"
                            onClick={() => handleSelectCacheLimit(presetMB)}
                            className={`pill pill-md ${
                              audioCacheLimitMB === presetMB ? 'pill-mint' : 'pill-soft'
                            }`}
                          >
                            {cacheLimitLabel(presetMB)}
                          </button>
                        )
                      })}
                      <button
                        type="button"
                        onClick={() => handleSelectCacheLimit(0)}
                        className={`pill pill-md ${audioCacheLimitMB === 0 ? 'pill-mint' : 'pill-soft'}`}
                      >
                        {t('settings.storage.cache.unlimited')}
                      </button>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {/* 状态胶囊只在「值不属于任何预设档」时出现（手填值、或移动端 0.5 GB 这类平台默认）：
                          预设档与「不限制」已由上一行承担选中态，再点一个同文案的绿胶囊，
                          就是同一件事说两遍，还看不出该看哪一行。任何时刻只有一个 mint。 */}
                      {!isPresetCacheLimit && (
                        <button
                          type="button"
                          onClick={() => cacheLimitInputRef.current?.focus()}
                          className="pill pill-md pill-mint"
                        >
                          {audioCacheLimitCustomMB
                            ? t('settings.storage.cache.custom', { value: cacheLimitLabel(audioCacheLimitMB) })
                            : t('settings.storage.cache.defaultPill', { value: cacheLimitLabel(audioCacheLimitMB) })}
                        </button>
                      )}
                      <input
                        ref={cacheLimitInputRef}
                        type="number"
                        min={CACHE_LIMIT_MIN_GB}
                        max={CACHE_LIMIT_MAX_GB}
                        step={0.5}
                        inputMode="decimal"
                        value={cacheLimitDraft}
                        placeholder={t('settings.storage.cache.customPlaceholder')}
                        onChange={(e) => {
                          setCacheLimitDraft(e.target.value)
                          setCacheLimitInvalid(false)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitCacheLimit()
                          }
                        }}
                        onBlur={commitCacheLimit}
                        className={`inset-field pill-md w-[7rem] px-4 text-center font-text text-caption tabular-nums text-white/85 ${
                          cacheLimitInvalid ? 'is-invalid' : ''
                        }`}
                      />
                      <span className="font-text text-caption text-white/50">{t('settings.storage.cache.unit')}</span>
                      {audioCacheLimitCustomMB && (
                        <Button variant="ghost" size="sm" className="h-9 px-3" onClick={handleResetCacheLimit}>
                          {t('common.action.reset')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 px-3 text-white/60 hover:text-coral hover:bg-coral/10"
                        onClick={handleClearCache}
                        disabled={cacheUsage.count === 0}
                        title={t('settings.storage.cache.clearTitle')}
                      >
                        <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        {t('common.action.clear')}
                      </Button>
                      {cacheLimitInvalid && (
                        <span className="font-text text-caption text-coral/70">
                          {t('settings.storage.cache.invalid', {
                            min: formatNumber(CACHE_LIMIT_MIN_GB, locale),
                            max: formatNumber(CACHE_LIMIT_MAX_GB, locale),
                          })}
                        </span>
                      )}
                    </div>
                  </SettingRow>
                </div>
              )}
            </SettingsSection>

            <SettingsSection id="plugins" title={t('settings.nav.plugins')}>
              {/*
                这一区**只有插件列表**。音源配置、网络存储配置与插件登录曾经各占一行，
                与插件列表并排放在这里（网络存储那行甚至在「我的音乐」分区里）——
                结果是同一条信息分散在三处：用户在列表里看到插件开着，却要去别处找它的配置。
                现在配置按插件归属，全部收进每个插件的齿轮按钮（PluginSettingsDialog），
                登录也一样。安装 / 卸载 / 启停 / 配置入口因此都在一张卡片上。
              */}
              {/*
                面板的**入场条件是「有插件层」，不是「能装插件」**。

                这两件事必须分开：配置按插件归属之后，音源与网络存储的唯一编辑入口
                就在这个面板的齿轮按钮上 —— 若这里仍沿用旧的「有安装通道才渲染」，
                那么「有执行通道、没有安装通道」的端（老 preload）会连**改已有配置**
                都做不到，而改造前它们至少还能改音源。这是本轮改造引入的回归，判据
                因此改为 `pluginExecutionAvailable() || pluginInstallAvailable()`：
                只要有插件可管，面板就出现；安装那一段由面板内部按能力自己隐藏。
              */}
              {(pluginExecutionAvailable() || pluginInstallAvailable()) && (
                <SettingRow label={t('sources.plugins.title')} hint={t('sources.plugins.desc')}>
                  <PluginManagerPanel />
                </SettingRow>
              )}
            </SettingsSection>

            {/* 关于：版本、更新与许可同属"这套软件本身"，合并后不再平铺两张只读卡片 */}
            <SettingsSection id="about" title={t('settings.nav.about')}>
              <SettingRow
                label={t('settings.about.version')}
                hint={`v${APP_VERSION} · PolyForm Noncommercial 1.0.0`}
                control={
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 px-3 text-white/60"
                      title={t('settings.about.repoTitle')}
                      onClick={() => openExternalUrl(REPO_URL)}
                    >
                      <Github className="h-4 w-4 mr-2" strokeWidth={1.6} />
                      {t('settings.about.repo')}
                    </Button>
                    <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handleCheckUpdate} disabled={checking}>
                      <RefreshCw className={`h-4 w-4 mr-2 ${checking ? 'animate-spin' : ''}`} strokeWidth={1.6} />
                      {checking ? t('settings.about.checking') : t('settings.about.checkUpdate')}
                    </Button>
                  </>
                }
              >
                {updateInfo && (
                  <div className="flex items-center justify-between bg-mint/[0.06] border border-mint/20 rounded-[10px] px-3.5 py-3">
                    <div className="min-w-0 mr-3">
                      <p className="font-text text-caption-strong text-white/90">
                        {t('settings.about.newVersion')} <span className="text-mint font-semibold">v{updateInfo.version}</span>
                      </p>
                      <p className="font-text text-caption text-white/55 mt-0.5 truncate">
                        {downloadPhase === 'downloading'
                          ? t('settings.about.downloading')
                          : downloadPhase === 'done'
                            ? t('settings.about.ready')
                            : updateInfo.assetLabel
                              // assetHint 的 {label} 要的是安装包类型名（人类可读），
                              // 而 assetLabel 是键：必须内层先 t() 再当参数传入
                              ? t('settings.about.assetHint', { label: t(updateInfo.assetLabel) })
                              : t('settings.about.downloadHint')}
                      </p>
                      {updateInfo.installHint && downloadPhase !== 'downloading' && downloadPhase !== 'done' && (
                        <p className="font-text text-caption text-white/50 mt-1 truncate">
                          {t(updateInfo.installHint, { command: updateInfo.installCommand ?? '' })}
                        </p>
                      )}
                    </div>
                    {downloadPhase === 'downloading' || downloadPhase === 'done' ? (
                      <Button
                        size="sm"
                        variant={downloadPhase === 'done' ? 'primary' : 'secondary'}
                        className="h-9 px-3.5"
                        onClick={downloadShow}
                      >
                        <Download className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        {downloadPhase === 'done' ? t('settings.about.continueInstall') : t('settings.about.downloadingButton')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="h-9 px-3.5 bg-mint text-mint-fg font-semibold hover:bg-mint/90"
                        onClick={handleDownloadUpdate}
                      >
                        <Download className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        {t('settings.about.downloadUpdate')}
                      </Button>
                    )}
                  </div>
                )}

                {updateState === 'latest' && (
                  <div className="inset-note flex items-center gap-2 px-3 py-2.5">
                    <CheckCircle2 className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
                    <p className="font-text text-caption text-white/70">{t('settings.about.latest')}</p>
                  </div>
                )}

                {updateState === 'error' && (
                  <div className="inset-note flex items-center gap-2 px-3 py-2.5">
                    <AlertCircle className="h-4 w-4 text-coral flex-shrink-0" strokeWidth={1.6} />
                    <p className="font-text text-caption text-white/70">
                      {updateError
                        ? t('settings.about.checkFailed', { reason: updateError })
                        : t('settings.about.checkFailedFallback')}
                    </p>
                  </div>
                )}
              </SettingRow>
            </SettingsSection>

            {/*
              诊断日志：用户遇到问题时的「把现场交出来」入口。
              放在「关于」之后并按能力探测整体隐藏 —— Web 端与未接上落盘能力的旧版桌面端
              没有这条链路，显示一个点了必然失败的按钮比不显示更糟。
            */}
            {supportsDiagnostics && (
              <SettingsSection id="diagnostics" title={t('settings.nav.diagnostics')}>
                <SettingRow
                  label={t('settings.diagnostics.export.label')}
                  hint={t('settings.diagnostics.export.hint')}
                  control={
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-9 px-3.5"
                      disabled={logExporting}
                      onClick={handleExportLogs}
                    >
                      <FileText className="h-4 w-4 mr-2" strokeWidth={1.6} />
                      {logExporting
                        ? t('settings.diagnostics.export.exporting')
                        : t('settings.diagnostics.export.button')}
                    </Button>
                  }
                >
                  {/* 导出成功后原地展示路径：用户要自己把文件发出来，toast 会消失，
                      而路径需要在他切换到聊天窗口时仍然可见 */}
                  {logExportPath && (
                    <div className="flex items-center gap-2">
                      <p className="font-text text-caption text-mint/80 truncate" title={logExportPath}>
                        {logExportPath}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 flex-shrink-0 px-2 text-white/60"
                        onClick={() => {
                          void copyText(logExportPath).then((copied) => {
                            if (copied) toast(t('settings.diagnostics.export.copied'))
                          })
                        }}
                      >
                        <Copy className="h-3.5 w-3.5 mr-1" strokeWidth={1.6} />
                        {t('settings.diagnostics.export.copyPath')}
                      </Button>
                    </div>
                  )}
                </SettingRow>

                {/* 「打开日志目录」只在平台真有 reveal 能力时出现：移动端没有文件管理器桥，
                    显示出来就是个点了没反应的按钮 */}
                {canRevealLogs && (
                  <SettingRow
                    label={t('settings.diagnostics.reveal.label')}
                    hint={t('settings.diagnostics.reveal.hint')}
                    control={
                      <Button variant="ghost" size="sm" className="h-9 px-3 text-white/60" onClick={handleRevealLogs}>
                        <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        {t('settings.diagnostics.reveal.button')}
                      </Button>
                    }
                  />
                )}

                <SettingRow
                  label={t('settings.diagnostics.storage.label')}
                  hint={
                    logInfo && logInfo.files.length > 0
                      ? t('settings.diagnostics.storage.hint', {
                          files: formatNumber(logInfo.files.length, locale),
                          size: formatBytes(logInfo.totalBytes, locale),
                        })
                      : t('settings.diagnostics.storage.hintEmpty')
                  }
                  control={
                    // 上限写成胶囊而非长句：它是常量说明，不是每次都要读的信息
                    logInfo ? (
                      <span className="font-text text-caption text-white/45">
                        {t('settings.diagnostics.storage.maxHint', {
                          size: formatBytes(logInfo.maxFileBytes, locale),
                          files: formatNumber(logInfo.maxFiles, locale),
                        })}
                      </span>
                    ) : undefined
                  }
                />

                {/*
                  隐私提示是**必需**的一条，不是可选的免责声明：
                  日志可用性建立在「用户愿意把它发出来」之上，而发出来之前他必须知道
                  这里面可能有什么。脱敏只按名字认凭据，歌名 / 文件路径 / 目录名
                  依然会原样出现，所以文案写「请自行检查」而不是「可放心发送」。
                */}
                <div className="inset-note flex items-start gap-2 px-3 py-2.5">
                  <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400/80" strokeWidth={1.6} />
                  <div className="min-w-0">
                    <p className="font-text text-caption-strong text-white/80">
                      {t('settings.diagnostics.privacy.title')}
                    </p>
                    <p className="font-text text-caption mt-1 leading-[1.5] text-white/55">
                      {t('settings.diagnostics.privacy.body')}
                    </p>
                  </div>
                </div>
              </SettingsSection>
            )}
          </div>
        </div>
      </div>

    </PageLayout>
  )
}

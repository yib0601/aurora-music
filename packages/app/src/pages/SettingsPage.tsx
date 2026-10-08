import { useEffect, useRef, useState } from 'react'
import { Monitor, Moon, Sun, FolderOpen, Trash2, Plus, Cloud, RefreshCw, Download, CheckCircle2, AlertCircle, ChevronDown, Pencil, Check, Github } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PageLayout } from '@/components/PageLayout'
import { PageTitle } from '@/components/PageHeading'
import { useLibraryStore, defaultAudioCacheLimitMB } from '@/stores/libraryStore'
import type { LibrarySourceConfig } from '@/types'
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
  LxScriptProbe,
  type LxProbeState,
} from '@/components/common/LxSourceProbe'
import { checkLxScriptLink, lxFormSupported, renderError } from '@/components/common/lxSourceForm'
import {
  buildAuroraEndpoints,
  checkSourceForm,
  formatBytes,
  formatNumber,
  LANGUAGE_PREFERENCES,
  LOCALE_LABELS,
  SYSTEM_LANGUAGE_LABELS,
} from '@aurora/shared'
import type {
  AuroraEndpoints,
  LanguagePreference,
  Locale,
  MessageKey,
  OnlineSourceKind,
} from '@aurora/shared'

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

/**
 * 端点预览压缩：弹窗可用宽度约 400px，整条 URL（host + 长密钥 + 占位符）必被
 * truncate 砍成半截，看不到结构。这里把每条端点压成「路径 + 参数名」：
 * host 与参数值本来就是用户自己填的（填了 key 至少两次），回显没有信息量，
 * 值一律换成 …（占位符原样保留）。一行一眼看得全。
 * 外层原来的 maskPreview / maskKey 仍保留：压缩后密钥已变成 …，它们通常不再命中，
 * 只作为「压缩失败退回原串」时的第二层遮蔽兜底。
 */
function compactEndpointUrl(url: string): string {
  try {
    const u = new URL(url)
    const params = [...u.searchParams.entries()]
      .map(([k, v]) => `${k}=${/^\{.*\}$/.test(v) ? v : '…'}`)
      .join('&')
    return params ? `${u.pathname}?${params}` : u.pathname
  } catch {
    // 不是合法 URL 就原样返回，交给外层 truncate 兜底
    return url
  }
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
 */
const SETTINGS_SECTIONS: ReadonlyArray<{ id: string; labelKey: MessageKey }> = [
  { id: 'general', labelKey: 'settings.nav.general' },
  { id: 'library', labelKey: NAV_LABEL_KEYS.library },
  { id: 'storage', labelKey: 'settings.nav.storage' },
  { id: 'sources', labelKey: 'settings.nav.sources' },
  { id: 'about', labelKey: 'settings.nav.about' },
]

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
      {SETTINGS_SECTIONS.map(({ id, labelKey }) => {
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
  const [active, setActive] = useState<string>(SETTINGS_SECTIONS[0].id)
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
    let next: string = SETTINGS_SECTIONS[0].id
    for (const { id } of SETTINGS_SECTIONS) {
      const el = document.getElementById(settingsSectionId(id))
      if (el && el.getBoundingClientRect().top <= line) next = id
    }
    if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      next = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id
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

/**
 * 单个音源卡片：默认仅展示名称 + 能力标签 + 启用开关；点击编辑展开草稿表单，校验通过后点保存才写入。
 * 两种形态共用这张卡片：kind='lx' 是洛雪音源脚本（链接即脚本地址，字段只有 名称 / 脚本链接 / 请求头），
 * kind='aurora' 走既有的服务地址 / 接口模板那套。探测结果一律不落库，每次进编辑按需现探。
 */
function SourceEditorCard({
  name,
  sourceUrl,
  playlistUrl,
  endpoints,
  headers,
  enabled,
  placeholderUrl,
  playlistPlaceholderUrl,
  kind,
  sourceKind,
  onUpdate,
  onRemove,
}: {
  name: string
  /** 音源地址：用户填的那条链接（端点由软件在执行时解析组装） */
  sourceUrl: string
  /** 歌单解析接口（仅音源有该能力；接口模板形态才手填，服务地址形态由软件派生） */
  playlistUrl?: string
  /** 服务端端点自描述缓存（「测试连接」读到才有） */
  endpoints?: { search?: string; playlist?: string }
  headers?: Record<string, string>
  enabled: boolean
  placeholderUrl: string
  playlistPlaceholderUrl?: string
  kind: 'music' | 'lyrics'
  /** 源形态：缺省视为 aurora，老配置不写该字段 */
  sourceKind?: OnlineSourceKind
  onUpdate: (updates: {
    name?: string
    sourceUrl?: string
    playlistUrl?: string
    endpoints?: { search?: string; playlist?: string }
    headers?: Record<string, string>
    enabled?: boolean
  }) => void
  onRemove: () => void
}) {
  const hasHeaders = headers != null && Object.keys(headers).length > 0
  const isMusic = kind === 'music'
  const isLx = sourceKind === 'lx'
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [showHeaders, setShowHeaders] = useState(hasHeaders)
  const [nameDraft, setNameDraft] = useState(name)
  // 用户填的就是那条链接本身，输入框不做就地改写：形态解析只用于派生预览与保存，打字不会被打断
  const [linkDraft, setLinkDraft] = useState('')
  const [playlistDraft, setPlaylistDraft] = useState(playlistUrl || '')
  const [headersDraft, setHeadersDraft] = useState(() => (hasHeaders ? JSON.stringify(headers, null, 2) : ''))
  const [headersInvalid, setHeadersInvalid] = useState(false)
  const [parsedHeaders, setParsedHeaders] = useState<Record<string, string> | undefined>(headers)
  const [probe, setProbe] = useState<{ loading: boolean; ok?: boolean; message?: string }>({ loading: false })
  // 探测到的服务端端点自描述：存进配置后由执行时组装使用（服务端改路径，配置自动跟上）
  const [probeEndpoints, setProbeEndpoints] = useState<Partial<AuroraEndpoints> | undefined>(endpoints)
  // 洛雪形态的探测结果：只活在本次会话，不写进配置（配置里只留脚本链接）
  const [lxProbe, setLxProbe] = useState<LxProbeState>({ loading: false })

  // 形态与校验都收在 checkSourceForm：链接自身决定形态，不需要用户选
  const linkText = linkDraft.trim()
  const aurora = checkSourceForm({
    kind,
    link: linkDraft,
    playlistUrl: playlistDraft,
    headersInvalid,
  })
  // 校验错误由 checkSourceForm 直接给出结构化信封（code + 参数），渲染期按当前语言取文案
  const { parsed, isService, showPlaylist, canSave: auroraCanSave, linkError, playlistError } = aurora
  // 洛雪形态另走一条校验：脚本链接既不是服务地址也不是接口模板，checkSourceForm 那套判定对它无效
  const lxLinkError = isLx && linkText ? checkLxScriptLink(linkText) : null
  const canSave = isLx ? Boolean(linkText) && !lxLinkError && !headersInvalid : auroraCanSave
  // 预览即执行时真正会用的端点：优先服务端自描述，其次默认约定
  const preview =
    !isLx && isService && parsed ? buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey, probeEndpoints) : null

  // 进入编辑：链接就是配置里存的那条（端点不落库，没有需要还原的派生字段）
  const startEditing = () => {
    setNameDraft(name)
    setLinkDraft(sourceUrl)
    setPlaylistDraft(playlistUrl || '')
    setProbe({ loading: false })
    setProbeEndpoints(endpoints)
    setHeadersDraft(hasHeaders ? JSON.stringify(headers, null, 2) : '')
    setHeadersInvalid(false)
    setParsedHeaders(headers)
    setShowHeaders(hasHeaders)
    setLxProbe({ loading: false })
    setEditing(true)
  }

  // 测试连接：GET 根路径取端点自描述 + 用 /health 验密钥，只读不写配置（仅服务地址形态可探）
  const handleProbe = async () => {
    if (!parsed || parsed.kind !== 'service') return
    setProbe({ loading: true })
    // 探测走平台统一入口：服务形态直连取端点自描述并验密钥，形态差异不落到设置页
    const result = await platform.probeSource({
      kind: 'aurora',
      sourceUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
    })
    setProbe({ loading: false, ok: result.ok, message: result.message })
    setProbeEndpoints(result.endpoints)
  }

  // 端点预览里遮蔽密钥（密钥就在链接里，预览也不明文回显）
  const maskPreview = (url: string) => {
    const key = parsed?.apiKey || ''
    return key ? url.replace(encodeURIComponent(key), '•••') : url
  }

  // 请求头草稿实时解析：合法 JSON 对象才允许保存，否则标记错误
  const handleHeadersChange = (text: string) => {
    setHeadersDraft(text)
    const trimmed = text.trim()
    if (!trimmed) {
      setHeadersInvalid(false)
      setParsedHeaders(undefined)
      return
    }
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setHeadersInvalid(false)
        setParsedHeaders(parsed)
      } else {
        setHeadersInvalid(true)
      }
    } catch {
      setHeadersInvalid(true)
    }
  }

  const handleSave = () => {
    if (!canSave) return
    const displayName = nameDraft.trim() || name
    if (isLx) {
      // 洛雪形态：只存那条脚本链接与请求头，脚本源码不落库（运行时按链接现拉）
      onUpdate({
        name: displayName,
        sourceUrl: linkText,
        headers: parsedHeaders,
        playlistUrl: undefined,
        endpoints: undefined,
      })
      setEditing(false)
      return
    }
    if (isService) {
      // 服务地址形态：只存那条链接（+ 探测到的端点自描述），两个端点由执行时派生
      onUpdate({
        name: displayName,
        sourceUrl: linkText,
        endpoints: probeEndpoints,
        playlistUrl: undefined,
        headers: parsedHeaders,
      })
      setEditing(false)
      return
    }
    const trimmedPlaylist = playlistDraft.trim()
    const alreadyHad = (playlistUrl || '').trim()
    onUpdate({
      name: displayName,
      sourceUrl: linkText,
      // 只在确实有变化时带上歌单解析地址，避免把歌词源的字段写脏
      ...(isMusic && (trimmedPlaylist || alreadyHad) ? { playlistUrl: trimmedPlaylist } : {}),
      headers: parsedHeaders,
      // 接口模板形态：清掉服务端端点缓存（它只对服务地址形态有意义）
      ...(isMusic ? { endpoints: undefined } : {}),
    })
    setEditing(false)
  }

  return (
    <div
      className={`inset-row px-3.5 py-3 ${enabled ? '' : 'opacity-55'}`}
    >
      <div className={`flex items-center gap-2 ${editing ? 'mb-2' : ''}`}>
        {editing ? (
          <input
            type="text"
            value={nameDraft}
            placeholder={t('sources.form.nameDraftPlaceholder')}
            onChange={(e) => setNameDraft(e.target.value)}
            className="flex-1 bg-transparent font-text text-caption-strong text-white/90 outline-none border-b border-transparent focus:border-mint/50 transition-colors duration-200 py-1"
          />
        ) : (
          <>
            <span className="flex-1 font-text text-caption-strong text-white/90 truncate py-1">{name || t('sources.form.unnamed')}</span>
            {/* 能力标签：一眼看出这条音源能搜索、还是也能解析歌单；洛雪脚本源只标形态与平台 */}
            <span className="flex items-center gap-1 flex-shrink-0">
              {isLx ? (
                <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-mint/10 text-mint/80">
                  {t('sources.capability.lxScript')}
                </span>
              ) : (
                <>
                  {sourceUrl.trim() && (
                    <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-mint/10 text-mint/80">
                      {isMusic ? t('sources.capability.search') : t('sources.capability.lyrics')}
                    </span>
                  )}
                  {isMusic && (playlistUrl || '').trim() && (
                    <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-white/[0.06] text-white/55">
                      {t('sources.capability.playlist')}
                    </span>
                  )}
                </>
              )}
            </span>
          </>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onUpdate({ enabled: !enabled })}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
            enabled ? 'bg-mint' : 'bg-white/[0.12]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
              enabled ? 'translate-x-4.5' : 'translate-x-1'
            }`}
          />
        </button>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            title={t('common.action.edit')}
            className="h-7 w-7 rounded-[8px] text-white/40 hover:text-mint hover:bg-mint/10 transition-colors duration-200 ease-mineradio"
            onClick={startEditing}
          >
            <Pencil className="h-4 w-4" strokeWidth={1.6} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-[8px] text-white/40 hover:text-coral hover:bg-coral/10 transition-colors duration-200 ease-mineradio"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.6} />
        </Button>
      </div>
      {editing && (
        <>
          {isLx ? (
            /* 洛雪脚本源：只有一条脚本链接 + 可选请求头，端点与密钥那套对它不适用 */
            <div>
              <p className="font-text text-caption text-white/50 mb-1">{t('sources.form.scriptLabel')}</p>
              <LxScriptProbe
                url={linkDraft}
                headers={parsedHeaders}
                instanceId={`lx-card-${name}-${sourceUrl}`}
                probe={lxProbe}
                onUrlChange={setLinkDraft}
                onProbeChange={setLxProbe}
                invalid={Boolean(lxLinkError)}
                error={lxLinkError}
                compact
              />
              <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.scriptHint')}</p>
            </div>
          ) : (
            <>
          {/* 一条链接搞定：服务地址由软件组装两个端点，接口模板原样使用——形态由链接自身判定 */}
          <div>
            <p className="font-text text-caption text-white/50 mb-1">
              {isMusic ? t('sources.form.sourceLabel') : t('sources.form.apiLabel')}
            </p>
            <input
              type="text"
              value={linkDraft}
              placeholder={isMusic ? 'https://music.lighthouses.top' : placeholderUrl}
              onChange={(e) => {
                setLinkDraft(e.target.value)
                setProbe({ loading: false })
                setProbeEndpoints(undefined)
              }}
              className={`inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70 ${
                linkError ? 'is-invalid' : ''
              }`}
            />
            {linkError ? (
              <p className="font-text text-caption text-coral/70 mt-1">{renderError(linkError, t)}</p>
            ) : isService ? (
              <p className="font-text text-caption text-mint/70 mt-1">
                {parsed?.apiKey ? t('sources.form.sourceDetectedWithKey') : t('sources.form.sourceDetected')}
              </p>
            ) : parsed ? (
              <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.templateDetected')}</p>
            ) : (
              <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.sourceHint')}</p>
            )}
          </div>

          {/* 歌单解析接口只在接口模板形态下手填：服务地址形态的该端点由软件派生 */}
          {showPlaylist && (
            <div className="mt-2">
              <p className="font-text text-caption text-white/50 mb-1">
                {t('sources.form.playlistLabelRequired', { placeholder: '{url}' })}
              </p>
              <input
                type="text"
                value={playlistDraft}
                placeholder={playlistPlaceholderUrl || 'https://your-api.com/resolve?url={url}'}
                onChange={(e) => setPlaylistDraft(e.target.value)}
                className={`inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70 ${
                  playlistError ? 'is-invalid' : ''
                }`}
              />
              {playlistError ? (
                <p className="font-text text-caption text-coral/70 mt-1">{renderError(playlistError, t)}</p>
              ) : (
                <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.playlistHint')}</p>
              )}
            </div>
          )}

          {/* 只有服务地址形态可探：根路径取端点自描述 + /health 验密钥 */}
          {isService && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="h-8 px-3 flex-shrink-0"
                disabled={probe.loading || !linkText}
                onClick={handleProbe}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 mr-1.5 ${probe.loading ? 'animate-spin' : ''}`}
                  strokeWidth={1.6}
                />
                {probe.loading ? t('sources.probe.testing') : t('sources.probe.testConnection')}
              </Button>
              {probe.message && (
                <p className={`font-text text-caption truncate ${probe.ok ? 'text-mint/80' : 'text-coral/80'}`}>
                  {renderError(probe.message, t)}
                </p>
              )}
            </div>
          )}
          {preview && (
            <div className="mt-2 space-y-0.5">
              {/* 先回显软件从这条链接里提取出的服务地址：用户填的可能是裸域名、
                  带 key 的域名，或一条完整端点地址，不写清楚他会以为判定错了 */}
              <p className="font-text text-caption text-white/35 truncate">
                {t('sources.form.previewService', { url: parsed?.baseUrl ?? '' })}
              </p>
              <p className="font-text text-caption text-white/35 truncate">
                {t('sources.form.previewSearch', { url: maskPreview(compactEndpointUrl(preview.search)) })}
              </p>
              <p className="font-text text-caption text-white/35 truncate">
                {t('sources.form.previewPlaylist', { url: maskPreview(compactEndpointUrl(preview.playlist)) })}
              </p>
            </div>
          )}
            </>
          )}
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-white/60 hover:text-white/90"
              onClick={() => setEditing(false)}
            >
              {t('common.action.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-8 px-4 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
              disabled={!canSave}
              onClick={handleSave}
            >
              {t('common.action.save')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/** 添加源弹窗：填写名称 / 接口地址（音源可另填歌单解析接口）/ 请求头，校验通过后才保存进列表 */
function SourceAddDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (source: {
    name: string
    sourceUrl: string
    kind?: OnlineSourceKind
    playlistUrl?: string
    endpoints?: { search?: string; playlist?: string }
    headers?: Record<string, string>
    /** 仅洛雪形态会带：测试不通过时保存为停用，不因一次网络抖动把用户挡在门外 */
    enabled?: boolean
  }) => void
}) {
  const [name, setName] = useState('')
  // 源形态：缺省 Aurora，保持既有用户路径零变化
  const [sourceKind, setSourceKind] = useState<OnlineSourceKind>('aurora')
  // 一条链接：服务地址由软件组装两个端点，接口模板原样使用——形态由链接自身判定；
  // 洛雪形态下这条链接是脚本地址
  const [linkDraft, setLinkDraft] = useState('')
  const [playlistUrl, setPlaylistUrl] = useState('')
  const [headersDraft, setHeadersDraft] = useState('')
  const [headersInvalid, setHeadersInvalid] = useState(false)
  const [headers, setHeaders] = useState<Record<string, string> | undefined>(undefined)
  const [probe, setProbe] = useState<{ loading: boolean; ok?: boolean; message?: string }>({ loading: false })
  const [probeEndpoints, setProbeEndpoints] = useState<Partial<AuroraEndpoints> | undefined>(undefined)
  const [lxProbe, setLxProbe] = useState<LxProbeState>({ loading: false })
  const t = useT()

  // 每次打开重置表单
  useEffect(() => {
    if (open) {
      setName('')
      setSourceKind('aurora')
      setLinkDraft('')
      setPlaylistUrl('')
      setHeadersDraft('')
      setHeadersInvalid(false)
      setHeaders(undefined)
      setProbe({ loading: false })
      setProbeEndpoints(undefined)
      setLxProbe({ loading: false })
    }
  }, [open])

  // 洛雪脚本要在平台侧拉取与执行：桌面端经主进程、移动端走原生 HTTP，纯浏览器（web）没有该能力。
  // 入口就挡掉——不让用户填完链接、点完测试才拿到「不支持」；平台在运行期不会变，取一次即可
  const lxSupported = lxFormSupported({ desktop: isDesktop(), mobile: isMobile() })
  // 洛雪脚本形态：提供的是取址能力，与 aurora 端点的占位符协议并列
  const isLx = sourceKind === 'lx'
  const linkText = linkDraft.trim()
  // 形态与校验都收在 checkSourceForm：链接自身决定形态，不需要用户选
  const aurora = checkSourceForm({
    kind: 'music',
    link: linkDraft,
    playlistUrl,
    headersInvalid,
  })
  const { parsed, isService, showPlaylist, linkError, playlistError } = aurora
  // 洛雪形态另走一条校验：脚本链接既不是服务地址也不是接口模板
  const lxLinkError = isLx ? checkLxScriptLink(linkDraft) : null
  const canSave = isLx
    ? Boolean(linkText) && !lxLinkError && !headersInvalid
    : aurora.canSave
  const preview = !isLx && isService && parsed ? buildAuroraEndpoints(parsed.baseUrl, parsed.apiKey) : null

  // 换形态等于换协议：上一种形态的链接与探测结果都不再适用，一律清空
  const handleKindChange = (next: OnlineSourceKind) => {
    if (next === sourceKind) return
    // 不支持的形态直接忽略：卡片本身已按 disabled 处理，这里是双保险
    if (next === 'lx' && !lxSupported) return
    setSourceKind(next)
    setLinkDraft('')
    setPlaylistUrl('')
    setProbe({ loading: false })
    setProbeEndpoints(undefined)
    setLxProbe({ loading: false })
  }

  const handleProbe = async () => {
    if (!parsed || parsed.kind !== 'service') return
    setProbe({ loading: true })
    // 探测走平台统一入口：服务形态直连取端点自描述并验密钥，形态差异不落到设置页
    const result = await platform.probeSource({
      kind: 'aurora',
      sourceUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
    })
    setProbe({ loading: false, ok: result.ok, message: result.message })
    setProbeEndpoints(result.endpoints)
  }

  // 端点预览里遮蔽密钥（密钥就在链接里，预览也不明文回显）
  const maskKey = (url: string) =>
    parsed?.apiKey ? url.replace(encodeURIComponent(parsed.apiKey), '•••') : url

  const handleHeadersChange = (text: string) => {
    setHeadersDraft(text)
    const trimmed = text.trim()
    if (!trimmed) {
      setHeadersInvalid(false)
      setHeaders(undefined)
      return
    }
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setHeadersInvalid(false)
        setHeaders(parsed)
      } else {
        setHeadersInvalid(true)
      }
    } catch {
      setHeadersInvalid(true)
    }
  }

  const handleSave = () => {
    if (!canSave) return
    const displayName = name.trim() || (isLx ? t('sources.form.defaultNameLx') : t('sources.form.defaultName'))
    if (isLx) {
      // 洛雪形态：只写脚本链接，脚本源码不落库（运行时按链接现拉）。
      // 测试未通过也允许先存，但落 enabled=false——源不可用就不该默认参与搜索，
      // 否则每次搜索都要白等一轮脚本拉取失败；一次网络抖动不会把用户挡在门外。
      onSave({
        name: displayName,
        sourceUrl: linkText,
        kind: 'lx',
        headers,
        enabled: lxProbe.ok === true,
      })
      onOpenChange(false)
      if (lxProbe.ok !== true) {
        toast(t('sources.form.savedDisabled'), { type: 'error', duration: 5000 })
      }
      return
    }
    if (isService) {
      // 服务地址形态：只存那条链接（+ 探测到的端点自描述），两个端点由执行时派生
      onSave({ name: displayName, sourceUrl: linkText, endpoints: probeEndpoints })
      onOpenChange(false)
      return
    }
    const trimmedPlaylist = playlistUrl.trim()
    onSave({
      name: displayName,
      sourceUrl: linkText,
      ...(trimmedPlaylist ? { playlistUrl: trimmedPlaylist } : {}),
      headers,
    })
    onOpenChange(false)
  }

  const inputCls =
    'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">
            {isLx ? t('sources.form.titleLx') : t('sources.form.title')}
          </DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {isLx ? t('sources.form.descLx') : t('sources.form.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* 形态选择：服务地址（端点自动派生）或洛雪脚本 */}
          {(
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.kindLabel')}</p>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { value: 'aurora' as const, labelKey: 'sources.form.kindAurora', hintKey: 'sources.form.kindAuroraHint' },
                    {
                      value: 'lx' as const,
                      labelKey: 'sources.form.kindLx',
                      // 纯浏览器没有脚本执行能力：卡片直接说明原因并禁用，不让用户白填一遍
                      hintKey: lxSupported ? 'sources.form.kindLxHint' : 'sources.form.kindLxHintUnsupported',
                    },
                  ] satisfies ReadonlyArray<{
                    value: OnlineSourceKind
                    labelKey: MessageKey
                    hintKey: MessageKey
                  }>
                ).map((option) => {
                  const disabled = option.value === 'lx' && !lxSupported
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled}
                      title={disabled ? t('sources.form.kindLxDisabledTitle') : undefined}
                      onClick={() => handleKindChange(option.value)}
                      className={`text-left px-3 py-2 rounded-[10px] border transition-colors duration-200 ease-mineradio ${
                        sourceKind === option.value
                          ? 'border-mint/50 bg-mint/[0.08]'
                          : 'border-white/[0.08] hover:border-white/20'
                      } ${disabled ? 'opacity-45 cursor-not-allowed hover:border-white/[0.08]' : ''}`}
                    >
                      <span
                        className={`block font-text text-caption-strong ${
                          sourceKind === option.value ? 'text-mint' : 'text-white/80'
                        }`}
                      >
                        {t(option.labelKey)}
                      </span>
                      <span className="block font-text text-caption text-white/50 mt-0.5">{t(option.hintKey)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.nameLabel')}</p>
            <input
              type="text"
              value={name}
              placeholder={isLx ? t('sources.form.namePlaceholderLx') : t('sources.form.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>
          {isLx ? (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.scriptLabel')}</p>
              <LxScriptProbe
                url={linkDraft}
                headers={headers}
                instanceId="lx-add-dialog"
                probe={lxProbe}
                onUrlChange={setLinkDraft}
                onProbeChange={setLxProbe}
                invalid={Boolean(lxLinkError)}
                error={lxLinkError}
              />
              {!lxLinkError && (
                <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.scriptHint')}</p>
              )}
            </div>
          ) : (
            <>
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.sourceLabel')}</p>
            <input
              type="text"
              value={linkDraft}
              placeholder="https://music.lighthouses.top"
              onChange={(e) => {
                setLinkDraft(e.target.value)
                setProbe({ loading: false })
                setProbeEndpoints(undefined)
              }}
              className={`${inputCls} ${linkError ? 'is-invalid' : ''}`}
            />
            {linkError ? (
              <p className="font-text text-caption text-coral/70 mt-1">{renderError(linkError, t)}</p>
            ) : isService ? (
              <p className="font-text text-caption text-mint/70 mt-1">
                {parsed?.apiKey ? t('sources.form.sourceDetectedWithKey') : t('sources.form.sourceDetected')}
              </p>
            ) : parsed ? (
              <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.templateDetected')}</p>
            ) : (
              <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.sourceHint')}</p>
            )}
          </div>
          {/* 歌单解析接口只在接口模板形态下手填：服务地址形态的该端点由软件派生 */}
          {showPlaylist && (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.playlistLabel')}</p>
              <input
                type="text"
                value={playlistUrl}
                placeholder="https://your-api.com/resolve?url={url}"
                onChange={(e) => setPlaylistUrl(e.target.value)}
                className={`${inputCls} ${playlistError ? 'is-invalid' : ''}`}
              />
              {playlistError ? (
                <p className="font-text text-caption text-coral/70 mt-1">{renderError(playlistError, t)}</p>
              ) : (
                <p className="font-text text-caption text-white/35 mt-1">{t('sources.form.playlistHintDialog')}</p>
              )}
            </div>
          )}
          {/* 只有服务地址形态可探：根路径取端点自描述 + /health 验密钥 */}
          {isService && (
            <>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8 px-3 flex-shrink-0"
                  disabled={probe.loading || !linkText}
                  onClick={handleProbe}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 mr-1.5 ${probe.loading ? 'animate-spin' : ''}`}
                    strokeWidth={1.6}
                  />
                  {probe.loading ? t('sources.probe.testing') : t('sources.probe.testConnection')}
                </Button>
                {probe.message && (
                  <p className={`font-text text-caption truncate ${probe.ok ? 'text-mint/80' : 'text-coral/80'}`}>
                    {renderError(probe.message, t)}
                  </p>
                )}
              </div>
              {preview && (
                <div className="space-y-0.5">
                  <p className="font-text text-caption text-white/35 truncate">
                    {t('sources.form.previewService', { url: parsed?.baseUrl ?? '' })}
                  </p>
                  <p className="font-text text-caption text-white/35 truncate">
                    {t('sources.form.previewSearch', { url: maskKey(compactEndpointUrl(preview.search)) })}
                  </p>
                  <p className="font-text text-caption text-white/35 truncate">
                    {t('sources.form.previewPlaylist', { url: maskKey(compactEndpointUrl(preview.playlist)) })}
                  </p>
                </div>
              )}
            </>
          )}
            </>
          )}
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.form.headersLabel')}</p>
            <textarea
              value={headersDraft}
              placeholder={'{"Authorization": "Bearer ..."}'}
              onChange={(e) => handleHeadersChange(e.target.value)}
              rows={2}
              className={`${inputCls} resize-none ${headersInvalid ? 'is-invalid' : ''}`}
            />
            {headersInvalid && (
              <p className="font-text text-caption text-coral/70 mt-1">
                {t('sources.error.headersJson', { example: '{"Authorization": "Bearer xxx"}' })}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="sm:space-x-2">
          <Button variant="ghost" size="sm" className="h-9 px-3.5 text-white/70" onClick={() => onOpenChange(false)}>
            {t('common.action.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-9 px-3.5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={!canSave}
            onClick={handleSave}
          >
            {t('common.action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 网络存储来源的探测/扫描状态（每个来源一条，互不干扰） */
type LibrarySourceStatus = { loading?: boolean; ok?: boolean; message?: string }

/** 添加网络存储（WebDAV）来源弹窗 */
function LibrarySourceAddDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (source: Omit<LibrarySourceConfig, 'id' | 'enabled'>) => void
}) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rootPath, setRootPath] = useState('')
  const t = useT()

  useEffect(() => {
    if (open) {
      setName('')
      setBaseUrl('')
      setUsername('')
      setPassword('')
      setRootPath('')
    }
  }, [open])

  const urlOk = /^https?:\/\/.+/i.test(baseUrl.trim())
  const canSave = urlOk

  const handleSave = () => {
    if (!canSave) return
    onSave({
      kind: 'webdav',
      name: name.trim() || t('sources.webdav.defaultName'),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      username: username.trim() || undefined,
      password: password || undefined,
      rootPath: rootPath.trim().replace(/^\/+|\/+$/g, ''),
    })
    onOpenChange(false)
  }

  const inputCls =
    'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">{t('sources.webdav.title')}</DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {t('sources.webdav.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.webdav.nameLabel')}</p>
            <input
              type="text"
              value={name}
              placeholder={t('sources.webdav.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.webdav.baseUrlLabel')}</p>
            <input
              type="text"
              value={baseUrl}
              placeholder={t('sources.webdav.baseUrlPlaceholder')}
              onChange={(e) => setBaseUrl(e.target.value)}
              className={`${inputCls} ${baseUrl.trim() && !urlOk ? 'is-invalid' : ''}`}
            />
            <p className="font-text text-caption text-white/40 mt-1">{t('sources.webdav.baseUrlHint')}</p>
          </div>
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.webdav.rootLabel')}</p>
            <input
              type="text"
              value={rootPath}
              placeholder={t('sources.webdav.rootPlaceholder')}
              onChange={(e) => setRootPath(e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.webdav.usernameLabel')}</p>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={inputCls}
                autoComplete="off"
              />
            </div>
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">{t('sources.webdav.passwordLabel')}</p>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
                autoComplete="new-password"
              />
            </div>
          </div>
          <p className="font-text text-caption text-white/40">{t('sources.webdav.passwordHint')}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" className="h-9 px-4 text-white/60 hover:text-white/90" onClick={() => onOpenChange(false)}>
            {t('common.action.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-9 px-5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={!canSave}
            onClick={handleSave}
          >
            {t('common.action.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 网络存储来源卡片：测试连接 / 扫描入库 / 编辑 / 移除 */
function LibrarySourceCard({
  source,
  status,
  onUpdate,
  onProbe,
  onScan,
  onRemove,
}: {
  source: LibrarySourceConfig
  status: LibrarySourceStatus
  onUpdate: (updates: Partial<LibrarySourceConfig>) => void
  onProbe: () => void
  onScan: () => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(source.name)
  const [baseUrlDraft, setBaseUrlDraft] = useState(source.baseUrl || '')
  const [usernameDraft, setUsernameDraft] = useState(source.username || '')
  const [passwordDraft, setPasswordDraft] = useState(source.password || '')
  const [rootPathDraft, setRootPathDraft] = useState(source.rootPath || '')
  const t = useT()

  const startEditing = () => {
    setNameDraft(source.name)
    setBaseUrlDraft(source.baseUrl || '')
    setUsernameDraft(source.username || '')
    setPasswordDraft(source.password || '')
    setRootPathDraft(source.rootPath || '')
    setEditing(true)
  }

  const urlOk = /^https?:\/\/.+/i.test(baseUrlDraft.trim())
  const canSave = urlOk && nameDraft.trim().length > 0

  const handleSave = () => {
    if (!canSave) return
    onUpdate({
      name: nameDraft.trim(),
      baseUrl: baseUrlDraft.trim().replace(/\/+$/, ''),
      username: usernameDraft.trim() || undefined,
      password: passwordDraft || undefined,
      rootPath: rootPathDraft.trim().replace(/^\/+|\/+$/g, ''),
    })
    setEditing(false)
  }

  const inputCls =
    'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'

  return (
    <div className="inset-row px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Cloud className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
        <div className="min-w-0 flex-1">
          <p className="font-text text-caption-strong text-white/85 truncate">{source.name}</p>
          <p className="font-text text-caption text-white/50 truncate">
            WebDAV · {source.baseUrl}
            {source.rootPath ? `/${source.rootPath}` : ''}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={source.enabled}
          title={source.enabled ? t('sources.webdav.enabledTitle') : t('sources.webdav.disabledTitle')}
          onClick={() => onUpdate({ enabled: !source.enabled })}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
            source.enabled ? 'bg-mint' : 'bg-white/[0.12]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
              source.enabled ? 'translate-x-4.5' : 'translate-x-1'
            }`}
          />
        </button>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            title={t('common.action.edit')}
            className="h-7 w-7 rounded-[8px] text-white/40 hover:text-mint hover:bg-mint/10 transition-colors duration-200 ease-mineradio"
            onClick={startEditing}
          >
            <Pencil className="h-4 w-4" strokeWidth={1.6} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          title={t('sources.webdav.removeTitle', { library: t(NAV_LABEL_KEYS.library) })}
          className="h-7 w-7 rounded-[8px] text-white/40 hover:text-coral hover:bg-coral/10 transition-colors duration-200 ease-mineradio"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.6} />
        </Button>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2.5">
          <input
            type="text"
            value={nameDraft}
            placeholder={t('sources.webdav.nameDraftPlaceholder')}
            onChange={(e) => setNameDraft(e.target.value)}
            className={inputCls}
          />
          <input
            type="text"
            value={baseUrlDraft}
            placeholder={t('sources.webdav.baseUrlPlaceholderDraft')}
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            className={`${inputCls} ${baseUrlDraft.trim() && !urlOk ? 'is-invalid' : ''}`}
          />
          <input
            type="text"
            value={rootPathDraft}
            placeholder={t('sources.webdav.rootPlaceholderDraft')}
            onChange={(e) => setRootPathDraft(e.target.value)}
            className={inputCls}
          />
          <div className="grid grid-cols-2 gap-2.5">
            <input
              type="text"
              value={usernameDraft}
              placeholder={t('sources.webdav.usernameLabel')}
              onChange={(e) => setUsernameDraft(e.target.value)}
              className={inputCls}
              autoComplete="off"
            />
            <input
              type="password"
              value={passwordDraft}
              placeholder={t('sources.webdav.passwordLabel')}
              onChange={(e) => setPasswordDraft(e.target.value)}
              className={inputCls}
              autoComplete="new-password"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 px-3 text-white/60 hover:text-white/90" onClick={() => setEditing(false)}>
              {t('common.action.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-8 px-4 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
              disabled={!canSave}
              onClick={handleSave}
            >
              {t('common.action.save')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-3"
            disabled={status.loading}
            onClick={onProbe}
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
            {t('sources.webdav.testConnection')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-3"
            disabled={status.loading}
            onClick={onScan}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${status.loading ? 'animate-spin' : ''}`} strokeWidth={1.6} />
            {t('sources.webdav.scan')}
          </Button>
          {status.message && (
            <p className={`font-text text-caption truncate ${status.ok ? 'text-mint/80' : 'text-coral/80'}`}>
              {status.message}
            </p>
          )}
        </div>
      )}
    </div>
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

  // 音源配置（应用不内置任何源，均由用户按协议配置）
  // 一条音源可同时给出搜索（{query}）、歌单解析（{url}）与歌词（{track}）三种能力
  const onlineSources = useLibraryStore((s) => s.onlineSources)
  const addOnlineSource = useLibraryStore((s) => s.addOnlineSource)
  const updateOnlineSource = useLibraryStore((s) => s.updateOnlineSource)
  const removeOnlineSource = useLibraryStore((s) => s.removeOnlineSource)
  // 网络存储（WebDAV）来源：与上面的在线音源不同，这是会入库的持久曲库来源
  const librarySources = useLibraryStore((s) => s.librarySources)
  const addLibrarySource = useLibraryStore((s) => s.addLibrarySource)
  const updateLibrarySource = useLibraryStore((s) => s.updateLibrarySource)
  const removeLibrarySource = useLibraryStore((s) => s.removeLibrarySource)
  const [libraryStatus, setLibraryStatus] = useState<Record<string, LibrarySourceStatus>>({})
  const [addLibraryOpen, setAddLibraryOpen] = useState(false)
  // 仅桌面端实现了主进程侧的 WebDAV 代理与扫描；Web/移动端不展示该分区
  const supportsLibrarySources = typeof platform.scanLibrarySource === 'function'

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

  // 添加源弹窗开关：弹窗内校验通过后才写入 store，避免假地址被持久化
  const [addMusicOpen, setAddMusicOpen] = useState(false)

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

  /**
   * 测试网络存储连通性：只列举根目录，不递归、不入库，用于确认地址与账号是否正确。
   */
  const handleProbeLibrarySource = async (source: LibrarySourceConfig) => {
    setLibraryStatus((s) => ({ ...s, [source.id]: { loading: true } }))
    try {
      const result = await platform.probeLibrarySource?.(source.id)
      setLibraryStatus((s) => ({
        ...s,
        [source.id]: { loading: false, ok: result?.ok, message: result?.message },
      }))
    } catch (err) {
      setLibraryStatus((s) => ({
        ...s,
        [source.id]: { loading: false, ok: false, message: (err as Error).message },
      }))
    }
  }

  /**
   * 扫描网络存储并入库。渐进式结果经 track:scanned 事件流式刷新曲库，
   * 这里只负责给出「是否完整」的反馈——有目录列举失败时必须明确告知用户，
   * 因为那种情况下应用会保守地跳过缺失清理，曲库可能与远端不一致。
   */
  const handleScanLibrarySource = async (source: LibrarySourceConfig) => {
    setLibraryStatus((s) => ({ ...s, [source.id]: { loading: true } }))
    try {
      const result = await platform.scanLibrarySource?.(source.id)
      if (result?.tracks) useLibraryStore.getState().setTracks(result.tracks)
      const count = result?.tracks.length ?? 0
      setLibraryStatus((s) => ({
        ...s,
        [source.id]: result?.complete
          ? { loading: false, ok: true, message: t('sources.webdav.scanComplete', { count }) }
          : {
              loading: false,
              ok: false,
              message: t('sources.webdav.scanIncomplete', { count: result?.failedDirs ?? 0 }),
            },
      }))
    } catch (err) {
      setLibraryStatus((s) => ({
        ...s,
        [source.id]: { loading: false, ok: false, message: (err as Error).message },
      }))
    }
  }

  /** 移除网络存储来源：连同该来源的曲目一起从曲库删除（远端文件不受影响） */
  const handleRemoveLibrarySource = async (source: LibrarySourceConfig) => {
    const prefix = `webdav:${source.id}/`
    const affected = useLibraryStore.getState().tracks.filter((t) => t.path.startsWith(prefix)).length
    const ok = window.confirm(
      affected > 0
        ? t('sources.webdav.removeConfirmWithCount', { name: source.name, count: affected, library: libraryLabel })
        : t('sources.webdav.removeConfirm', { name: source.name })
    )
    if (!ok) return
    // 先从配置里摘掉，避免移除过程中后台扫描又把曲目写回（与本地目录移除同一套顺序）
    removeLibrarySource(source.id)
    try {
      const remaining = await platform.removeLibrarySource?.(source.id)
      if (remaining) useLibraryStore.getState().setTracks(remaining)
    } catch (err) {
      console.warn('移除来源曲目失败，已解除该来源配置:', err)
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

              {/* 网络存储（仅桌面端）：与本地目录同属曲库来源，合并进本分区，用细分隔线区分 */}
              {supportsLibrarySources && (
                <div className="border-t border-white/[0.06] mx-3 mt-1 pt-3">
                  <SettingRow
                    label={t('settings.library.storage.label')}
                    hint={t('settings.library.storage.hint')}
                    control={
                      <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={() => setAddLibraryOpen(true)}>
                        <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        {t('common.action.add')}
                      </Button>
                    }
                  >
                    {librarySources.length === 0 ? (
                      <p className="font-text text-caption text-white/50">
                        {t('settings.library.storage.empty')}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {librarySources.map((source) => (
                          <LibrarySourceCard
                            key={source.id}
                            source={source}
                            status={libraryStatus[source.id] || {}}
                            onUpdate={(updates) => updateLibrarySource(source.id, updates)}
                            onProbe={() => handleProbeLibrarySource(source)}
                            onScan={() => handleScanLibrarySource(source)}
                            onRemove={() => handleRemoveLibrarySource(source)}
                          />
                        ))}
                      </div>
                    )}
                  </SettingRow>
                </div>
              )}
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

            <SettingsSection id="sources" title={t('settings.nav.sources')}>
              {/* 音源：应用不内置任何源，全部由用户按协议配置。
                  一条音源可同时给出搜索接口与歌单解析接口（标准音源形态下由服务地址自动生成） */}
              <SettingRow
                label={t('sources.form.sourceRowLabel')}
                hint={t('sources.form.sourceRowHint')}
                control={
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={() => setAddMusicOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    {t('common.action.add')}
                  </Button>
                }
              >
                {onlineSources.length === 0 ? (
                  <p className="font-text text-caption text-white/50">{t('sources.form.sourceRowEmpty')}</p>
                ) : (
                  <div className="space-y-2">
                    {onlineSources.map((src) => (
                      <SourceEditorCard
                        key={src.id}
                        name={src.name}
                        sourceUrl={src.sourceUrl}
                        playlistUrl={src.playlistUrl}
                        headers={src.headers}
                        enabled={src.enabled}
                        placeholderUrl="https://your-api.com/search?q={query}"
                        playlistPlaceholderUrl="https://your-api.com/resolve?url={url}"
                        kind="music"
                        sourceKind={src.kind}
                        endpoints={src.endpoints}
                        onUpdate={(updates) => updateOnlineSource(src.id, updates)}
                        onRemove={() => removeOnlineSource(src.id)}
                      />
                    ))}
                  </div>
                )}
              </SettingRow>
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
          </div>
        </div>
      </div>

      <SourceAddDialog
        open={addMusicOpen}
        onOpenChange={setAddMusicOpen}
        onSave={(source) => addOnlineSource({ ...source, enabled: source.enabled ?? true })}
      />
      <LibrarySourceAddDialog
        open={addLibraryOpen}
        onOpenChange={setAddLibraryOpen}
        onSave={(source) => addLibrarySource({ ...source, enabled: true })}
      />
    </PageLayout>
  )
}

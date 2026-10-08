import { useEffect, useRef, useState } from 'react'
import { Monitor, Moon, Sun, FolderOpen, Trash2, Plus, Cloud, RefreshCw, Download, CheckCircle2, AlertCircle, ChevronDown, Pencil, Check, Github } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PageLayout } from '@/components/PageLayout'
import { useLibraryStore, defaultAudioCacheLimitMB } from '@/stores/libraryStore'
import type { LibrarySourceConfig } from '@/types'
import { useAudioDevices } from '@/hooks/useAudioDevices'
import { setOutputDevice } from '@/services/audio.service'
import { platform, DEFAULT_MOBILE_DOWNLOAD_DIR } from '@/services/platform'
import { isDesktop, isMobile } from '@/lib/utils'
import {
  CACHE_LIMIT_MAX_GB,
  CACHE_LIMIT_MIN_GB,
  formatCacheLimit,
  GB_PRESETS,
  gbToMb,
  mbToGb,
  parseCacheLimitGbDraft,
} from '@/lib/cacheLimit'
import { LIBRARY_LABEL } from '@/lib/routes'
import { toast } from '@/components/common/Toast'
import { APP_VERSION, REPO_URL, checkForUpdate, openDownloadPage, type UpdateInfo } from '@/services/update.service'
import { isInAppUpdateAvailable, startInAppDownload, useUpdateDownloadStore } from '@/stores/updateDownloadStore'
import { getAudioCacheUsage, clearAudioCache } from '@/services/audioCache.service'
import { resetCoverCache } from '@/components/common/CoverImage'
import {
  LxScriptProbe,
  type LxProbeState,
} from '@/components/common/LxSourceProbe'
import { checkLxScriptLink, lxFormSupported } from '@/components/common/lxSourceForm'
import {
  buildAuroraEndpoints,
  checkSourceForm,
  probeAuroraService,
} from '@aurora/shared'
import type { AuroraEndpoints, LxSourceInspection, OnlineSourceKind } from '@aurora/shared'

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

const themeOptions = [
  { value: 'dark' as const, label: '深色', icon: Moon },
  { value: 'light' as const, label: '浅色', icon: Sun },
  { value: 'system' as const, label: '跟随系统', icon: Monitor },
]

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

function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '0 MB'
  const mb = n / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

/** 下载音质档位：值对应歌源协议的 {quality} 占位符与 qualityUrls 键 */
const downloadQualityOptions = [
  { value: '128' as const, label: '标准 128k' },
  { value: '320' as const, label: '高品质 320k' },
  { value: 'flac' as const, label: '无损 FLAC' },
]

/**
 * 设置分区表：左侧导航、分区标题、滚动锚点三处共用这一份 id/名称，避免改一处漏两处。
 * 顺序即用户的任务顺序：先调外观 → 再管曲库来源 → 再管落盘 → 再管在线源 → 最后是版本信息。
 *
 * 分区数刻意收在 5 个：原来的「下载」「缓存」「软件更新」「关于」四个卡片各自只有一两行内容，
 * 平铺出来是四张等重卡片，用户扫读时要逐个读标题才知道哪个是哪个；合并后
 * 「下载 + 缓存」同属落盘语义、「软件更新 + 关于」同属版本语义，导航一眼可辨。
 */
const SETTINGS_SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'library', label: LIBRARY_LABEL },
  { id: 'storage', label: '下载与缓存' },
  { id: 'sources', label: '在线源' },
  { id: 'about', label: '关于' },
] as const

/** 分区 DOM id：导航、滚动定位与 spy 共用，禁止在别处拼字面量 */
const settingsSectionId = (id: string) => `settings-${id}`

/**
 * 页头那句动态说明：每个分区一句，随导航选中项切换。
 * 原先这些解释散在各卡片的第一行（每张卡都要一句"这卡是干什么的"），
 * 收拢到页头后，卡片里只剩行标签与必要提示。
 */
const settingsSectionHint: Record<string, string> = {
  general: '主题与播放设备',
  library: '本地目录与网络存储，扫描入库的来源',
  storage: '下载音质、落盘目录与播放缓存',
  sources: '配置在线音源与歌词源',
  about: '版本、更新与开源许可',
}

/**
 * 分区导航：桌面端左侧常驻竖排，窄屏退化为顶部胶囊条。
 * 窄屏用 flex-wrap 换行而非横向滚动：5 个中文标签在 390px 宽下会超出屏幕，
 * 横向滚动条会把最后一项藏起来，用户不知道还有分区没看到。
 * 桌面端 `self-start` 让 nav 高度只占内容高——不写死高度、也不依赖 sticky：
 * 滚动发生在右侧内容列内部，整页并不滚动，sticky 在这里是死代码。
 * 选中态**刻意与主导航不同**：主导航用低透 mint 底 + mint 字（全局方位锚点，要克制），
 * 这里用实心 mint + 深墨字 —— 低透叠色在浅色主题下只有 2.84:1，达不到正文阈值。
 */
function SettingsNav({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  return (
    <nav
      data-settings-nav
      className="flex flex-wrap gap-1.5 pb-3 lg:w-[152px] lg:flex-shrink-0 lg:flex-col lg:flex-nowrap lg:self-start lg:gap-0.5 lg:pb-0"
    >
      {SETTINGS_SECTIONS.map(({ id, label }) => {
        const on = active === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-current={on ? 'true' : undefined}
            // 选中态用实心 mint 底 + 深墨字：低透 mint 底 + mint 字（原做法）在浅色主题下
            // 同色相叠加只有 2.84:1，达不到正文阈值。前景**刻意硬编码** #030608 而不是
            // 用 `text-mint-fg`——那个 token 是为 Tailwind 的 bg-mint 设计的，浅色下翻成白字，
            // 在白字 on #009C88 只有 3.44:1，会退化（与 globals.css 的 .btn-primary 同一理由）。
            // 深墨字在两种主题的 mint 底上分别是 14.5:1 / 5.9:1。
            className={`h-8 flex-shrink-0 whitespace-nowrap rounded-full border px-3 font-text text-[12px] tracking-[-0.2px] transition-colors duration-200 ease-mineradio lg:h-9 lg:rounded-ds-media lg:text-[13px] lg:text-left ${
              on
                ? 'border-transparent bg-mint font-semibold text-[#030608]'
                : 'border-transparent text-white/55 hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-white/85'
            }`}
          >
            {label}
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
  const { parsed, isService, linkError, showPlaylist, playlistError } = aurora
  // 洛雪形态另走一条校验：脚本链接既不是服务地址也不是接口模板，checkSourceForm 那套判定对它无效
  const lxLinkError = isLx && linkText ? checkLxScriptLink(linkText) : null
  const canSave = isLx ? Boolean(linkText) && !lxLinkError && !headersInvalid : aurora.canSave
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
    const result = await probeAuroraService(parsed.baseUrl, parsed.apiKey)
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
            placeholder="源名称"
            onChange={(e) => setNameDraft(e.target.value)}
            className="flex-1 bg-transparent font-text text-caption-strong text-white/90 outline-none border-b border-transparent focus:border-mint/50 transition-colors duration-200 py-1"
          />
        ) : (
          <>
            <span className="flex-1 font-text text-caption-strong text-white/90 truncate py-1">{name || '未命名源'}</span>
            {/* 能力标签：一眼看出这条音源能搜索、还是也能解析歌单；洛雪脚本源只标形态与平台 */}
            <span className="flex items-center gap-1 flex-shrink-0">
              {isLx ? (
                <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-mint/10 text-mint/80">
                  洛雪脚本
                </span>
              ) : (
                <>
                  {sourceUrl.trim() && (
                    <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-mint/10 text-mint/80">
                      {isMusic ? '搜索' : '歌词'}
                    </span>
                  )}
                  {isMusic && (playlistUrl || '').trim() && (
                    <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-white/[0.06] text-white/55">
                      歌单
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
            title="编辑"
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
              <p className="font-text text-caption text-white/50 mb-1">脚本链接</p>
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
              <p className="font-text text-caption text-white/35 mt-1">
                脚本提供取址能力；没有搜索接口的脚本，需要另配一条 Aurora 音源用于搜索
              </p>
            </div>
          ) : (
            <>
          {/* 一条链接搞定：服务地址由软件组装两个端点，接口模板原样使用——形态由链接自身判定 */}
          <div>
            <p className="font-text text-caption text-white/50 mb-1">{isMusic ? '音源地址' : '接口地址'}</p>
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
              <p className="font-text text-caption text-coral/70 mt-1">{linkError}</p>
            ) : isService ? (
              <p className="font-text text-caption text-mint/70 mt-1">
                {parsed?.apiKey
                  ? '已识别为服务地址，密钥已提取；搜索与歌单接口自动生成'
                  : '已识别为服务地址；搜索与歌单接口自动生成，密钥可写在链接里'}
              </p>
            ) : parsed ? (
              <p className="font-text text-caption text-white/35 mt-1">按接口模板使用，占位符由软件替换</p>
            ) : (
              <p className="font-text text-caption text-white/35 mt-1">
                服务地址或完整接口地址都行；密钥写在链接里即可，如 https://host?key=xxx
              </p>
            )}
          </div>

          {/* 歌单解析接口只在接口模板形态下手填：服务地址形态的该端点由软件派生 */}
          {showPlaylist && (
            <div className="mt-2">
              <p className="font-text text-caption text-white/50 mb-1">歌单解析接口（可选，需含 {'{url}'}）</p>
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
                <p className="font-text text-caption text-coral/70 mt-1">{playlistError}</p>
              ) : (
                <p className="font-text text-caption text-white/35 mt-1">留空表示该音源不参与歌单导入</p>
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
                {probe.loading ? '测试中…' : '测试连接'}
              </Button>
              {probe.message && (
                <p className={`font-text text-caption truncate ${probe.ok ? 'text-mint/80' : 'text-coral/80'}`}>
                  {probe.message}
                </p>
              )}
            </div>
          )}
          {preview && (
            <div className="mt-2 space-y-0.5">
              {/* 先回显软件从这条链接里提取出的服务地址：用户填的可能是裸域名、
                  带 key 的域名，或一条完整端点地址，不写清楚他会以为判定错了 */}
              <p className="font-text text-caption text-white/35 truncate">服务 {parsed?.baseUrl}</p>
              <p className="font-text text-caption text-white/35 truncate">搜索 {maskPreview(compactEndpointUrl(preview.search))}</p>
              <p className="font-text text-caption text-white/35 truncate">歌单 {maskPreview(compactEndpointUrl(preview.playlist))}</p>
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
              取消
            </Button>
            <Button
              size="sm"
              className="h-8 px-4 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
              disabled={!canSave}
              onClick={handleSave}
            >
              保存
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
  kind,
  onOpenChange,
  onSave,
}: {
  open: boolean
  kind: 'music' | 'lyrics'
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

  const isLyrics = kind === 'lyrics'
  // 洛雪脚本要在平台侧拉取与执行：桌面端经主进程、移动端走原生 HTTP，纯浏览器（web）没有该能力。
  // 入口就挡掉——不让用户填完链接、点完测试才拿到「不支持」；平台在运行期不会变，取一次即可
  const lxSupported = lxFormSupported({ desktop: isDesktop(), mobile: isMobile() })
  // 只有音乐源有洛雪形态（它提供的是取址能力，歌词源那套占位符协议与它无关）
  const isLx = kind === 'music' && sourceKind === 'lx'
  const linkText = linkDraft.trim()
  // 形态与校验都收在 checkSourceForm：链接自身决定形态，不需要用户选
  const aurora = checkSourceForm({
    kind,
    link: linkDraft,
    playlistUrl,
    headersInvalid,
  })
  const { parsed, isService, linkError, showPlaylist, playlistError } = aurora
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
    const result = await probeAuroraService(parsed.baseUrl, parsed.apiKey)
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
    const displayName = name.trim() || (isLyrics ? '新歌词源' : isLx ? '新洛雪源' : '新音源')
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
        toast('脚本未测试通过，已保存为停用；测试通过后可在列表中启用', { type: 'error', duration: 5000 })
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
      ...(!isLyrics && trimmedPlaylist ? { playlistUrl: trimmedPlaylist } : {}),
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
            {isLyrics ? '添加歌词源' : isLx ? '添加洛雪音源' : '添加音源'}
          </DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {isLyrics
              ? '接口地址需含 {track} 与 {artist} 占位符'
              : isLx
                ? '粘贴脚本链接，脚本提供取址能力'
                : '服务地址自动生成接口，接口模板原样使用'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* 形态选择：只有音乐源有两种形态，歌词源固定接口模板，不显示该区块（既有路径零变化） */}
          {!isLyrics && (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">音源形态</p>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { value: 'aurora' as const, label: 'Aurora 协议源', hint: '服务地址 / 接口模板' },
                    {
                      value: 'lx' as const,
                      label: '洛雪音源脚本',
                      // 纯浏览器没有脚本执行能力：卡片直接说明原因并禁用，不让用户白填一遍
                      hint: lxSupported ? '脚本链接（取址）' : '仅桌面端 / 手机端支持',
                    },
                  ]
                ).map((option) => {
                  const disabled = option.value === 'lx' && !lxSupported
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled}
                      title={disabled ? '浏览器环境不支持洛雪音源脚本，请使用桌面端或手机端' : undefined}
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
                        {option.label}
                      </span>
                      <span className="block font-text text-caption text-white/50 mt-0.5">{option.hint}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">名称（可选）</p>
            <input
              type="text"
              value={name}
              placeholder={isLyrics ? '如：LRCLIB' : isLx ? '如：我的洛雪源' : '如：我的音源'}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>
          {isLx ? (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">脚本链接</p>
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
                <p className="font-text text-caption text-white/35 mt-1">
                  脚本提供取址能力；没有搜索接口的脚本，需要另配一条 Aurora 音源用于搜索
                </p>
              )}
            </div>
          ) : (
            <>
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{isLyrics ? '接口地址' : '音源地址'}</p>
            <input
              type="text"
              value={linkDraft}
              placeholder={
                isLyrics
                  ? 'https://lrclib.net/api/search?track_name={track}&artist_name={artist}'
                  : 'https://music.lighthouses.top'
              }
              onChange={(e) => {
                setLinkDraft(e.target.value)
                setProbe({ loading: false })
                setProbeEndpoints(undefined)
              }}
              className={`${inputCls} ${linkError ? 'is-invalid' : ''}`}
            />
            {linkError ? (
              <p className="font-text text-caption text-coral/70 mt-1">{linkError}</p>
            ) : isService ? (
              <p className="font-text text-caption text-mint/70 mt-1">
                {parsed?.apiKey
                  ? '已识别为服务地址，密钥已提取；搜索与歌单接口自动生成'
                  : '已识别为服务地址；搜索与歌单接口自动生成，密钥可写在链接里'}
              </p>
            ) : parsed ? (
              <p className="font-text text-caption text-white/35 mt-1">按接口模板使用，占位符由软件替换</p>
            ) : (
              <p className="font-text text-caption text-white/35 mt-1">
                {isLyrics
                  ? '填接口地址即可，占位符由软件替换为当前歌曲信息'
                  : '服务地址或完整接口地址都行；密钥写在链接里即可，如 https://host?key=xxx'}
              </p>
            )}
          </div>
          {/* 歌单解析接口只在接口模板形态下手填：服务地址形态的该端点由软件派生 */}
          {showPlaylist && (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">歌单解析接口（可选）</p>
              <input
                type="text"
                value={playlistUrl}
                placeholder="https://your-api.com/resolve?url={url}"
                onChange={(e) => setPlaylistUrl(e.target.value)}
                className={`${inputCls} ${playlistError ? 'is-invalid' : ''}`}
              />
              {playlistError ? (
                <p className="font-text text-caption text-coral/70 mt-1">{playlistError}</p>
              ) : (
                <p className="font-text text-caption text-white/35 mt-1">
                  填入后，导入歌单时可直接解析 QQ / 网易云等平台的歌单分享链接
                </p>
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
                  {probe.loading ? '测试中…' : '测试连接'}
                </Button>
                {probe.message && (
                  <p className={`font-text text-caption truncate ${probe.ok ? 'text-mint/80' : 'text-coral/80'}`}>
                    {probe.message}
                  </p>
                )}
              </div>
              {preview && (
                <div className="space-y-0.5">
                  <p className="font-text text-caption text-white/35 truncate">服务 {parsed?.baseUrl}</p>
                  <p className="font-text text-caption text-white/35 truncate">搜索 {maskKey(compactEndpointUrl(preview.search))}</p>
                  <p className="font-text text-caption text-white/35 truncate">歌单 {maskKey(compactEndpointUrl(preview.playlist))}</p>
                </div>
              )}
            </>
          )}
            </>
          )}
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">请求头（可选，JSON 对象）</p>
            <textarea
              value={headersDraft}
              placeholder={'{"Authorization": "Bearer ..."}'}
              onChange={(e) => handleHeadersChange(e.target.value)}
              rows={2}
              className={`${inputCls} resize-none ${headersInvalid ? 'is-invalid' : ''}`}
            />
            {headersInvalid && (
              <p className="font-text text-caption text-coral/70 mt-1">JSON 格式无效：需为对象，如 {'{"Authorization": "Bearer xxx"}'}</p>
            )}
          </div>
        </div>
        <DialogFooter className="sm:space-x-2">
          <Button variant="ghost" size="sm" className="h-9 px-3.5 text-white/70" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-9 px-3.5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={!canSave}
            onClick={handleSave}
          >
            保存
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
      name: name.trim() || '网络存储',
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
          <DialogTitle className="text-white text-tagline">添加网络存储</DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            支持标准 WebDAV：群晖 / 威联通 / Nextcloud / rclone serve webdav 等。添加后可先「测试连接」，再扫描入库。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">名称（可选）</p>
            <input
              type="text"
              value={name}
              placeholder="如：家里的群晖"
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">服务地址</p>
            <input
              type="text"
              value={baseUrl}
              placeholder="如：https://nas.example.com:5006/dav"
              onChange={(e) => setBaseUrl(e.target.value)}
              className={`${inputCls} ${baseUrl.trim() && !urlOk ? 'is-invalid' : ''}`}
            />
            <p className="font-text text-caption text-white/40 mt-1">
              群晖为 http(s)://主机:5006/共享文件夹名；Nextcloud 为 https://主机/remote.php/dav/files/用户名
            </p>
          </div>
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">音乐库根目录（可选）</p>
            <input
              type="text"
              value={rootPath}
              placeholder="如：Music，留空表示服务地址本身"
              onChange={(e) => setRootPath(e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">用户名（可选）</p>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={inputCls}
                autoComplete="off"
              />
            </div>
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">口令（可选）</p>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
                autoComplete="new-password"
              />
            </div>
          </div>
          <p className="font-text text-caption text-white/40">
            口令仅保存在本机配置中，不会写入曲库、也不会出现在播放地址里（远端请求由主进程代理）。
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" className="h-9 px-4 text-white/60 hover:text-white/90" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-9 px-5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={!canSave}
            onClick={handleSave}
          >
            添加
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
          title={source.enabled ? '已启用（启动时自动扫描该来源）' : '已停用（启动时不再自动扫描，可手动扫描）'}
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
            title="编辑"
            className="h-7 w-7 rounded-[8px] text-white/40 hover:text-mint hover:bg-mint/10 transition-colors duration-200 ease-mineradio"
            onClick={startEditing}
          >
            <Pencil className="h-4 w-4" strokeWidth={1.6} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          title={`移除来源（同时从${LIBRARY_LABEL}移除该来源的歌曲）`}
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
            placeholder="名称"
            onChange={(e) => setNameDraft(e.target.value)}
            className={inputCls}
          />
          <input
            type="text"
            value={baseUrlDraft}
            placeholder="服务地址，如 https://nas.example.com:5006/dav"
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            className={`${inputCls} ${baseUrlDraft.trim() && !urlOk ? 'is-invalid' : ''}`}
          />
          <input
            type="text"
            value={rootPathDraft}
            placeholder="音乐库根目录（可选），如 Music"
            onChange={(e) => setRootPathDraft(e.target.value)}
            className={inputCls}
          />
          <div className="grid grid-cols-2 gap-2.5">
            <input
              type="text"
              value={usernameDraft}
              placeholder="用户名（可选）"
              onChange={(e) => setUsernameDraft(e.target.value)}
              className={inputCls}
              autoComplete="off"
            />
            <input
              type="password"
              value={passwordDraft}
              placeholder="口令（可选）"
              onChange={(e) => setPasswordDraft(e.target.value)}
              className={inputCls}
              autoComplete="new-password"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-8 px-3 text-white/60 hover:text-white/90" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              size="sm"
              className="h-8 px-4 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
              disabled={!canSave}
              onClick={handleSave}
            >
              保存
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
            测试连接
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-3"
            disabled={status.loading}
            onClick={onScan}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${status.loading ? 'animate-spin' : ''}`} strokeWidth={1.6} />
            扫描入库
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

  const handleClearCache = async () => {
    const ok = window.confirm('清空全部缓存？')
    if (!ok) return
    await clearAudioCache()
    // 封面文件被删除后主进程已把曲库里的 coverPath 置空，这里丢弃会话内缓存的
    // 解析结果并重拉曲库，让封面按需重新提取，而不是一直指向已删文件
    resetCoverCache()
    const tracks = await platform.getAllTracks?.()
    if (tracks) useLibraryStore.getState().setTracks(tracks)
    setCacheUsage({ usedBytes: 0, count: 0 })
    toast('缓存已清空')
  }

  // 平台在运行期不会变，取一次即可；下载目录的文案与路径展示两端不同
  const desktop = isDesktop()
  // 桌面端存绝对路径；移动端存手机存储内的相对路径（选择器返回的形态）
  const downloadDirLabel = desktop
    ? (downloadDir ?? '未设置（每次下载都会询问保存位置）')
    : downloadDir
      ? `手机存储/${downloadDir}`
      : `未设置（默认存入 手机存储/${DEFAULT_MOBILE_DOWNLOAD_DIR}）`

  // 音源与歌词源配置（应用不内置任何源，均由用户按协议配置）
  // 一条音源可同时给出搜索（{query}）与歌单解析（{url}）两个接口
  const onlineSources = useLibraryStore((s) => s.onlineSources)
  const addOnlineSource = useLibraryStore((s) => s.addOnlineSource)
  const updateOnlineSource = useLibraryStore((s) => s.updateOnlineSource)
  const removeOnlineSource = useLibraryStore((s) => s.removeOnlineSource)
  const lyricsSources = useLibraryStore((s) => s.lyricsSources)
  const addLyricsSource = useLibraryStore((s) => s.addLyricsSource)
  const updateLyricsSource = useLibraryStore((s) => s.updateLyricsSource)
  const removeLyricsSource = useLibraryStore((s) => s.removeLyricsSource)

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
  const [addLyricsOpen, setAddLyricsOpen] = useState(false)

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
        label: updateInfo.assetLabel,
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
        toast(`扫描目录「${folder}」失败，请检查目录是否存在且可访问`, { type: 'error', duration: 5000 })
      }
    }
  }

  // 选择默认下载目录：设置后下载在线歌曲免对话框直存。
  // 移动端复用同一个目录树选择器，但下传下载场景的文案（默认文案是「选择扫描目录」）；
  // 桌面端走系统原生对话框，忽略该参数。
  const handlePickDownloadDir = async () => {
    const folder = await platform.pickFolder({
      title: '选择下载目录',
      description: `在线歌曲将直接保存到该目录，不再存入默认的 ${DEFAULT_MOBILE_DOWNLOAD_DIR}`,
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
        ? `移除扫描目录「${folder}」？\n该目录下的 ${affected} 首歌曲会同时从${LIBRARY_LABEL}中移除（磁盘文件不会被删除）。`
        : `移除扫描目录「${folder}」？`
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
          ? { loading: false, ok: true, message: `扫描完成，曲库共 ${count} 首` }
          : {
              loading: false,
              ok: false,
              message: `扫描完成，但有 ${result?.failedDirs ?? 0} 个目录无法访问，已保留原记录`,
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
        ? `移除网络存储「${source.name}」？\n该来源下的 ${affected} 首歌曲会同时从${LIBRARY_LABEL}中移除（远端文件不会被删除）。`
        : `移除网络存储「${source.name}」？`
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
        // 页面头压到一行：标题 + 一句动态说明。原先是 64px 图标块 + 主标题 + 副标题三行，
        // 只说明"这是设置页"，占掉首屏近 120px；分区导航本身已经承担了页面识别。
        // 说明文案按当前分区变化，把原本铺在卡片里的解释收拢到一处。
        <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 md:mb-5">
          <h1 className="font-display text-[24px] font-medium tracking-[-0.02em] text-white/[0.98] leading-tight">
            设置
          </h1>
          <p className="font-text text-[12px] text-white/50 tracking-[-0.2px]">
            {settingsSectionHint[activeSection]}
          </p>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-8">
        <SettingsNav active={activeSection} onSelect={scrollToSection} />
        <div ref={scrollerRef} className="min-w-0 flex-1 overflow-y-auto scrollbar-thin lg:pr-2 lg:-mr-2">
          <div className="space-y-3 pb-8">
            <SettingsSection id="general" title="通用">
              <div className="px-3 pt-1">
                <p className="font-text text-caption text-white/50 mb-2">主题</p>
                <div className="flex gap-2">
                  {themeOptions.map(({ value, label, icon: Icon }) => (
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
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <SettingRow
                label="输出设备"
                control={
                  devices.length === 0 ? (
                    <span className="font-text text-caption text-white/50">未检测到可用设备</span>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inset-field group flex h-9 w-[220px] items-center justify-between gap-2 px-3 font-text text-caption text-white/80"
                        >
                          <span className="truncate text-left">
                            {devices.find((d) => d.deviceId === selectedDeviceId)?.label ?? '系统默认'}
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

            <SettingsSection id="library" title={LIBRARY_LABEL}>
              <SettingRow
                label="扫描目录"
                hint="应用自动扫描这些目录里的音乐文件"
                control={
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handlePickFolder}>
                    <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    添加
                  </Button>
                }
              >
                {scanFolders.length === 0 ? (
                  <p className="font-text text-caption text-white/50">尚未添加目录</p>
                ) : (
                  <div className="space-y-2">
                    {scanFolders.map((folder) => (
                      <div key={folder} className="inset-row flex items-center justify-between px-3 py-2.5">
                        <span className="font-text text-caption truncate flex-1 mr-2 text-white/80">{folder}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={`移除目录（同时从${LIBRARY_LABEL}移除该目录下的歌曲）`}
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
                    label="网络存储"
                    hint="NAS / WebDAV 上的音乐会被扫描入库并长期保留"
                    control={
                      <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={() => setAddLibraryOpen(true)}>
                        <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        添加
                      </Button>
                    }
                  >
                    {librarySources.length === 0 ? (
                      <p className="font-text text-caption text-white/50">
                        尚未添加，支持群晖 / 威联通 / Nextcloud 等标准 WebDAV
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
            <SettingsSection id="storage" title="下载与缓存">
              <div className="px-3 pt-1">
                <p className="font-text text-caption text-white/50 mb-2">下载音质</p>
                <div className="flex gap-2">
                  {downloadQualityOptions.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => setDownloadQuality(value)}
                      className={`pill pill-md ${
                        downloadQuality === value ? 'pill-mint' : 'pill-soft'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 下载目录：桌面端设置后免保存对话框直存；移动端选的是手机存储内的相对目录 */}
              <SettingRow
                label="下载目录"
                hint={desktop ? '设置后不再弹保存对话框' : '设置后直接存入该目录'}
                control={
                  <>
                    {downloadDir && (
                      <Button variant="ghost" size="sm" className="h-9 px-3" onClick={() => setDownloadDir(null)}>
                        {desktop ? '清除' : '恢复默认'}
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handlePickDownloadDir}>
                      <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                      {downloadDir ? '更换' : '选择'}
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
                    label="缓存上限"
                    hint={
                      // 「不限制」档没有上限可超，继续写「超出上限时自动清理」会自相矛盾
                      audioCacheLimitMB === 0
                        ? `不限制容量，只受磁盘剩余空间约束 · 当前占用 ${formatBytes(cacheUsage.usedBytes)}`
                        : `超出上限时按最久未使用自动清理 · 默认 ${formatCacheLimit(defaultCacheLimitMB)} · 当前占用 ${formatBytes(cacheUsage.usedBytes)}`
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
                            {formatCacheLimit(presetMB)}
                          </button>
                        )
                      })}
                      <button
                        type="button"
                        onClick={() => handleSelectCacheLimit(0)}
                        className={`pill pill-md ${audioCacheLimitMB === 0 ? 'pill-mint' : 'pill-soft'}`}
                      >
                        不限制
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
                            ? `自定义 ${formatCacheLimit(audioCacheLimitMB)}`
                            : `默认 ${formatCacheLimit(audioCacheLimitMB)}`}
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
                        placeholder="自定义 GB"
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
                      <span className="font-text text-caption text-white/50">GB</span>
                      {audioCacheLimitCustomMB && (
                        <Button variant="ghost" size="sm" className="h-9 px-3" onClick={handleResetCacheLimit}>
                          恢复默认
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 px-3 text-white/60 hover:text-coral hover:bg-coral/10"
                        onClick={handleClearCache}
                        disabled={cacheUsage.count === 0}
                        title="清空全部缓存"
                      >
                        <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        清空
                      </Button>
                      {cacheLimitInvalid && (
                        <span className="font-text text-caption text-coral/70">
                          需填 {CACHE_LIMIT_MIN_GB} – {CACHE_LIMIT_MAX_GB} GB
                        </span>
                      )}
                    </div>
                  </SettingRow>
                </div>
              )}
            </SettingsSection>

            <SettingsSection id="sources" title="在线源">
              {/* 音源：应用不内置任何源，全部由用户按协议配置。
                  一条音源可同时给出搜索接口与歌单解析接口（标准音源形态下由服务地址自动生成） */}
              <SettingRow
                label="音源"
                hint="在线搜索与歌单导入共用这一条源"
                control={
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={() => setAddMusicOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    添加
                  </Button>
                }
              >
                {onlineSources.length === 0 ? (
                  <p className="font-text text-caption text-white/50">
                    尚未配置，在线搜索与歌单导入暂不可用
                  </p>
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

              {/* 歌词源：用户配置优先，未命中时回退到内置歌词源兜底 */}
              <SettingRow
                label="歌词源"
                hint="配置后优先生效，未命中回退内置源"
                control={
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={() => setAddLyricsOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    添加
                  </Button>
                }
              >
                {lyricsSources.length === 0 ? (
                  <p className="font-text text-caption text-white/50">尚未配置，自动回退内置歌词源</p>
                ) : (
                  <div className="space-y-2">
                    {lyricsSources.map((src) => (
                      <SourceEditorCard
                        key={src.id}
                        name={src.name}
                        sourceUrl={src.sourceUrl}
                        headers={src.headers}
                        enabled={src.enabled}
                        placeholderUrl="https://lrclib.net/api/search?track_name={track}&artist_name={artist}"
                        kind="lyrics"
                        onUpdate={(updates) => updateLyricsSource(src.id, updates)}
                        onRemove={() => removeLyricsSource(src.id)}
                      />
                    ))}
                  </div>
                )}
              </SettingRow>
            </SettingsSection>

            {/* 关于：版本、更新与许可同属"这套软件本身"，合并后不再平铺两张只读卡片 */}
            <SettingsSection id="about" title="关于">
              <SettingRow
                label="版本"
                hint={`v${APP_VERSION} · PolyForm Noncommercial 1.0.0`}
                control={
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 px-3 text-white/60"
                      title="查看源码与开源许可（禁止商业用途）"
                      onClick={() => openExternalUrl(REPO_URL)}
                    >
                      <Github className="h-4 w-4 mr-2" strokeWidth={1.6} />
                      项目仓库
                    </Button>
                    <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handleCheckUpdate} disabled={checking}>
                      <RefreshCw className={`h-4 w-4 mr-2 ${checking ? 'animate-spin' : ''}`} strokeWidth={1.6} />
                      {checking ? '检查中…' : '检查更新'}
                    </Button>
                  </>
                }
              >
                {updateInfo && (
                  <div className="flex items-center justify-between bg-mint/[0.06] border border-mint/20 rounded-[10px] px-3.5 py-3">
                    <div className="min-w-0 mr-3">
                      <p className="font-text text-caption-strong text-white/90">
                        发现新版本 <span className="text-mint font-semibold">v{updateInfo.version}</span>
                      </p>
                      <p className="font-text text-caption text-white/55 mt-0.5 truncate">
                        {downloadPhase === 'downloading'
                          ? '正在下载安装包，可关闭此窗口继续后台下载'
                          : downloadPhase === 'done'
                            ? '安装包已就绪，点击右侧继续安装'
                            : updateInfo.assetLabel
                              ? `将下载对应系统的安装包（${updateInfo.assetLabel}）`
                              : '点击下载对应平台的安装包'}
                      </p>
                      {updateInfo.installHint && downloadPhase !== 'downloading' && downloadPhase !== 'done' && (
                        <p className="font-text text-caption text-white/50 mt-1 truncate">{updateInfo.installHint}</p>
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
                        {downloadPhase === 'done' ? '继续安装' : '下载中…'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="h-9 px-3.5 bg-mint text-mint-fg font-semibold hover:bg-mint/90"
                        onClick={handleDownloadUpdate}
                      >
                        <Download className="h-4 w-4 mr-2" strokeWidth={1.6} />
                        下载更新
                      </Button>
                    )}
                  </div>
                )}

                {updateState === 'latest' && (
                  <div className="inset-note flex items-center gap-2 px-3 py-2.5">
                    <CheckCircle2 className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
                    <p className="font-text text-caption text-white/70">当前已是最新版本</p>
                  </div>
                )}

                {updateState === 'error' && (
                  <div className="inset-note flex items-center gap-2 px-3 py-2.5">
                    <AlertCircle className="h-4 w-4 text-coral flex-shrink-0" strokeWidth={1.6} />
                    <p className="font-text text-caption text-white/70">
                      {updateError ? `检查失败：${updateError}` : '检查失败，请确认网络后重试'}
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
        kind="music"
        onOpenChange={setAddMusicOpen}
        onSave={(source) => addOnlineSource({ ...source, enabled: source.enabled ?? true })}
      />
      <SourceAddDialog
        open={addLyricsOpen}
        kind="lyrics"
        onOpenChange={setAddLyricsOpen}
        onSave={(source) => addLyricsSource({ ...source, enabled: true })}
      />
      <LibrarySourceAddDialog
        open={addLibraryOpen}
        onOpenChange={setAddLibraryOpen}
        onSave={(source) => addLibrarySource({ ...source, enabled: true })}
      />
    </PageLayout>
  )
}

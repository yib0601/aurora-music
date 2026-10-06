import { useEffect, useState } from 'react'
import { Settings as SettingsIcon, Monitor, Moon, Sun, FolderOpen, Trash2, Plus, Cloud, RefreshCw, Download, CheckCircle2, AlertCircle, ChevronDown, Pencil, Check, Github } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PageLayout } from '@/components/PageLayout'
import { useLibraryStore } from '@/stores/libraryStore'
import type { LibrarySourceConfig } from '@/types'
import { useAudioDevices } from '@/hooks/useAudioDevices'
import { setOutputDevice } from '@/services/audio.service'
import { platform, DEFAULT_MOBILE_DOWNLOAD_DIR } from '@/services/platform'
import { isDesktop, isMobile } from '@/lib/utils'
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

/** 缓存容量档位：0 表示关闭缓存，其余单位为 MB */
const cacheLimitOptions = [
  { value: 0, label: '关闭' },
  { value: 256, label: '256 MB' },
  { value: 512, label: '512 MB' },
  { value: 1024, label: '1 GB' },
  { value: 2048, label: '2 GB' },
  { value: 4096, label: '4 GB' },
]

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
                服务地址已识别，搜索与歌单接口自动生成{parsed?.apiKey ? '，密钥已从链接中提取' : ''}
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
              <p className="font-text text-caption text-white/35 truncate">搜索 {maskPreview(preview.search)}</p>
              <p className="font-text text-caption text-white/35 truncate">歌单 {maskPreview(preview.playlist)}</p>
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
              ? '接口地址需包含 {track} 与 {artist} 占位符，保存后立即生效'
              : isLx
                ? '粘贴一条洛雪音源脚本链接：脚本提供取址能力；没有搜索接口的脚本，需要另配一条 Aurora 音源用于搜索'
                : '填一条链接即可：服务地址会自动生成搜索与歌单解析接口，第三方接口地址原样使用'}
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
                      <span className="block font-text text-caption text-white/45 mt-0.5">{option.hint}</span>
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
                服务地址已识别，搜索与歌单接口自动生成{parsed?.apiKey ? '，密钥已从链接中提取' : ''}
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
                  <p className="font-text text-caption text-white/35 truncate">搜索 {maskKey(preview.search)}</p>
                  <p className="font-text text-caption text-white/35 truncate">歌单 {maskKey(preview.playlist)}</p>
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
          <p className="font-text text-caption text-white/45 truncate">
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

  // 媒体缓存：容量档位 + 当前占用；平台未实现时隐藏该分区（见下方 supportsAudioCache）
  const audioCacheLimitMB = useLibraryStore((s) => s.audioCacheLimitMB)
  const setAudioCacheLimitMB = useLibraryStore((s) => s.setAudioCacheLimitMB)
  const [cacheUsage, setCacheUsage] = useState<{ usedBytes: number; count: number }>({ usedBytes: 0, count: 0 })
  const supportsAudioCache = typeof platform.getAudioCacheUsage === 'function'
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

  return (
    <PageLayout header={
      // 设置页内容列较窄（720px），居中放置与其他页面的 1200px 居中内容列共享同一视觉轴
      <div className="flex items-center gap-5 mb-8 max-w-[720px] mx-auto w-full">
        <div className="w-16 h-16 rounded-[16px] glass-regular border border-white/[0.08] flex items-center justify-center">
          <SettingsIcon className="h-8 w-8 text-mint" strokeWidth={1.4} />
        </div>
        <div>
          <h1 className="font-display text-[24px] md:text-[32px] font-semibold tracking-[-0.374px] text-white/98 leading-tight">设置</h1>
          <p className="font-text text-[13px] text-white/50 mt-1 tracking-[-0.2px]">自定义你的 Aurora Music</p>
        </div>
      </div>
    }>
      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
        <div className="w-full max-w-[720px] mx-auto space-y-5 pb-8">
          <section className="card-list p-5">
            <h2 className="font-display text-tagline mb-4 text-white">通用</h2>
            <div className="space-y-6">
              <div>
                <p className="font-text text-caption-strong mb-3 text-white/80">主题</p>
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
              {/* 输出设备：与主题同卡，用细分隔线区分两组设置 */}
              <div className="border-t border-white/[0.06] pt-5">
                <p className="font-text text-caption-strong mb-3 text-white/80">输出设备</p>
                {devices.length === 0 ? (
                  <p className="font-text text-caption text-white/60 py-2">未检测到可用的输出设备</p>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inset-field group w-full flex items-center justify-between gap-2 px-3.5 py-2.5 font-text text-caption text-white/80"
                      >
                        <span className="truncate text-left">
                          {devices.find((d) => d.deviceId === selectedDeviceId)?.label ?? '选择输出设备'}
                        </span>
                        <ChevronDown className="h-4 w-4 flex-shrink-0 text-white/40 transition-transform duration-200 ease-mineradio group-data-[state=open]:rotate-180" strokeWidth={1.6} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-72 overflow-y-auto scrollbar-thin p-1">
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
                )}
              </div>
            </div>
          </section>

          <section className="card-list p-5">
            <h2 className="font-display text-tagline mb-4 text-white">{LIBRARY_LABEL}</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-text text-caption-strong text-white/80">扫描目录</p>
                  <p className="font-text text-caption text-white/60 mt-0.5">应用会扫描这些目录中的音乐文件</p>
                </div>
                <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handlePickFolder}>
                  <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                  添加目录
                </Button>
              </div>
              {scanFolders.length === 0 ? (
                <p className="font-text text-caption text-white/60 py-2">尚未添加任何目录</p>
              ) : (
                <div className="space-y-2">
                  {scanFolders.map((folder) => (
                    <div key={folder} className="inset-row flex items-center justify-between px-3.5 py-3">
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

              {/* 网络存储（仅桌面端）：与本地目录同属曲库来源，合并进本卡片，用细分隔线区分 */}
              {supportsLibrarySources && (
                <div className="border-t border-white/[0.06] pt-5">
                  <div className="flex items-center justify-between">
                    <p className="font-text text-caption-strong text-white/80">网络存储</p>
                    <Button variant="secondary" size="sm" className="h-8 px-3" onClick={() => setAddLibraryOpen(true)}>
                      <Plus className="h-4 w-4 mr-1.5" strokeWidth={1.6} />
                      添加
                    </Button>
                  </div>
                  <p className="font-text text-caption text-white/45 mt-0.5 mb-3">
                    NAS / WebDAV 上的音乐会被扫描入库并长期保留
                  </p>
                  {librarySources.length === 0 ? (
                    <p className="font-text text-caption text-white/60">
                      尚未添加，支持群晖 / 威联通 / Nextcloud 等标准 WebDAV 服务
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
                </div>
              )}
            </div>
          </section>

          <section className="card-list p-5">
            <h2 className="font-display text-tagline mb-4 text-white">下载</h2>
            <div className="space-y-4">
              <div>
                <p className="font-text text-caption-strong text-white/80">默认下载音质</p>
                <p className="font-text text-caption text-white/60 mt-0.5 mb-3">
                  需歌源支持对应音质，不支持时按源默认地址下载
                </p>
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
              {/* 下载目录：桌面端设置后免保存对话框直存；移动端选的是手机存储内的相对目录，
                  未设置时存入默认的 Music/Aurora Music */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-text text-caption-strong text-white/80">默认下载目录</p>
                  <p className="font-text text-caption text-white/60 mt-0.5">
                    {desktop
                      ? '设置后在线歌曲直接存入该目录，不再弹保存对话框'
                      : '设置后在线歌曲直接存入该目录'}
                  </p>
                </div>
                <div className="flex gap-2">
                  {downloadDir && (
                    <Button variant="ghost" size="sm" className="h-9 px-3.5" onClick={() => setDownloadDir(null)}>
                      {desktop ? '清除' : '恢复默认'}
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handlePickDownloadDir}>
                    <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    {downloadDir ? '更换目录' : '选择目录'}
                  </Button>
                </div>
              </div>
              <p className="inset-note font-text text-caption text-white/60 px-3.5 py-3 truncate font-mono">
                {downloadDirLabel}
              </p>
            </div>
          </section>

          {/* 媒体缓存：桌面端与移动端均有实现，Web 等未实现的平台不显示 */}
          {supportsAudioCache && (
            <section className="card-list p-5">
              <h2 className="font-display text-tagline mb-4 text-white">缓存</h2>
              <div className="space-y-4">
                <div>
                  <p className="font-text text-caption-strong text-white/80">缓存大小</p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {cacheLimitOptions.map(({ value, label }) => (
                      <button
                        key={value}
                        onClick={() => {
                          setAudioCacheLimitMB(value)
                          // 关闭档位只停止新增缓存，磁盘上已有的内容不会消失：
                          // 这里重新读一次真实占用，而不是按档位猜测
                          void getAudioCacheUsage().then(setCacheUsage)
                        }}
                        className={`pill pill-md ${
                          audioCacheLimitMB === value ? 'pill-mint' : 'pill-soft'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="inset-note flex items-center justify-between px-3.5 py-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">当前占用</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">
                      {formatBytes(cacheUsage.usedBytes)}
                      {audioCacheLimitMB > 0 && ` / 上限 ${formatBytes(audioCacheLimitMB * 1024 * 1024)}`}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-3.5 text-white/60 hover:text-coral hover:bg-coral/10"
                    onClick={handleClearCache}
                    disabled={cacheUsage.count === 0}
                  >
                    <Trash2 className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    清空缓存
                  </Button>
                </div>
              </div>
            </section>
          )}

          <section className="card-list p-5">
            <h2 className="font-display text-tagline mb-4 text-white">在线源</h2>
            <div className="space-y-5">
              {/* 音源：应用不内置任何源，全部由用户按协议配置。
                  一条音源可同时给出搜索接口与歌单解析接口（标准音源形态下由服务地址自动生成），歌单导入直接复用 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">音源</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">
                      填一条链接即可，在线搜索与歌单导入共用这一条音源
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={() => setAddMusicOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    添加
                  </Button>
                </div>

                {onlineSources.length === 0 ? (
                  <p className="font-text text-caption text-white/50 px-1 py-1">
                    尚未配置，在线搜索与歌单链接导入暂不可用（纯文本导入不受影响）
                  </p>
                ) : (
                  <div className="space-y-2.5">
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
              </div>

              {/* 歌词源：用户配置优先，未命中时回退到内置歌词源兜底 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">歌词源</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">配置优先生效，未命中时回退内置歌词源</p>
                  </div>
                  <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={() => setAddLyricsOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    添加
                  </Button>
                </div>

                {lyricsSources.length === 0 ? (
                  <p className="font-text text-caption text-white/50 px-1 py-1">尚未配置，自动回退到内置歌词源</p>
                ) : (
                  <div className="space-y-2.5">
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
              </div>
            </div>
          </section>

          <section className="card-list p-5">
            <h2 className="font-display text-tagline mb-4 text-white">软件更新</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-text text-caption-strong text-white/80">当前版本</p>
                  <p className="font-text text-caption text-white/60 mt-0.5">v{APP_VERSION}</p>
                </div>
                <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handleCheckUpdate} disabled={checking}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${checking ? 'animate-spin' : ''}`} strokeWidth={1.6} />
                  {checking ? '检查中…' : '检查更新'}
                </Button>
              </div>

              {updateInfo && (
                <div className="flex items-center justify-between bg-mint/[0.06] border border-mint/20 rounded-[10px] px-3.5 py-3">
                  <div className="min-w-0 mr-3">
                    <p className="font-text text-caption-strong text-white/90">
                      发现新版本 <span className="text-mint font-semibold">v{updateInfo.version}</span>
                    </p>
                    <p className="font-text text-caption text-white/60 mt-0.5 truncate">
                      {downloadPhase === 'downloading'
                        ? '正在下载安装包，可关闭此窗口继续后台下载'
                        : downloadPhase === 'done'
                          ? '安装包已就绪，点击右侧继续安装'
                          : updateInfo.assetLabel
                            ? `将下载对应系统的安装包（${updateInfo.assetLabel}）`
                            : '点击下载对应平台的安装包'}
                    </p>
                    {updateInfo.installHint && downloadPhase !== 'downloading' && downloadPhase !== 'done' && (
                      <p className="font-text text-caption text-white/45 mt-1 truncate">{updateInfo.installHint}</p>
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
                <div className="inset-note flex items-center gap-2 px-3.5 py-3">
                  <CheckCircle2 className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
                  <p className="font-text text-caption text-white/70">当前已是最新版本</p>
                </div>
              )}

              {updateState === 'error' && (
                <div className="inset-note flex items-center gap-2 px-3.5 py-3">
                  <AlertCircle className="h-4 w-4 text-coral flex-shrink-0" strokeWidth={1.6} />
                  <p className="font-text text-caption text-white/70">
                    {updateError ? `检查失败：${updateError}` : '检查失败，请确认网络后重试'}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* 关于本软件：软件标识、版本与项目地址 */}
          <section className="card-list p-5">
            <h2 className="font-display text-tagline mb-4 text-white">关于本软件</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="min-w-0 mr-3">
                  <p className="font-text text-caption-strong text-white/80">Aurora Music</p>
                  <p className="font-text text-caption text-white/60 mt-0.5">
                    跨平台音乐播放器 · v{APP_VERSION}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-9 px-3.5 flex-shrink-0"
                  onClick={() => openExternalUrl(REPO_URL)}
                >
                  <Github className="h-4 w-4 mr-2" strokeWidth={1.6} />
                  项目仓库
                </Button>
              </div>

              <p className="inset-note font-text text-caption text-white/60 px-3.5 py-3">
                开源许可 PolyForm Noncommercial License 1.0.0 · 禁止商业用途
              </p>
            </div>
          </section>
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

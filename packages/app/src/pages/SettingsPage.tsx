import { useEffect, useState } from 'react'
import { Settings as SettingsIcon, Monitor, Moon, Sun, FolderOpen, Trash2, Plus, Cloud, RefreshCw, Download, CheckCircle2, AlertCircle, ChevronDown, Pencil, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PageLayout } from '@/components/PageLayout'
import { useLibraryStore } from '@/stores/libraryStore'
import type { LibrarySourceConfig } from '@/types'
import { useAudioDevices } from '@/hooks/useAudioDevices'
import { setOutputDevice } from '@/services/audio.service'
import { platform, DEFAULT_MOBILE_DOWNLOAD_DIR } from '@/services/platform'
import { isDesktop } from '@/lib/utils'
import { toast } from '@/components/common/Toast'
import { APP_VERSION, checkForUpdate, openDownloadPage, type UpdateInfo } from '@/services/update.service'
import { isInAppUpdateAvailable, startInAppDownload, useUpdateDownloadStore } from '@/stores/updateDownloadStore'
import { getAudioCacheUsage, clearAudioCache } from '@/services/audioCache.service'

const themeOptions = [
  { value: 'dark' as const, label: '深色', icon: Moon },
  { value: 'light' as const, label: '浅色', icon: Sun },
  { value: 'system' as const, label: '跟随系统', icon: Monitor },
]

/** 在线播放缓存容量档位：0 表示关闭缓存，其余单位为 MB */
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

/** 单个音源卡片：默认仅展示名称 + 能力标签 + 启用开关；点击编辑展开草稿表单，校验通过后点保存才写入 */
function SourceEditorCard({
  name,
  apiUrl,
  playlistUrl,
  headers,
  enabled,
  placeholderUrl,
  playlistPlaceholderUrl,
  kind,
  onUpdate,
  onRemove,
}: {
  name: string
  apiUrl: string
  /** 歌单解析接口（仅音源有该能力；留空表示该源不参与歌单导入） */
  playlistUrl?: string
  headers?: Record<string, string>
  enabled: boolean
  placeholderUrl: string
  playlistPlaceholderUrl?: string
  kind: 'music' | 'lyrics'
  onUpdate: (updates: { name?: string; apiUrl?: string; playlistUrl?: string; headers?: Record<string, string>; enabled?: boolean }) => void
  onRemove: () => void
}) {
  const hasHeaders = headers != null && Object.keys(headers).length > 0
  const isMusic = kind === 'music'
  const [editing, setEditing] = useState(false)
  const [showHeaders, setShowHeaders] = useState(hasHeaders)
  const [nameDraft, setNameDraft] = useState(name)
  const [apiUrlDraft, setApiUrlDraft] = useState(apiUrl)
  const [playlistDraft, setPlaylistDraft] = useState(playlistUrl || '')
  const [headersDraft, setHeadersDraft] = useState(() => (hasHeaders ? JSON.stringify(headers, null, 2) : ''))
  const [headersInvalid, setHeadersInvalid] = useState(false)
  const [parsedHeaders, setParsedHeaders] = useState<Record<string, string> | undefined>(headers)

  // 与添加弹窗一致的占位符校验：搜索地址需含 {query}（歌词源为 {track}/{artist}）；
  // 歌单解析地址可选，一旦填写必须含 {url}
  const requiredPlaceholders = kind === 'lyrics' ? ['{track}', '{artist}'] : ['{query}']
  const missingPlaceholders = apiUrlDraft.trim() ? requiredPlaceholders.filter((p) => !apiUrlDraft.includes(p)) : []
  // 两个地址至少填一个（只做歌单解析的音源可以没有搜索地址），填了的地址必须带对应占位符
  const hasAnyEndpoint = apiUrlDraft.trim().length > 0 || (isMusic && playlistDraft.trim().length > 0)
  const playlistInvalid = isMusic && playlistDraft.trim().length > 0 && !playlistDraft.includes('{url}')
  const canSave = hasAnyEndpoint && missingPlaceholders.length === 0 && !playlistInvalid && !headersInvalid

  // 进入编辑：从已保存值初始化草稿
  const startEditing = () => {
    setNameDraft(name)
    setApiUrlDraft(apiUrl)
    setPlaylistDraft(playlistUrl || '')
    setHeadersDraft(hasHeaders ? JSON.stringify(headers, null, 2) : '')
    setHeadersInvalid(false)
    setParsedHeaders(headers)
    setShowHeaders(hasHeaders)
    setEditing(true)
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
    const trimmedPlaylist = playlistDraft.trim()
    const alreadyHad = (playlistUrl || '').trim()
    onUpdate({
      name: nameDraft.trim() || name,
      apiUrl: apiUrlDraft.trim(),
      // 只在确实有变化时带上歌单解析地址，避免把歌词源的字段写脏
      ...(isMusic && (trimmedPlaylist || alreadyHad) ? { playlistUrl: trimmedPlaylist } : {}),
      headers: parsedHeaders,
    })
    setEditing(false)
  }

  return (
    <div
      className={`bg-white/[0.03] border rounded-[10px] px-3.5 py-3 transition-colors duration-200 ease-mineradio ${
        enabled ? 'border-white/[0.08]' : 'border-white/[0.08] opacity-55'
      }`}
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
            {/* 能力标签：一眼看出这条音源能搜索、还是也能解析歌单 */}
            <span className="flex items-center gap-1 flex-shrink-0">
              {apiUrl.trim() && (
                <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-mint/10 text-mint/80">
                  {isMusic ? '搜索' : '歌词'}
                </span>
              )}
              {isMusic && (playlistUrl || '').trim() && (
                <span className="font-text text-[10px] leading-none px-1.5 py-1 rounded-[6px] bg-white/[0.06] text-white/55">
                  歌单
                </span>
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
          {isMusic && <p className="font-text text-caption text-white/50 mb-1">搜索接口（需含 {'{query}'}）</p>}
          <input
            type="text"
            value={apiUrlDraft}
            placeholder={placeholderUrl}
            onChange={(e) => setApiUrlDraft(e.target.value)}
            className={`w-full bg-white/[0.03] border rounded-[10px] px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200 ${
              missingPlaceholders.length > 0 ? 'border-coral/60' : 'border-white/10'
            }`}
          />
          {missingPlaceholders.length > 0 && (
            <p className="font-text text-caption text-coral/70 mt-1">
              地址需包含占位符：{missingPlaceholders.join('、')}
            </p>
          )}
          {/* 歌单解析接口：与搜索同属一条音源，填写后歌单导入即可直接解析分享链接 */}
          {isMusic && (
            <div className="mt-2">
              <p className="font-text text-caption text-white/50 mb-1">歌单解析接口（可选，需含 {'{url}'}）</p>
              <input
                type="text"
                value={playlistDraft}
                placeholder={playlistPlaceholderUrl || 'https://your-api.com/resolve?url={url}'}
                onChange={(e) => setPlaylistDraft(e.target.value)}
                className={`w-full bg-white/[0.03] border rounded-[10px] px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200 ${
                  playlistInvalid ? 'border-coral/60' : 'border-white/10'
                }`}
              />
              {playlistInvalid ? (
                <p className="font-text text-caption text-coral/70 mt-1">地址需包含占位符：{'{url}'}</p>
              ) : (
                <p className="font-text text-caption text-white/35 mt-1">
                  留空表示该音源不参与歌单导入
                </p>
              )}
            </div>
          )}
          {/* 请求头：可选，折叠编辑 */}
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowHeaders(!showHeaders)}
              className="flex items-center gap-1 font-text text-caption text-white/40 hover:text-white/70 transition-colors duration-200"
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform duration-200 ease-mineradio ${showHeaders ? 'rotate-180' : ''}`}
                strokeWidth={1.8}
              />
              请求头{hasHeaders ? '（已配置）' : '（可选）'}
            </button>
            {showHeaders && (
              <>
                <textarea
                  value={headersDraft}
                  placeholder={'{"Authorization": "Bearer ..."}'}
                  onChange={(e) => handleHeadersChange(e.target.value)}
                  rows={2}
                  className={`mt-1.5 w-full bg-white/[0.03] border rounded-[10px] px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200 resize-none ${
                    headersInvalid ? 'border-coral/60' : 'border-white/10'
                  }`}
                />
                {headersInvalid && (
                  <p className="font-text text-caption text-coral/70 mt-1">JSON 格式无效：需为对象，如 {'{"Authorization": "Bearer xxx"}'}</p>
                )}
              </>
            )}
          </div>
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
  onSave: (source: { name: string; apiUrl: string; playlistUrl?: string; headers?: Record<string, string> }) => void
}) {
  const [name, setName] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [playlistUrl, setPlaylistUrl] = useState('')
  const [headersDraft, setHeadersDraft] = useState('')
  const [headersInvalid, setHeadersInvalid] = useState(false)
  const [headers, setHeaders] = useState<Record<string, string> | undefined>(undefined)

  // 每次打开重置表单
  useEffect(() => {
    if (open) {
      setName('')
      setApiUrl('')
      setPlaylistUrl('')
      setHeadersDraft('')
      setHeadersInvalid(false)
      setHeaders(undefined)
    }
  }, [open])

  const isLyrics = kind === 'lyrics'
  const requiredPlaceholders = isLyrics ? ['{track}', '{artist}'] : ['{query}']
  const missingPlaceholders = apiUrl.trim() ? requiredPlaceholders.filter((p) => !apiUrl.includes(p)) : []
  const playlistInvalid = !isLyrics && playlistUrl.trim().length > 0 && !playlistUrl.includes('{url}')
  const hasAnyEndpoint = apiUrl.trim().length > 0 || (!isLyrics && playlistUrl.trim().length > 0)
  const canSave = hasAnyEndpoint && missingPlaceholders.length === 0 && !playlistInvalid && !headersInvalid

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
    const trimmedPlaylist = playlistUrl.trim()
    onSave({
      name: name.trim() || (isLyrics ? '新歌词源' : '新音源'),
      apiUrl: apiUrl.trim(),
      ...(!isLyrics && trimmedPlaylist ? { playlistUrl: trimmedPlaylist } : {}),
      headers,
    })
    onOpenChange(false)
  }

  const inputCls =
    'w-full bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">
            {isLyrics ? '添加歌词源' : '添加音源'}
          </DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {isLyrics
              ? '接口地址需包含 {track} 与 {artist} 占位符，保存后立即生效'
              : '搜索接口需包含 {query}、歌单解析接口需包含 {url}；音源两个接口都填，搜索与歌单导入一次配好'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">名称（可选）</p>
            <input
              type="text"
              value={name}
              placeholder={isLyrics ? '如：LRCLIB' : '如：我的音源'}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{isLyrics ? '接口地址' : '搜索接口地址'}</p>
            <input
              type="text"
              value={apiUrl}
              placeholder={
                isLyrics
                  ? 'https://lrclib.net/api/search?track_name={track}&artist_name={artist}'
                  : 'https://your-api.com/search?q={query}'
              }
              onChange={(e) => setApiUrl(e.target.value)}
              className={`${inputCls} ${missingPlaceholders.length > 0 ? 'border-coral/60' : ''}`}
            />
            {missingPlaceholders.length > 0 && (
              <p className="font-text text-caption text-coral/70 mt-1">
                地址需包含占位符：{missingPlaceholders.join('、')}
              </p>
            )}
          </div>
          {!isLyrics && (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">歌单解析接口（可选）</p>
              <input
                type="text"
                value={playlistUrl}
                placeholder="https://your-api.com/resolve?url={url}"
                onChange={(e) => setPlaylistUrl(e.target.value)}
                className={`${inputCls} ${playlistInvalid ? 'border-coral/60' : ''}`}
              />
              {playlistInvalid ? (
                <p className="font-text text-caption text-coral/70 mt-1">地址需包含占位符：{'{url}'}</p>
              ) : (
                <p className="font-text text-caption text-white/35 mt-1">
                  填入后，导入歌单时可直接解析 QQ / 网易云等平台的歌单分享链接
                </p>
              )}
            </div>
          )}
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">请求头（可选，JSON 对象）</p>
            <textarea
              value={headersDraft}
              placeholder={'{"Authorization": "Bearer ..."}'}
              onChange={(e) => handleHeadersChange(e.target.value)}
              rows={2}
              className={`${inputCls} resize-none ${headersInvalid ? 'border-coral/60' : ''}`}
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
    'w-full bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200'

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
              className={`${inputCls} ${baseUrl.trim() && !urlOk ? 'border-coral/60' : ''}`}
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
    'w-full bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200'

  return (
    <div className="bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-3.5 py-3 hover:border-white/[0.14] transition-colors duration-200 ease-mineradio">
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
          title="移除来源（同时从音乐库移除该来源的歌曲）"
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
            className={`${inputCls} ${baseUrlDraft.trim() && !urlOk ? 'border-coral/60' : ''}`}
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

  // 在线播放缓存：容量档位 + 当前占用；仅桌面端有实现，其余平台隐藏该分区
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
    const ok = window.confirm('清空全部在线播放缓存？已缓存的歌曲下次播放将重新下载。')
    if (!ok) return
    await clearAudioCache()
    setCacheUsage({ usedBytes: 0, count: 0 })
    toast('播放缓存已清空')
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
    try {
      const info = await checkForUpdate()
      if (info) {
        setUpdateInfo(info)
      } else {
        setUpdateState('latest')
      }
    } catch {
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
   * 移除扫描目录：除了解除目录配置，还要把该目录下的曲目从音乐库中删除，
   * 否则音乐库会残留已移除目录的歌曲（数量对不上、点进去还能播放）。
   * 磁盘文件不受影响，只是不再属于音乐库。
   */
  const handleRemoveFolder = async (folder: string) => {
    const prefix = folder.endsWith('/') || folder.endsWith('\\') ? folder : folder + '/'
    const affected = useLibraryStore
      .getState()
      .tracks.filter((t) => t.path === folder || t.path.startsWith(prefix) || t.path.startsWith(prefix.replace(/\//g, '\\'))).length
    const ok = window.confirm(
      affected > 0
        ? `移除扫描目录「${folder}」？\n该目录下的 ${affected} 首歌曲会同时从音乐库中移除（磁盘文件不会被删除）。`
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

  /** 移除网络存储来源：连同该来源的曲目一起从音乐库删除（远端文件不受影响） */
  const handleRemoveLibrarySource = async (source: LibrarySourceConfig) => {
    const prefix = `webdav:${source.id}/`
    const affected = useLibraryStore.getState().tracks.filter((t) => t.path.startsWith(prefix)).length
    const ok = window.confirm(
      affected > 0
        ? `移除网络存储「${source.name}」？\n该来源下的 ${affected} 首歌曲会同时从音乐库中移除（远端文件不会被删除）。`
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
          <section className="card-utility p-5">
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
                        className="group w-full flex items-center justify-between gap-2 bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-3.5 py-2.5 font-text text-caption text-white/80 outline-none hover:bg-white/[0.05] hover:border-white/[0.14] focus:border-mint/50 transition-colors duration-200 ease-mineradio"
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

          <section className="card-utility p-5">
            <h2 className="font-display text-tagline mb-4 text-white">音乐库</h2>
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
                    <div key={folder} className="flex items-center justify-between bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-3.5 py-3 hover:bg-white/[0.05] hover:border-white/[0.14] transition-colors duration-200 ease-mineradio">
                      <span className="font-text text-caption truncate flex-1 mr-2 text-white/80">{folder}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="移除目录（同时从音乐库移除该目录下的歌曲）"
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

          <section className="card-utility p-5">
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
              <p className="font-text text-caption text-white/60 bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-3.5 py-3 truncate">
                {downloadDirLabel}
              </p>
            </div>
          </section>

          {/* 在线播放缓存：仅桌面端有主进程磁盘缓存实现 */}
          {supportsAudioCache && (
            <section className="card-utility p-5">
              <h2 className="font-display text-tagline mb-4 text-white">播放缓存</h2>
              <div className="space-y-4">
                <div>
                  <p className="font-text text-caption-strong text-white/80">缓存大小</p>
                  <p className="font-text text-caption text-white/60 mt-0.5 mb-3">
                    在线歌曲首次播放后自动缓存到本地，再次播放时不再走网络
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {cacheLimitOptions.map(({ value, label }) => (
                      <button
                        key={value}
                        onClick={() => {
                          setAudioCacheLimitMB(value)
                          if (value === 0) setCacheUsage({ usedBytes: 0, count: 0 })
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
                <div className="flex items-center justify-between bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-3.5 py-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">当前占用</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">
                      {formatBytes(cacheUsage.usedBytes)}（{cacheUsage.count} 首）
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

          <section className="card-utility p-5">
            <h2 className="font-display text-tagline mb-4 text-white">在线源</h2>
            <div className="space-y-5">
              {/* 音源：应用不内置任何源，全部由用户按协议配置。
                  一条音源可同时给出搜索接口与歌单解析接口，歌单导入直接复用 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">音源</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">
                      一条音源可同时用于在线搜索与歌单导入，可添加多个
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
                        apiUrl={src.apiUrl}
                        playlistUrl={src.playlistUrl}
                        headers={src.headers}
                        enabled={src.enabled}
                        placeholderUrl="https://your-api.com/search?q={query}"
                        playlistPlaceholderUrl="https://your-api.com/resolve?url={url}"
                        kind="music"
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
                        apiUrl={src.apiUrl}
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

          <section className="card-utility p-5">
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
                <div className="flex items-center gap-2 bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-3.5 py-3">
                  <CheckCircle2 className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
                  <p className="font-text text-caption text-white/70">当前已是最新版本</p>
                </div>
              )}

              {updateState === 'error' && (
                <div className="flex items-center gap-2 bg-white/[0.03] border border-white/[0.08] rounded-[10px] px-3.5 py-3">
                  <AlertCircle className="h-4 w-4 text-coral flex-shrink-0" strokeWidth={1.6} />
                  <p className="font-text text-caption text-white/70">检查失败，请确认网络后重试</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <SourceAddDialog
        open={addMusicOpen}
        kind="music"
        onOpenChange={setAddMusicOpen}
        onSave={(source) => addOnlineSource({ ...source, enabled: true })}
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

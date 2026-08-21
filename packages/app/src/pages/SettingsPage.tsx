import { useState } from 'react'
import { Settings as SettingsIcon, Monitor, Moon, Sun, FolderOpen, Trash2, Plus, Cloud, RefreshCw, Download, CheckCircle2, AlertCircle, FileText, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageLayout } from '@/components/PageLayout'
import { useLibraryStore } from '@/stores/libraryStore'
import { useAudioDevices } from '@/hooks/useAudioDevices'
import { setOutputDevice } from '@/services/audio.service'
import { platform } from '@/services/platform'
import { APP_VERSION, checkForUpdate, openDownloadPage, type UpdateInfo } from '@/services/update.service'

const themeOptions = [
  { value: 'dark' as const, label: '深色', icon: Moon },
  { value: 'light' as const, label: '浅色', icon: Sun },
  { value: 'system' as const, label: '跟随系统', icon: Monitor },
]

/** 单个歌源编辑卡片：名称 + 接口地址 + 请求头（可选 JSON）+ 启用开关 + 删除 */
function SourceEditorCard({
  name,
  apiUrl,
  headers,
  enabled,
  placeholderUrl,
  onUpdate,
  onRemove,
}: {
  name: string
  apiUrl: string
  headers?: Record<string, string>
  enabled: boolean
  placeholderUrl: string
  onUpdate: (updates: { name?: string; apiUrl?: string; headers?: Record<string, string>; enabled?: boolean }) => void
  onRemove: () => void
}) {
  const hasHeaders = headers != null && Object.keys(headers).length > 0
  const [showHeaders, setShowHeaders] = useState(hasHeaders)
  const [headersDraft, setHeadersDraft] = useState(() => (hasHeaders ? JSON.stringify(headers, null, 2) : ''))
  const [headersInvalid, setHeadersInvalid] = useState(false)

  // 请求头草稿实时解析：合法 JSON 对象才写入 store，否则标记错误（不写入）
  const handleHeadersChange = (text: string) => {
    setHeadersDraft(text)
    const trimmed = text.trim()
    if (!trimmed) {
      setHeadersInvalid(false)
      onUpdate({ headers: undefined })
      return
    }
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setHeadersInvalid(false)
        onUpdate({ headers: parsed })
      } else {
        setHeadersInvalid(true)
      }
    } catch {
      setHeadersInvalid(true)
    }
  }

  return (
    <div
      className={`bg-white/[0.04] border rounded-md px-3.5 py-3 transition-colors duration-200 ease-mineradio ${
        enabled ? 'border-white/10' : 'border-white/10 opacity-60'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          value={name}
          placeholder="源名称"
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="flex-1 bg-transparent font-text text-caption-strong text-white/90 outline-none border-b border-transparent focus:border-mint/50 transition-colors duration-200 py-1"
        />
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onUpdate({ enabled: !enabled })}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
            enabled ? 'bg-mint' : 'bg-white/15'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
              enabled ? 'translate-x-4.5' : 'translate-x-1'
            }`}
          />
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-white/40 hover:text-coral hover:bg-coral/10 transition-all duration-200 ease-mineradio"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.6} />
        </Button>
      </div>
      <input
        type="text"
        value={apiUrl}
        placeholder={placeholderUrl}
        onChange={(e) => onUpdate({ apiUrl: e.target.value })}
        className="w-full bg-white/[0.03] border border-white/10 rounded-sm px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200"
      />
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
              className={`mt-1.5 w-full bg-white/[0.03] border rounded-sm px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200 resize-none ${
                headersInvalid ? 'border-coral/60' : 'border-white/10'
              }`}
            />
            {headersInvalid && (
              <p className="font-text text-caption text-coral/70 mt-1">JSON 格式无效：需为对象，如 {'{"Authorization": "Bearer xxx"}'}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const theme = useLibraryStore((s) => s.theme)
  const setTheme = useLibraryStore((s) => s.setTheme)

  const scanFolders = useLibraryStore((s) => s.scanFolders)
  const removeScanFolder = useLibraryStore((s) => s.removeScanFolder)

  // 歌源配置（应用不内置任何源，音乐源/歌词源均由用户按协议配置）
  const onlineSources = useLibraryStore((s) => s.onlineSources)
  const addOnlineSource = useLibraryStore((s) => s.addOnlineSource)
  const updateOnlineSource = useLibraryStore((s) => s.updateOnlineSource)
  const removeOnlineSource = useLibraryStore((s) => s.removeOnlineSource)
  const lyricsSources = useLibraryStore((s) => s.lyricsSources)
  const addLyricsSource = useLibraryStore((s) => s.addLyricsSource)
  const updateLyricsSource = useLibraryStore((s) => s.updateLyricsSource)
  const removeLyricsSource = useLibraryStore((s) => s.removeLyricsSource)

  const { devices, selectedDeviceId, setSelectedDeviceId } = useAudioDevices()

  const handleDeviceChange = (deviceId: string) => {
    setSelectedDeviceId(deviceId)
    setOutputDevice(deviceId)
  }

  // 软件更新：手动检查新版本
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateState, setUpdateState] = useState<'idle' | 'latest' | 'error'>('idle')

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

  // 移动端文件夹选择器（MobileFolderPicker）由 App 层全局注册与渲染，
  // 这里直接调用 platform.pickFolder() 即可，与 LibraryPage 的"导入音乐"按钮共用同一入口
  const handlePickFolder = async () => {
    const folder = await platform.pickFolder()
    if (folder) {
      useLibraryStore.getState().addScanFolder(folder)
      await platform.scanFolder?.(folder)
    }
  }

  return (
    <PageLayout header={
      <div className="flex items-center gap-5 mb-8">
        <div className="w-20 h-20 rounded-lg glass-regular border border-white/10 flex items-center justify-center shadow-[0_10px_30px_rgba(0,0,0,.18)]">
          <SettingsIcon className="h-9 w-9 text-mint" strokeWidth={1.4} />
        </div>
        <div>
          <h1 className="font-display text-display-md text-white">设置</h1>
          <p className="font-text text-caption text-white/60 mt-1">自定义你的 Aurora Music</p>
        </div>
      </div>
    }>
      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2">
        <div className="w-full max-w-[720px] space-y-5 pb-8">
          <section className="card-utility p-5">
            <h2 className="font-display text-tagline mb-5 text-white">外观</h2>
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
                      className={`inline-flex items-center gap-2 px-4 py-2 rounded-pill text-caption font-normal tracking-[-0.224px] transition-all duration-200 ease-mineradio active:scale-95 ${
                        theme === value
                          ? 'bg-mint text-[#030608] font-semibold shadow-[0_10px_30px_rgba(0,245,212,.18),inset_0_1px_0_rgba(255,255,255,.20)]'
                          : 'bg-white/[0.05] text-white/80 border border-white/10 hover:bg-white/[0.09] hover:border-white/16 hover:-translate-y-px'
                      }`}
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.6} />
                      {label}
                    </button>
                  ))}
                </div>
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
                    <div key={folder} className="flex items-center justify-between bg-white/[0.04] border border-white/10 rounded-md px-3.5 py-3 hover:bg-white/[0.06] hover:border-white/14 transition-colors duration-200 ease-mineradio">
                      <span className="font-text text-caption truncate flex-1 mr-2 text-white/80">{folder}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-white/40 hover:text-coral hover:bg-coral/10 transition-all duration-200 ease-mineradio"
                        onClick={() => removeScanFolder(folder)}
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.6} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="card-utility p-5">
            <h2 className="font-display text-tagline mb-4 text-white">在线搜索</h2>
            <div className="space-y-5">
              {/* 音乐源：应用不内置任何源，全部由用户按协议配置 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">音乐源</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">配置符合协议的搜索接口，可添加多个</p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-9 px-3.5"
                    onClick={() =>
                      addOnlineSource({
                        name: '新音乐源',
                        apiUrl: 'https://example.com/api/search?q={query}',
                        enabled: true,
                      })
                    }
                  >
                    <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    添加
                  </Button>
                </div>

                {onlineSources.length === 0 ? (
                  <div className="bg-white/[0.02] border border-dashed border-white/10 rounded-md px-3.5 py-6 text-center">
                    <Cloud className="h-6 w-6 text-white/30 mx-auto mb-2" strokeWidth={1.4} />
                    <p className="font-text text-caption text-white/50">尚未配置音乐源，在线搜索将不可用</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {onlineSources.map((src) => (
                      <SourceEditorCard
                        key={src.id}
                        name={src.name}
                        apiUrl={src.apiUrl}
                        headers={src.headers}
                        enabled={src.enabled}
                        placeholderUrl="https://your-api.com/search?q={query}"
                        onUpdate={(updates) => updateOnlineSource(src.id, updates)}
                        onRemove={() => removeOnlineSource(src.id)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* 歌词源：按顺序依次尝试获取在线歌词 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">歌词源</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">按顺序依次尝试，用于在线获取歌词（可选）</p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-9 px-3.5"
                    onClick={() =>
                      addLyricsSource({
                        name: '新歌词源',
                        apiUrl: 'https://lrclib.net/api/search?track_name={track}&artist_name={artist}',
                        enabled: true,
                      })
                    }
                  >
                    <Plus className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    添加
                  </Button>
                </div>

                {lyricsSources.length === 0 ? (
                  <div className="bg-white/[0.02] border border-dashed border-white/10 rounded-md px-3.5 py-6 text-center">
                    <FileText className="h-6 w-6 text-white/30 mx-auto mb-2" strokeWidth={1.4} />
                    <p className="font-text text-caption text-white/50">尚未配置歌词源，在线歌词将不可用</p>
                  </div>
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
                        onUpdate={(updates) => updateLyricsSource(src.id, updates)}
                        onRemove={() => removeLyricsSource(src.id)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* 协议规范说明 */}
              <div className="bg-white/[0.02] border border-white/[0.06] rounded-md px-3.5 py-3 space-y-2">
                <p className="font-text text-caption-strong text-white/70">歌源协议规范</p>
                <p className="font-text text-caption text-white/50 leading-relaxed">
                  <span className="text-white/70">音乐源：</span>
                  接口地址需包含 <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{query}`}</code> 占位符（搜索时替换为 URL 编码后的关键词）。
                  响应为 JSON，支持数组或 <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{results:[]}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{data:[]}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{songs:[]}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{list:[]}`}</code> 包裹。
                  每项字段：<span className="text-white/70">audioUrl（必填）、title / artist / album / duration（秒）/ coverUrl</span>。
                </p>
                <p className="font-text text-caption text-white/50 leading-relaxed">
                  <span className="text-white/70">歌词源：</span>
                  占位符 <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{track}`}</code>（歌曲名）/ <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{artist}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{album}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{duration}`}</code>（秒）。
                  响应支持单对象或数组，歌词字段兼容 syncedLyrics / lrc / plainLyrics。
                </p>
                <p className="font-text text-caption text-white/50 leading-relaxed">
                  请求头为可选 JSON 对象，用于需要鉴权或特定 Referer / User-Agent 的接口。
                </p>
              </div>
            </div>
          </section>

          <section className="card-utility p-5">
            <h2 className="font-display text-tagline mb-5 text-white">音频</h2>
            <div className="space-y-4">
              <div>
                <p className="font-text text-caption-strong mb-3 text-white/80">输出设备</p>
                {devices.length === 0 ? (
                  <p className="font-text text-caption text-white/60 py-2">需要授权后才能获取设备列表</p>
                ) : (
                  <select
                    value={selectedDeviceId}
                    onChange={(e) => handleDeviceChange(e.target.value)}
                    className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3.5 py-2.5 text-caption text-white/80 focus:outline-none focus:border-mint/50 transition-colors duration-200"
                  >
                    {devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a] text-white">
                        {d.label}
                      </option>
                    ))}
                  </select>
                )}
                <p className="font-text text-caption text-white/40 mt-2">切换输出设备会影响当前播放</p>
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
                <div className="flex items-center justify-between bg-mint/[0.08] border border-mint/25 rounded-md px-3.5 py-3">
                  <div className="min-w-0 mr-3">
                    <p className="font-text text-caption-strong text-white/90">
                      发现新版本 <span className="text-mint font-semibold">v{updateInfo.version}</span>
                    </p>
                    <p className="font-text text-caption text-white/60 mt-0.5 truncate">点击下载对应平台的安装包</p>
                  </div>
                  <Button
                    size="sm"
                    className="h-9 px-3.5 bg-mint text-[#030608] font-semibold hover:bg-mint/90"
                    onClick={() => openDownloadPage(updateInfo)}
                  >
                    <Download className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    下载更新
                  </Button>
                </div>
              )}

              {updateState === 'latest' && (
                <div className="flex items-center gap-2 bg-white/[0.04] border border-white/10 rounded-md px-3.5 py-3">
                  <CheckCircle2 className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
                  <p className="font-text text-caption text-white/70">当前已是最新版本</p>
                </div>
              )}

              {updateState === 'error' && (
                <div className="flex items-center gap-2 bg-white/[0.04] border border-white/10 rounded-md px-3.5 py-3">
                  <AlertCircle className="h-4 w-4 text-coral flex-shrink-0" strokeWidth={1.6} />
                  <p className="font-text text-caption text-white/70">检查失败，请确认网络后重试</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </PageLayout>
  )
}

import { Settings as SettingsIcon, Monitor, Moon, Sun, FolderOpen, Trash2, Plus, Cloud, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageLayout } from '@/components/PageLayout'
import { useLibraryStore } from '@/stores/libraryStore'
import { useAudioDevices } from '@/hooks/useAudioDevices'
import { setOutputDevice } from '@/services/audio.service'
import { platform } from '@/services/platform'

const themeOptions = [
  { value: 'dark' as const, label: '深色', icon: Moon },
  { value: 'light' as const, label: '浅色', icon: Sun },
  { value: 'system' as const, label: '跟随系统', icon: Monitor },
]

export function SettingsPage() {
  const theme = useLibraryStore((s) => s.theme)
  const setTheme = useLibraryStore((s) => s.setTheme)

  const scanFolders = useLibraryStore((s) => s.scanFolders)
  const removeScanFolder = useLibraryStore((s) => s.removeScanFolder)

  // 在线搜索配置
  const onlineSources = useLibraryStore((s) => s.onlineSources)
  const useNeteaseSources = useLibraryStore((s) => s.useNeteaseSources)
  const useQQSources = useLibraryStore((s) => s.useQQSources)
  const addOnlineSource = useLibraryStore((s) => s.addOnlineSource)
  const updateOnlineSource = useLibraryStore((s) => s.updateOnlineSource)
  const removeOnlineSource = useLibraryStore((s) => s.removeOnlineSource)
  const setUseNeteaseSources = useLibraryStore((s) => s.setUseNeteaseSources)
  const setUseQQSources = useLibraryStore((s) => s.setUseQQSources)

  const { devices, selectedDeviceId, setSelectedDeviceId } = useAudioDevices()

  const handleDeviceChange = (deviceId: string) => {
    setSelectedDeviceId(deviceId)
    setOutputDevice(deviceId)
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
            <div className="space-y-4">
              {/* 内置源开关：网易云 / QQ 音乐各自独立 */}
              <div className="space-y-2">
                <p className="font-text text-caption-strong text-white/80">内置音乐源</p>
                <div className="flex items-center justify-between bg-white/[0.04] border border-white/10 rounded-md px-3.5 py-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Cloud className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
                    <div className="min-w-0">
                      <p className="font-text text-caption-strong text-white/80">网易云</p>
                      <p className="font-text text-caption text-white/60 mt-0.5">music.163.com 内置源</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={useNeteaseSources}
                    onClick={() => setUseNeteaseSources(!useNeteaseSources)}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
                      useNeteaseSources ? 'bg-mint' : 'bg-white/15'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
                        useNeteaseSources ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
                <div className="flex items-center justify-between bg-white/[0.04] border border-white/10 rounded-md px-3.5 py-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Cloud className="h-4 w-4 text-mint flex-shrink-0" strokeWidth={1.6} />
                    <div className="min-w-0">
                      <p className="font-text text-caption-strong text-white/80">QQ 音乐</p>
                      <p className="font-text text-caption text-white/60 mt-0.5">y.qq.com 内置源</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={useQQSources}
                    onClick={() => setUseQQSources(!useQQSources)}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
                      useQQSources ? 'bg-mint' : 'bg-white/15'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
                        useQQSources ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* 自定义源列表 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-text text-caption-strong text-white/80">自定义音乐源</p>
                    <p className="font-text text-caption text-white/60 mt-0.5">配置你自己的搜索接口，可添加多个</p>
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
                    <Globe className="h-6 w-6 text-white/30 mx-auto mb-2" strokeWidth={1.4} />
                    <p className="font-text text-caption text-white/50">尚未添加自定义音乐源</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {onlineSources.map((src) => (
                      <div
                        key={src.id}
                        className={`bg-white/[0.04] border rounded-md px-3.5 py-3 transition-colors duration-200 ease-mineradio ${
                          src.enabled ? 'border-white/10' : 'border-white/10 opacity-60'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <input
                            type="text"
                            value={src.name}
                            placeholder="源名称"
                            onChange={(e) => updateOnlineSource(src.id, { name: e.target.value })}
                            className="flex-1 bg-transparent font-text text-caption-strong text-white/90 outline-none border-b border-transparent focus:border-mint/50 transition-colors duration-200 py-1"
                          />
                          <button
                            type="button"
                            role="switch"
                            aria-checked={src.enabled}
                            onClick={() => updateOnlineSource(src.id, { enabled: !src.enabled })}
                            className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
                              src.enabled ? 'bg-mint' : 'bg-white/15'
                            }`}
                          >
                            <span
                              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
                                src.enabled ? 'translate-x-4.5' : 'translate-x-1'
                              }`}
                            />
                          </button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-white/40 hover:text-coral hover:bg-coral/10 transition-all duration-200 ease-mineradio"
                            onClick={() => removeOnlineSource(src.id)}
                          >
                            <Trash2 className="h-4 w-4" strokeWidth={1.6} />
                          </Button>
                        </div>
                        <input
                          type="text"
                          value={src.apiUrl}
                          placeholder="https://your-api.com/search?q={query}"
                          onChange={(e) => updateOnlineSource(src.id, { apiUrl: e.target.value })}
                          className="w-full bg-white/[0.03] border border-white/10 rounded-sm px-2.5 py-1.5 font-text text-caption text-white/70 outline-none focus:border-mint/50 transition-colors duration-200"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 协议说明 */}
              <div className="bg-white/[0.02] border border-white/[0.06] rounded-md px-3.5 py-3">
                <p className="font-text text-caption text-white/50 leading-relaxed">
                  接口地址需包含 <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{query}`}</code> 占位符（搜索时替换为关键词）。
                  响应需为 JSON，支持数组或 <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{results:[]}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{data:[]}`}</code> / <code className="text-mint/80 bg-mint/[0.08] px-1 rounded-sm">{`{songs:[]}`}</code> 结构。
                  每项字段：<span className="text-white/70">title / artist / album / duration（秒）/ coverUrl / audioUrl（必填）</span>。
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
        </div>
      </div>
    </PageLayout>
  )
}

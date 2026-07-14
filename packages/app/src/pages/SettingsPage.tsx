import React from 'react'
import { Settings as SettingsIcon, Monitor, Moon, Sun, Eye, FolderOpen, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLibraryStore } from '@/stores/libraryStore'
import { isDesktop } from '@/lib/utils'

const glassOptions = [
  { value: 'auto' as const, label: '液态玻璃', icon: Eye },
  { value: 'flat' as const, label: '纯色扁平', icon: Sun },
]

const themeOptions = [
  { value: 'dark' as const, label: '深色', icon: Moon },
  { value: 'light' as const, label: '浅色', icon: Sun },
  { value: 'system' as const, label: '跟随系统', icon: Monitor },
]

export function SettingsPage() {
  const theme = useLibraryStore((s) => s.theme)
  const setTheme = useLibraryStore((s) => s.setTheme)
  const glassMode = useLibraryStore((s) => s.glassMode)
  const setGlassMode = useLibraryStore((s) => s.setGlassMode)
  const scanFolders = useLibraryStore((s) => s.scanFolders)
  const removeScanFolder = useLibraryStore((s) => s.removeScanFolder)
  const api = (window as any).electronAPI

  const handlePickFolder = async () => {
    if (!api) return
    const folder = await api.pickFolder()
    if (folder) {
      useLibraryStore.getState().addScanFolder(folder)
      await api.scanFolder(folder)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-5 mb-8 px-1">
        <div className="w-20 h-20 rounded-lg bg-white/[0.04] border border-white/5 flex items-center justify-center">
          <SettingsIcon className="h-9 w-9 text-mint" strokeWidth={1.4} />
        </div>
        <div>
          <h1 className="font-display text-display-md text-white">设置</h1>
          <p className="font-text text-caption text-white/60 mt-1">自定义你的 Aurora Music</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2 space-y-5 max-w-2xl">
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
                    className={`inline-flex items-center gap-2 px-4 py-2 rounded-pill text-caption font-normal tracking-[-0.224px] transition-all duration-200 ease-apple active:scale-95 ${
                      theme === value
                        ? 'bg-mint text-white'
                        : 'bg-transparent text-white border border-white/10 hover:bg-mint/[0.075]'
                    }`}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.6} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="font-text text-caption-strong mb-3 text-white/80">视觉效果</p>
              <div className="flex gap-2">
                {glassOptions.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    onClick={() => setGlassMode(value)}
                    className={`inline-flex items-center gap-2 px-4 py-2 rounded-pill text-caption font-normal tracking-[-0.224px] transition-all duration-200 ease-apple active:scale-95 ${
                      glassMode === value
                        ? 'bg-mint text-white'
                        : 'bg-transparent text-white border border-white/10 hover:bg-mint/[0.075]'
                    }`}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.6} />
                    {label}
                  </button>
                ))}
              </div>
              <p className="font-text text-caption text-white/60 mt-3 leading-relaxed">
                液态玻璃材质会折射当前播放封面的色调；如遇性能问题或不喜欢透明感可切换为纯色模式
              </p>
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
              {isDesktop() && (
                <Button variant="secondary" size="sm" className="h-9 px-3.5" onClick={handlePickFolder}>
                  <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                  添加目录
                </Button>
              )}
            </div>
            {scanFolders.length === 0 ? (
              <p className="font-text text-caption text-white/60 py-2">尚未添加任何目录</p>
            ) : (
              <div className="space-y-2">
                {scanFolders.map((folder) => (
                  <div key={folder} className="flex items-center justify-between bg-white/[0.04] border border-white/5 rounded-md px-3.5 py-3">
                    <span className="font-text text-caption truncate flex-1 mr-2 text-white/80">{folder}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-white/40 hover:text-destructive hover:bg-destructive/10 transition-all duration-200 ease-apple"
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
      </div>
    </div>
  )
}

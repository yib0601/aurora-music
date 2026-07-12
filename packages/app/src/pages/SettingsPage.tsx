import React from 'react'
import { Settings as SettingsIcon, Monitor, Moon, Sun, Eye, FolderOpen, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLibraryStore } from '@/stores/libraryStore'
import { isDesktop } from '@/lib/utils'

const glassOptions = [
  { value: 'auto' as const, label: '自动检测', icon: Monitor },
  { value: 'forced' as const, label: '强制毛玻璃', icon: Eye },
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
        <div className="w-20 h-20 rounded-[18px] glass-card flex items-center justify-center shadow-lg shadow-primary/10">
          <SettingsIcon className="h-9 w-9 text-primary" strokeWidth={1.4} />
        </div>
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-foreground/90">设置</h1>
          <p className="text-foreground/40 text-[13px] mt-1">自定义你的 Aurora Music</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin pr-2 -mr-2 space-y-5 max-w-2xl">
        <section className="glass-card p-5">
          <h2 className="text-[15px] font-semibold mb-5 text-foreground/90">外观</h2>
          <div className="space-y-6">
            <div>
              <p className="text-[13px] font-medium mb-3 text-foreground/75">主题</p>
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
                    className={`flex items-center gap-2 px-4 py-2 rounded-[13px] text-[13px] font-medium transition-all duration-200 ease-apple ${
                      theme === value
                        ? 'bg-primary text-primary-foreground shadow-md shadow-primary/20 hover:scale-[1.02]'
                        : 'bg-foreground/5 hover:bg-foreground/10 hover:scale-[1.02]'
                    }`}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.6} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[13px] font-medium mb-3 text-foreground/75">视觉效果</p>
              <div className="flex gap-2">
                {glassOptions.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    onClick={() => setGlassMode(value)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-[13px] text-[13px] font-medium transition-all duration-200 ease-apple ${
                      glassMode === value
                        ? 'bg-primary text-primary-foreground shadow-md shadow-primary/20 hover:scale-[1.02]'
                        : 'bg-foreground/5 hover:bg-foreground/10 hover:scale-[1.02]'
                    }`}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.6} />
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[12px] text-foreground/40 mt-3 leading-relaxed">
                毛玻璃效果在不同桌面环境下表现不同，如遇性能问题可切换为纯色模式
              </p>
            </div>
          </div>
        </section>

        <section className="glass-card p-5">
          <h2 className="text-[15px] font-semibold mb-4 text-foreground/90">音乐库</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-medium text-foreground/75">扫描目录</p>
                <p className="text-[12px] text-foreground/40 mt-0.5">应用会扫描这些目录中的音乐文件</p>
              </div>
              {isDesktop() && (
                <Button variant="outline" size="sm" className="rounded-[13px] border-border/40 bg-transparent hover:bg-foreground/5 text-[13px] h-9 px-3.5 transition-all duration-200 ease-apple hover:scale-[1.02]" onClick={handlePickFolder}>
                  <FolderOpen className="h-4 w-4 mr-2" strokeWidth={1.6} />
                  添加目录
                </Button>
              )}
            </div>
            {scanFolders.length === 0 ? (
              <p className="text-[13px] text-foreground/40 py-2">尚未添加任何目录</p>
            ) : (
              <div className="space-y-2">
                {scanFolders.map((folder) => (
                  <div key={folder} className="flex items-center justify-between glass rounded-[13px] px-3.5 py-3">
                    <span className="text-[13px] truncate flex-1 mr-2 text-foreground/80">{folder}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-lg text-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all duration-200 ease-apple hover:scale-105"
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

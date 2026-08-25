import { useEffect, useState, useCallback } from 'react'
import { ChevronRight, ChevronLeft, Folder, Check, AlertCircle, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { platform } from '@/services/platform'
import type { FileInfo } from '@/types'

interface MobileFolderPickerProps {
  open: boolean
  /** 用户确认选择时回调，参数为相对 ExternalStorage 的路径（如 'Music'） */
  onSelected: (path: string) => void
  onClose: () => void
}

/**
 * 移动端文件夹选择器：通过 Capacitor Filesystem 列目录能力，
 * 让用户像桌面端一样以目录树方式浏览并选择文件夹，替代旧版 window.prompt 手填路径。
 * 列目录调用走 platform.readDir（对应 Directory.ExternalStorage），路径形式与 scanner 完全一致。
 */
export function MobileFolderPicker({ open, onSelected, onClose }: MobileFolderPickerProps) {
  const [currentPath, setCurrentPath] = useState<string>('') // 相对路径，'' 表示根
  const [entries, setEntries] = useState<FileInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDir = useCallback(async (dir: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await platform.readDir(dir)
      // 仅展示目录（文件对选目录无意义），按字母排序
      const dirs = result
        .filter((e) => e.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
      setEntries(dirs)
    } catch (err) {
      console.warn('[MobileFolderPicker] readDir 失败:', dir, err)
      setError('无法读取该目录，请检查存储权限')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setCurrentPath('')
      loadDir('')
    }
  }, [open, loadDir])

  const breadcrumbs = currentPath ? currentPath.split('/') : []

  const handleEnter = (name: string) => {
    const next = currentPath ? `${currentPath}/${name}` : name
    setCurrentPath(next)
    loadDir(next)
  }

  const handleBack = () => {
    if (!currentPath) return
    const idx = currentPath.lastIndexOf('/')
    const next = idx === -1 ? '' : currentPath.slice(0, idx)
    setCurrentPath(next)
    loadDir(next)
  }

  const handleConfirm = () => {
    // 根目录也允许选择（即扫描整个 ExternalStorage）
    onSelected(currentPath)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[92vw] max-w-md h-[75vh] max-h-[640px] flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-white">选择扫描目录</DialogTitle>
          <p className="font-text text-caption text-white/60 mt-1">
            浏览并选择包含音乐文件的文件夹
          </p>
        </DialogHeader>

        {/* 面包屑 */}
        <div className="flex items-center gap-1 px-5 pb-2 text-caption text-white/70 overflow-x-auto scrollbar-thin">
          <button
            onClick={() => { setCurrentPath(''); loadDir('') }}
            className="font-text hover:text-mint transition-colors whitespace-nowrap"
          >
            存储
          </button>
          {breadcrumbs.map((seg, i) => {
            const p = breadcrumbs.slice(0, i + 1).join('/')
            return (
              <span key={p} className="flex items-center gap-1 whitespace-nowrap">
                <ChevronRight className="h-3.5 w-3.5 text-white/40" strokeWidth={1.8} />
                <button
                  onClick={() => { setCurrentPath(p); loadDir(p) }}
                  className="font-text hover:text-mint transition-colors truncate max-w-[120px]"
                >
                  {seg}
                </button>
              </span>
            )
          })}
        </div>

        {/* 目录列表 */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-3">
          {loading ? (
            <div className="flex items-center justify-center h-full text-white/50">
              <Loader2 className="h-5 w-5 animate-spin mr-2" strokeWidth={1.8} />
              读取中…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-white/60 gap-3 px-6 text-center">
              <AlertCircle className="h-8 w-8 text-coral" strokeWidth={1.6} />
              <p className="font-text text-caption">{error}</p>
              <Button variant="secondary" size="sm" onClick={() => loadDir(currentPath)}>
                重试
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-white/50 gap-2 px-6 text-center">
              <Folder className="h-8 w-8" strokeWidth={1.6} />
              <p className="font-text text-caption">此目录下没有子文件夹</p>
              <p className="font-text text-caption text-white/40">可点击下方"选择此目录"直接扫描当前位置</p>
            </div>
          ) : (
            <ul className="space-y-1 pb-2">
              {currentPath && (
                <li>
                  <button
                    onClick={handleBack}
                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-md hover:bg-white/[0.06] transition-colors text-white/60"
                  >
                    <ChevronLeft className="h-4 w-4" strokeWidth={1.8} />
                    <span className="font-text text-caption">返回上级</span>
                  </button>
                </li>
              )}
              {entries.map((e) => (
                <li key={e.path}>
                  <button
                    onClick={() => handleEnter(e.name)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-md bg-white/[0.03] border border-white/8 hover:bg-white/[0.08] hover:border-white/14 transition-all duration-200 ease-mineradio"
                  >
                    <Folder className="h-5 w-5 text-mint/80 flex-shrink-0" strokeWidth={1.6} />
                    <span className="font-text text-caption text-white/90 truncate flex-1 text-left">
                      {e.name}
                    </span>
                    <ChevronRight className="h-4 w-4 text-white/30 flex-shrink-0" strokeWidth={1.8} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 底部操作 */}
        <DialogFooter className="px-5 py-4 border-t border-white/8 flex items-center justify-between gap-3 sm:justify-between">
          <span className="font-text text-caption text-white/60 truncate flex-1">
            当前：{currentPath || '存储根目录'}
          </span>
          <div className="flex gap-2 flex-shrink-0">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-white/70">
              取消
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleConfirm}
              disabled={loading}
              className="bg-mint text-mint-fg hover:bg-mint/90"
            >
              <Check className="h-4 w-4 mr-1.5" strokeWidth={1.8} />
              选择此目录
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useState } from 'react'
import { CheckCircle2, Download, Loader2, AlertCircle, FolderOpen } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toast'
import { useUpdateDownloadStore } from '@/stores/updateDownloadStore'
import { isMobile } from '@/lib/utils'
import {
  canInstallApk,
  installApk,
  openInstallPermissionSettings,
} from '@/services/mobile-update'

/**
 * 内置更新下载/安装对话框（全局唯一实例，由 App 挂载）。
 * 下载进度、完成、失败状态由 updateDownloadStore 驱动；
 * 下载中可收起（任务继续后台进行），完成/失败时自动重新弹出。
 */

function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '0 MB'
  const mb = n / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

/** 各安装包类型的「现在安装」说明文案 */
const INSTALL_HINT: Record<string, string> = {
  exe: '启动安装器后将退出当前应用，按向导完成安装',
  appimage: '启动新版本后将退出当前应用，直接运行新文件即完成更新',
  deb: '将打开系统终端执行 sudo 安装命令，输入密码确认即可',
  rpm: '将打开系统终端执行 sudo 安装命令，输入密码确认即可',
  apk: '将调起系统安装界面，按提示确认安装；若提示未授权，请先允许本应用「安装未知应用」',
}

export function UpdateDownloadDialog() {
  const phase = useUpdateDownloadStore((s) => s.phase)
  const task = useUpdateDownloadStore((s) => s.task)
  const received = useUpdateDownloadStore((s) => s.received)
  const total = useUpdateDownloadStore((s) => s.total)
  const filePath = useUpdateDownloadStore((s) => s.filePath)
  const error = useUpdateDownloadStore((s) => s.error)
  const visible = useUpdateDownloadStore((s) => s.visible)
  const cancel = useUpdateDownloadStore((s) => s.cancel)
  const reset = useUpdateDownloadStore((s) => s.reset)
  const hide = useUpdateDownloadStore((s) => s.hide)
  const start = useUpdateDownloadStore((s) => s.start)
  const [installing, setInstalling] = useState(false)

  const open = visible && phase !== 'idle' && !!task
  const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null

  const handleClose = (nextOpen: boolean) => {
    if (nextOpen) return
    if (phase === 'downloading') {
      hide() // 下载中仅收起，任务继续
    } else {
      reset()
    }
  }

  /**
   * 点击安装：
   * - Android：走 FileProvider 调起系统安装器；未授予「安装未知应用」时引导去设置页；
   *   按产品要求只调起安装器，不做静默安装，用户仍需在系统界面确认。
   * - 桌面端：交给 Electron 主进程按包类型启动安装器 / 终端。
   */
  const handleInstall = async () => {
    if (!filePath || !task || installing) return
    setInstalling(true)
    try {
      if (isMobile()) {
        const result = await installApk(filePath)
        if (!result.launched && result.needPermission) {
          toast('请先允许本应用安装未知应用，授权后回来再次点击「去安装」', { duration: 8000 })
          await openInstallPermissionSettings()
        }
        return
      }
      const api = (window as any).electronAPI.updater
      const result = await api.install(filePath, task.kind)
      if (result?.action === 'terminal') {
        toast('已在终端打开安装命令，请按提示输入密码', { duration: 8000 })
      }
      // exe / appimage 会启动安装器并退出当前应用，无需后续处理
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : '启动安装失败', { type: 'error' })
    } finally {
      setInstalling(false)
    }
  }

  const handleReveal = () => {
    if (!filePath) return
    ;(window as any).electronAPI.updater.reveal(filePath).catch(() => {})
  }

  const handleRetry = () => {
    if (!task) return
    start(task)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[17px]">软件更新</DialogTitle>
          <DialogDescription className="font-text text-[12px]">
            {task ? `v${task.version}${task.label ? ` · ${task.label}` : ''}` : ''}
          </DialogDescription>
        </DialogHeader>

        {phase === 'downloading' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 font-text text-[13px] text-white/80">
              <Loader2 className="h-4 w-4 animate-spin text-mint" strokeWidth={1.8} />
              正在下载安装包…
              {percent !== null ? <span className="ml-auto text-mint">{percent}%</span> : null}
            </div>
            {/* 进度条：无 Content-Length 时退化为不确定动画 */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              {percent !== null ? (
                <div
                  className="h-full rounded-full bg-mint transition-[width] duration-200"
                  style={{ width: `${percent}%` }}
                />
              ) : (
                <div className="h-full w-1/3 rounded-full bg-mint animate-pulse" />
              )}
            </div>
            <p className="font-text text-[11px] text-white/45">
              {formatBytes(received)}
              {total ? ` / ${formatBytes(total)}` : ''}
              <span className="ml-2">保存至系统「下载」目录</span>
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={hide}>
                后台下载
              </Button>
              <Button variant="secondary" size="sm" onClick={cancel}>
                取消
              </Button>
            </div>
          </div>
        )}

        {phase === 'done' && filePath && (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5 rounded-lg border border-mint/25 bg-mint/[0.08] px-3.5 py-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-mint" strokeWidth={1.8} />
              <div className="min-w-0">
                <p className="font-text text-[13px] text-white/90">下载完成</p>
                <p className="mt-0.5 break-all font-text text-[11px] leading-4 text-white/45">{filePath}</p>
              </div>
            </div>
            {task && INSTALL_HINT[task.kind] && (
              <p className="font-text text-[11px] leading-4 text-white/45">{INSTALL_HINT[task.kind]}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              {/* 「打开文件夹」依赖桌面端 shell.showItemInFolder；移动端无对等能力，隐藏 */}
              {!isMobile() && (
                <Button variant="ghost" size="sm" onClick={handleReveal}>
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.8} />
                  打开文件夹
                </Button>
              )}
              {task && (
                <Button size="sm" onClick={handleInstall} disabled={installing}>
                  {installing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                  ) : (
                    <Download className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.8} />
                  )}
                  {isMobile() ? '去安装' : '现在安装'}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={reset}>
                稍后
              </Button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5 rounded-lg border border-coral/25 bg-coral/[0.08] px-3.5 py-3">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-coral" strokeWidth={1.8} />
              <p className="min-w-0 break-all font-text text-[13px] text-white/85">{error || '下载失败，请稍后重试'}</p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={reset}>
                关闭
              </Button>
              <Button size="sm" onClick={handleRetry}>
                重试
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

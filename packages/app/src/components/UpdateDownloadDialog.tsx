import { useState } from 'react'
import { CheckCircle2, Download, Loader2, AlertCircle, FolderOpen } from 'lucide-react'
import { translateError, type MessageKey, type TFunction } from '@aurora/shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toast'
import { useUpdateDownloadStore } from '@/stores/updateDownloadStore'
import { isMobile } from '@/lib/utils'
import { useT, appTranslate } from '@/i18n'
import {
  installApk,
  openInstallPermissionSettings,
} from '@/services/mobile-update'

/**
 * 内置更新下载/安装对话框（全局唯一实例，由 App 挂载）。
 * 下载进度、完成、失败状态由 updateDownloadStore 驱动；
 * 下载中可收起（任务继续后台进行），完成/失败时自动重新弹出。
 *
 * 文案约定：
 * - 对话框内所有句子渲染期 t()；store 的 `error` 是**结构化载荷**，
 *   经 `translateError(error, t)` 按当前语言出文案；
 * - 模块级不存任何句子：`INSTALL_HINT` 那张表以前存中文字面量，语言会被冻在
 *   模块加载那一刻，现在存 `MessageKey`，渲染期取译文。
 */

/**
 * `translateError` 的第二个参数声明为内核的 `TFunction`（键类型是通配 string），
 * 而 `useT()` 给的是**收窄键集**的 `AppTranslator`——两者有已知的类型缺口
 * （shared 的 i18n/index.ts 是禁区，本 owner 不改）。这里在显示端收口成一处适配，
 * 避免每个调用点各写一份断言；如 shared 侧后续导出官方桥接函数，删掉本函数即可。
 */
function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '0 MB'
  const mb = n / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}

/** 下载速度展示：主进程每 200ms 推一次瞬时速度 */
function formatSpeed(bps: number | null): string | null {
  if (bps === null || !isFinite(bps) || bps <= 0) return null
  const mb = bps / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(2)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`
}

/** 低于这个速度基本说明线路没走对（正常经代理约 1~2 MB/s） */
const SLOW_BPS = 300 * 1024

/**
 * 各安装包类型的「现在安装」说明：存**键**，渲染期 t()。
 * 键与 update-asset 的 ASSET_LABEL_KEYS 分开维护是刻意的——
 * 那边是「横幅/设置页上的包类型名」，这边是「点安装后会发生什么」，受众不同。
 */
const INSTALL_HINT_KEYS: Record<string, MessageKey> = {
  exe: 'update.hint.exe',
  appimage: 'update.hint.appimage',
  deb: 'update.hint.deb',
  rpm: 'update.hint.rpm',
  dmg: 'update.hint.dmg',
  apk: 'update.hint.apk',
}

export function UpdateDownloadDialog() {
  const t = useT()
  const phase = useUpdateDownloadStore((s) => s.phase)
  const task = useUpdateDownloadStore((s) => s.task)
  const received = useUpdateDownloadStore((s) => s.received)
  const total = useUpdateDownloadStore((s) => s.total)
  const speed = useUpdateDownloadStore((s) => s.speed)
  const route = useUpdateDownloadStore((s) => s.route)
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
  const speedText = formatSpeed(speed)
  // 下载速度明显偏低且已下了不少：多半是没走代理，直接给出可执行的提示
  const slowWarning = phase === 'downloading' && speed !== null && speed < SLOW_BPS && received > 4 * 1024 * 1024

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
          toast(t('update.dialog.needInstallPermission'), { duration: 8000 })
          await openInstallPermissionSettings()
        }
        return
      }
      const api = (window as any).electronAPI.updater
      const result = await api.install(filePath, task.kind)
      if (result?.action === 'terminal') {
        toast(t('update.toast.terminal'), { duration: 8000 })
      }
      if (result?.action === 'mounted') {
        toast(t('update.toast.mounted'), { duration: 8000 })
      }
      // exe / appimage 会启动安装器并退出当前应用，无需后续处理
    } catch (err) {
      // toast 走非渲染期入口（appTranslate 每次读实时快照）；
      // 归一函数认不出来的失败落到 update.error.installFailed，原始文本留在 detail 里
      const text = err === null || err === undefined ? '' : translateError(err, appTranslate())
      toast(text || t('update.error.installFailed'), { type: 'error' })
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
          <DialogTitle className="text-[17px]">{t('update.dialog.title')}</DialogTitle>
          <DialogDescription className="font-text text-[12px]">
            {task ? `v${task.version}${task.label ? ` · ${task.label}` : ''}` : ''}
          </DialogDescription>
        </DialogHeader>

        {phase === 'downloading' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 font-text text-[13px] text-white/80">
              <Loader2 className="h-4 w-4 animate-spin text-mint" strokeWidth={1.8} />
              {t('update.dialog.downloading')}
              <span className="ml-auto flex items-baseline gap-2">
                {speedText ? <span className="text-[11px] text-white/50">{speedText}</span> : null}
                {percent !== null ? <span className="text-mint">{percent}%</span> : null}
              </span>
            </div>
            {/* 进度条：无 Content-Length 时退化为不确定动画 */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
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
              {route ? <span className="ml-2">· {route}</span> : null}
              <span className="ml-2">· {t('update.dialog.savedToDownloads')}</span>
            </p>
            {slowWarning && (
              <p className="rounded-[10px] border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 font-text text-[11px] leading-relaxed text-amber-200/80">
                {t('update.dialog.slowLine')}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={hide}>
                {t('update.dialog.background')}
              </Button>
              <Button variant="secondary" size="sm" onClick={cancel}>
                {t('common.action.cancel')}
              </Button>
            </div>
          </div>
        )}

        {phase === 'done' && filePath && (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5 rounded-[10px] border border-mint/20 bg-mint/[0.06] px-3.5 py-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-mint" strokeWidth={1.8} />
              <div className="min-w-0">
                <p className="font-text text-[13px] text-white/90">{t('update.dialog.done')}</p>
                <p className="mt-0.5 break-all font-text text-[11px] leading-4 text-white/45">{filePath}</p>
              </div>
            </div>
            {task && INSTALL_HINT_KEYS[task.kind] && (
              <p className="font-text text-[11px] leading-4 text-white/45">{t(INSTALL_HINT_KEYS[task.kind])}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              {/* 「打开文件夹」依赖桌面端 shell.showItemInFolder；移动端无对等能力，隐藏 */}
              {!isMobile() && (
                <Button variant="ghost" size="sm" onClick={handleReveal}>
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.8} />
                  {t('update.dialog.reveal')}
                </Button>
              )}
              {task && (
                <Button size="sm" onClick={handleInstall} disabled={installing}>
                  {installing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                  ) : (
                    <Download className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.8} />
                  )}
                  {t(isMobile() ? 'update.dialog.installMobile' : 'update.dialog.installDesktop')}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={reset}>
                {t('update.dialog.later')}
              </Button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5 rounded-[10px] border border-coral/25 bg-coral/[0.07] px-3.5 py-3">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-coral" strokeWidth={1.8} />
              {/* 错误是结构化载荷：按当前语言渲染，不是抛出点烧死的那句话 */}
              <p className="min-w-0 break-all font-text text-[13px] text-white/85">
                {error ? translateError(error, t) : t('update.error.downloadFailed')}
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={reset}>
                {t('update.dialog.close')}
              </Button>
              <Button size="sm" onClick={handleRetry}>
                {t('update.dialog.retry')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

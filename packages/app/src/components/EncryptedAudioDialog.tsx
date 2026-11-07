import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Download, HelpCircle, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toast'
import { useT } from '@/i18n'
import { platform } from '@/services/platform'
import { redownloadEncryptedAudio, type RedownloadResult } from '@/services/encryptedRedownload.service'
import { useLibraryStore } from '@/stores/libraryStore'
import type { EncryptedAudioFamily, EncryptedAudioFile } from '@/types'

interface EncryptedAudioDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 文件名（两端都可能是 `/` 或 `\`，渲染层没有 node:path） */
function baseNameOf(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return cut >= 0 ? p.slice(cut + 1) : p
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 「加密音频 → 用音源重下一份」的对话框。
 *
 * 只做编排与展示：识别在主进程/移动端扫描时完成（shared/encryptedAudio），
 * 匹配与下载在 encryptedRedownload.service 里（可单测）。**不含任何解密逻辑**，
 * 下载走的是用户已配置音源的普通搜索/取址/下载链路。
 */
export function EncryptedAudioDialog({ open, onOpenChange }: EncryptedAudioDialogProps) {
  const t = useT()
  const [snapshot, setSnapshot] = useState<EncryptedAudioFile[]>([])
  const [results, setResults] = useState<Record<string, RedownloadResult>>({})
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<[number, number]>([0, 0])
  const canceledRef = useRef(false)

  // 打开时把待处理列表**快照**下来：运行过程中已完成的条目会从 store 移除，
  // 若直接渲染 store，正在处理的行会突然消失，用户看不到结果
  useEffect(() => {
    if (!open) return
    setSnapshot(useLibraryStore.getState().encryptedFiles)
    setResults({})
    setProgress([0, 0])
    canceledRef.current = false
  }, [open])

  // 平台标签：写成显式映射而不是拼键名，翻译键的类型才有保障
  const familyLabel = (family: EncryptedAudioFamily): string => {
    switch (family) {
      case 'qqmusic':
        return t('library.encrypted.family.qqmusic')
      case 'netease':
        return t('library.encrypted.family.netease')
      case 'kugou':
        return t('library.encrypted.family.kugou')
      case 'kuwo':
        return t('library.encrypted.family.kuwo')
      case 'xiami':
        return t('library.encrypted.family.xiami')
    }
  }

  const handleStart = async () => {
    // 下载能力缺失（老 preload / 未知环境）不静默：说清原因，避免「点了没反应」
    const downloadFile = platform.downloadOnlineTrack
    if (!downloadFile) {
      toast(t('library.encrypted.unsupported'), { type: 'error' })
      return
    }
    const lib = useLibraryStore.getState()
    const sources = lib.onlineSources.filter((s) => s.enabled)
    if (sources.length === 0) {
      toast(t('library.encrypted.noSource'), { type: 'error', duration: 6000 })
      return
    }

    setRunning(true)
    setProgress([0, snapshot.length])
    canceledRef.current = false
    try {
      // 动态导入：playlistIO.service 与 stores 互相引用，静态引入会拉进首屏包
      const { ensurePlayableTrack } = await import('@/services/playlistIO.service')
      const outcomes = await redownloadEncryptedAudio(snapshot, {
        search: (query, options) => platform.searchOnlineTracks(query, options),
        ensurePlayable: (track) => ensurePlayableTrack(track),
        downloadFile: (payload, headers, downloadDir) => downloadFile(payload, headers, downloadDir),
        importFile: platform.importAudioFile,
        config: () => {
          const s = useLibraryStore.getState()
          return { sources: s.onlineSources, downloadDir: s.downloadDir, quality: s.downloadQuality }
        },
        onProgress: (done, total, result) => {
          setProgress([done, total])
          setResults((prev) => ({ ...prev, [result.path]: result }))
        },
        isCanceled: () => canceledRef.current,
      })

      // 成功的从待处理列表移除（其余留着，用户处理完音源后可以再点一次）
      const store = useLibraryStore.getState()
      for (const outcome of outcomes) {
        if (outcome.outcome === 'done') store.removeEncryptedFile(outcome.path)
      }
      const done = outcomes.filter((o) => o.outcome === 'done').length
      const missed = outcomes.filter((o) => o.outcome === 'no-match').length
      const failed = outcomes.length - done - missed
      toast(t('library.encrypted.summary', { done, missed, failed }), {
        type: failed > 0 ? 'error' : undefined,
        duration: 6000,
      })
    } finally {
      setRunning(false)
    }
  }

  const iconFor = (file: EncryptedAudioFile) => {
    const result = results[file.path]
    if (!result) {
      return <Download className="h-3.5 w-3.5 flex-shrink-0 text-white/30" strokeWidth={1.6} />
    }
    switch (result.outcome) {
      case 'done':
        return <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-mint/80" strokeWidth={1.6} />
      case 'failed':
        return <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400/80" strokeWidth={1.6} />
      default:
        return <HelpCircle className="h-3.5 w-3.5 flex-shrink-0 text-amber-400/70" strokeWidth={1.6} />
    }
  }

  const statusFor = (file: EncryptedAudioFile): { text: string; detail?: string } => {
    const result = results[file.path]
    if (!result) {
      // 还没轮到这一条（串行处理，前面的在下）
      return { text: t('library.encrypted.statusPending') }
    }
    switch (result.outcome) {
      case 'done':
        return {
          text: t('library.encrypted.statusDone'),
          detail:
            result.imported === false
              ? t('library.encrypted.importedFailed')
              : result.matchedTitle
                ? t('library.encrypted.matched', { artist: result.matchedArtist ?? '', title: result.matchedTitle })
                : undefined,
        }
      case 'no-match':
        return { text: t('library.encrypted.statusNoMatch') }
      case 'no-address':
        return { text: t('library.encrypted.statusNoAddress') }
      case 'failed':
        return { text: t('library.encrypted.statusFailed'), detail: result.error }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!running) onOpenChange(v) }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {/* 空列表时不能显示「扫描到 0 首」（弹窗只在真有文件时才会打开，
                空态是运行中被清空的边缘情况），改用无数量的事实句 */}
            {snapshot.length > 0
              ? t('library.encrypted.dialogTitle', { count: snapshot.length })
              : t('library.encrypted.dialogEmpty')}
          </DialogTitle>
          <DialogDescription className="font-text text-[12px] leading-relaxed">
            {t('library.encrypted.dialogDesc')}
          </DialogDescription>
        </DialogHeader>

        {snapshot.length === 0 ? (
          <p className="font-text text-[13px] text-white/50 py-6 text-center">
            {t('library.encrypted.dialogDesc')}
          </p>
        ) : (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin border border-white/[0.06] rounded-[10px]">
              {snapshot.map((file) => {
                const status = statusFor(file)
                return (
                  <div key={file.path} className="flex items-start gap-2.5 px-3 py-2 border-b border-white/[0.05] last:border-0">
                    {running && !results[file.path] ? (
                      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-mint/70" strokeWidth={1.6} />
                    ) : (
                      iconFor(file)
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-text text-[13px] text-white/85 truncate">
                        {file.title || baseNameOf(file.path)}
                      </p>
                      <p className="font-text text-[11px] text-white/40 truncate">
                        {[file.artist, familyLabel(file.family), formatSize(file.size)]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {status.detail && (
                        <p className="font-text text-[11px] text-white/30 truncate" title={status.detail}>
                          {status.detail}
                        </p>
                      )}
                    </div>
                    <span className="font-text text-[11px] text-white/45 flex-shrink-0 max-w-[96px] text-right">
                      {status.text}
                    </span>
                  </div>
                )
              })}
            </div>

            {running && progress[1] > 0 && (
              <p className="font-text text-[12px] text-white/50 tabular-nums">
                {t('library.encrypted.progress', { done: progress[0], total: progress[1] })}
              </p>
            )}

            <div className="flex items-center justify-end gap-2.5">
              {running ? (
                <Button variant="secondary" onClick={() => { canceledRef.current = true }}>
                  {t('library.encrypted.cancel')}
                </Button>
              ) : (
                <>
                  {/* 「稍后」而不是「关闭」：这是扫描完成时自动弹出的**提示**，
                      用户点它表达的是「现在不处理」，不是「关掉这个面板」 */}
                  <Button variant="ghost" onClick={() => onOpenChange(false)}>
                    {t('library.encrypted.later')}
                  </Button>
                  <Button variant="primary" onClick={handleStart}>
                    <Download className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    {t('library.encrypted.start')}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

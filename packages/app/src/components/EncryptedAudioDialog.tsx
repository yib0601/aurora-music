import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Download, HelpCircle, Loader2, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/common/Toast'
import { useT } from '@/i18n'
import { platform } from '@/services/platform'
import {
  DEFAULT_REPLACE_CONCURRENCY,
  MAX_REPLACE_CONCURRENCY,
  redownloadEncryptedAudio,
  type RedownloadResult,
} from '@/services/encryptedRedownload.service'
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

/** 并发档可选值：1 = 退回旧的严格串行，方便用户在音源限流时自己降档 */
const CONCURRENCY_STEPS = [1, 2, 3, 4, 6]

/**
 * 「加密音频 → 用音源重下一份」的对话框。
 *
 * 只做编排与展示：识别在主进程/移动端扫描时完成（shared/encryptedAudio），
 * 匹配与下载在 encryptedRedownload.service 里（可单测）。**不含任何解密逻辑**，
 * 下载走的是用户已配置音源的普通搜索/取址/下载链路。
 *
 * 批量替换（本版新增）与「一首一首点」的差别只有三处，都收在这个组件与
 * service 的可选依赖里：
 *   1. **多选**：默认全选（用户打开这个弹窗的意图本来就是「处理这批」），
 *      但要能剔掉那几首不想重下的（音源里没有、或本地就想留着原件）；
 *   2. **有界并发**：串行在四五十首时体感是「点了没反应」，并发档由用户自己定；
 *   3. **替换原件**：下载并入库成功后把原加密文件移入回收站 —— 这才是「替换」，
 *      只下载不清理的话，下次扫描还会把同一批文件再报一遍，等于没换。
 *      未入库（`imported === false`）时**绝不清理**，否则用户两头空。
 */
export function EncryptedAudioDialog({ open, onOpenChange }: EncryptedAudioDialogProps) {
  const t = useT()
  const [snapshot, setSnapshot] = useState<EncryptedAudioFile[]>([])
  const [results, setResults] = useState<Record<string, RedownloadResult>>({})
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<[number, number]>([0, 0])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [replaceSource, setReplaceSource] = useState(true)
  const [concurrency, setConcurrency] = useState(DEFAULT_REPLACE_CONCURRENCY)
  const canceledRef = useRef(false)

  // 平台有没有「移入回收站」能力：没有就整块不渲染（与项目里其它可选能力同一约定，
  // 不做一个点了永远失败的开关）
  const canReplace = typeof platform.trashEncryptedSource === 'function'

  // 打开时把待处理列表**快照**下来：运行过程中已完成的条目会从 store 移除，
  // 若直接渲染 store，正在处理的行会突然消失，用户看不到结果
  useEffect(() => {
    if (!open) return
    const files = useLibraryStore.getState().encryptedFiles
    setSnapshot(files)
    setResults({})
    setProgress([0, 0])
    // 默认全选：打开这个弹窗的意图就是「把这批处理掉」，让用户点掉的应该是例外
    setSelected(new Set(files.map((f) => f.path)))
    canceledRef.current = false
  }, [open])

  const selectedFiles = useMemo(
    () => snapshot.filter((f) => selected.has(f.path)),
    [snapshot, selected]
  )

  const toggleOne = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const allSelected = snapshot.length > 0 && selected.size === snapshot.length

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(snapshot.map((f) => f.path)))
  }

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
    if (selectedFiles.length === 0) {
      toast(t('library.encrypted.nothingSelected'), { type: 'error' })
      return
    }
    const lib = useLibraryStore.getState()
    const sources = lib.onlineSources.filter((s) => s.enabled)
    if (sources.length === 0) {
      toast(t('library.encrypted.noSource'), { type: 'error', duration: 6000 })
      return
    }

    setRunning(true)
    setProgress([0, selectedFiles.length])
    canceledRef.current = false
    try {
      // 动态导入：playlistIO.service 与 stores 互相引用，静态引入会拉进首屏包
      const { ensurePlayableTrack } = await import('@/services/playlistIO.service')
      const outcomes = await redownloadEncryptedAudio(selectedFiles, {
        search: (query, options) => platform.searchOnlineTracks(query, options),
        ensurePlayable: (track) => ensurePlayableTrack(track),
        downloadFile: (payload, headers, downloadDir) => downloadFile(payload, headers, downloadDir),
        importFile: platform.importAudioFile,
        // 缺这条通道时传 undefined（service 侧据此整段跳过），不塞一个假实现
        removeSourceFile: canReplace ? platform.trashEncryptedSource : undefined,
        config: () => {
          const s = useLibraryStore.getState()
          return { sources: s.onlineSources, downloadDir: s.downloadDir, quality: s.downloadQuality }
        },
        concurrency,
        replaceSource: canReplace && replaceSource,
        // 整批期间挂起「文件变动 → 整库重扫」：一批几十首连续写盘会把 watcher 的
        // 1.5s 防抖不断重置，重扫几乎不停地在跑，与下载抢 IO；结束时补扫一次即可。
        // 平台没有这个能力时两边都是 undefined，service 侧整段跳过。
        onBatchStart: platform.setWatchSuspended
          ? () => platform.setWatchSuspended!(true)
          : undefined,
        onBatchEnd: platform.setWatchSuspended
          ? () => platform.setWatchSuspended!(false)
          : undefined,
        // 入库成功后立刻把曲目追加进曲库：否则用户看到「替换成功」而列表还是旧的，
        // 只能自己去重扫目录
        onTrackImported: (track) => {
          useLibraryStore.getState().addTracks([track])
        },
        onProgress: (done, total, result) => {
          setProgress([done, total])
          setResults((prev) => ({ ...prev, [result.path]: result }))
        },
        isCanceled: () => canceledRef.current,
      })

      // 成功的从待处理列表移除（其余留着，用户处理完音源后可以再点一次）。
      // 「清理成功」也要移除一条同名记录：即便文件还在（清理失败），它已经没意义了；
      // 清理失败的行会带上 sourceKept 提示，用户自己决定要不要手动删。
      const store = useLibraryStore.getState()
      for (const outcome of outcomes) {
        if (outcome.outcome === 'done') store.removeEncryptedFile(outcome.path)
      }
      const done = outcomes.filter((o) => o.outcome === 'done').length
      const missed = outcomes.filter((o) => o.outcome === 'no-match').length
      const failed = outcomes.filter((o) => o.outcome === 'failed').length
      const canceled = outcomes.filter((o) => o.outcome === 'canceled').length
      const removed = outcomes.filter((o) => o.sourceRemoved === true).length

      // 三条结局分开报：取消不是失败，把它算进 failed 会让用户以为音源坏了
      if (canceled > 0) {
        toast(t('library.encrypted.summaryCanceled', { count: canceled }), { duration: 5000 })
      }
      toast(
        removed > 0
          ? t('library.encrypted.summaryWithCleanup', { done, removed, missed, failed })
          : t('library.encrypted.summary', { done, missed, failed }),
        { type: failed > 0 ? 'error' : undefined, duration: 6000 }
      )
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
        return <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-mint-text/80" strokeWidth={1.6} />
      case 'failed':
        return <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400/80" strokeWidth={1.6} />
      default:
        return <HelpCircle className="h-3.5 w-3.5 flex-shrink-0 text-amber-400/70" strokeWidth={1.6} />
    }
  }

  const statusFor = (file: EncryptedAudioFile): { text: string; detail?: string } => {
    const result = results[file.path]
    if (!result) {
      // 还没轮到这一条（并发档决定同一时刻有几条在跑）
      return { text: t('library.encrypted.statusPending') }
    }
    switch (result.outcome) {
      case 'done':
        return {
          text: t('library.encrypted.statusDone'),
          detail:
            result.imported === false
              ? t('library.encrypted.importedFailed')
              : // 清理结果优先展示：用户勾了「替换原件」时最关心的就是这个文件还在不在
                result.sourceRemoved === false
                ? t('library.encrypted.cleanupFailed', { reason: result.cleanupError ?? '' })
                : result.sourceRemoved === true
                  ? [t('library.encrypted.sourceRemoved'), result.matchedTitle ?? ''].filter(Boolean).join(' · ')
                  : result.cleanupError
                    ? t('library.encrypted.cleanupFailed', { reason: result.cleanupError })
                    : result.matchedTitle
                      ? t('library.encrypted.matched', {
                          artist: result.matchedArtist ?? '',
                          title: result.matchedTitle,
                        })
                      : undefined,
        }
      case 'no-match':
        return { text: t('library.encrypted.statusNoMatch') }
      case 'no-address':
        return { text: t('library.encrypted.statusNoAddress') }
      case 'canceled':
        return { text: t('library.encrypted.statusCanceled') }
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
            {/* 批量工具条：多选 + 并发档 + 替换原件。运行中全部禁用 ——
                这些参数是「这一批怎么跑」的定义，跑到一半改会让同一批出现两种口径 */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-white/[0.06] rounded-[10px] px-3 py-2">
              <button
                type="button"
                className="pill pill-sm pill-soft"
                onClick={toggleAll}
                disabled={running}
              >
                {allSelected ? t('library.encrypted.selectNone') : t('library.encrypted.selectAll')}
              </button>
              <span className="font-text text-[12px] text-white/50 tabular-nums">
                {t('library.encrypted.selectedCount', { count: selected.size })}
              </span>

              <label className="ml-auto flex items-center gap-1.5 font-text text-[12px] text-white/60">
                {t('library.encrypted.concurrency')}
                {/* 样式复用设置页音源表单的 select（.inset-field），同一个应用里
                    同类控件长得不一样会让人以为它们不是一回事 */}
                <select
                  className="inset-field px-2 py-1 font-text text-[12px] text-white/85 cursor-pointer disabled:opacity-50"
                  value={concurrency}
                  disabled={running}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                >
                  {CONCURRENCY_STEPS.filter((n) => n <= MAX_REPLACE_CONCURRENCY).map((n) => (
                    <option key={n} value={n}>
                      {t('library.encrypted.concurrencyUnit', { n })}
                    </option>
                  ))}
                </select>
              </label>

              {canReplace && (
                <label
                  className="flex items-center gap-1.5 font-text text-[12px] text-white/60"
                  title={t('library.encrypted.replaceToggleHint')}
                >
                  <input
                    type="checkbox"
                    className="enc-check"
                    checked={replaceSource}
                    disabled={running}
                    onChange={(e) => setReplaceSource(e.target.checked)}
                  />
                  <Trash2 className="h-3 w-3" strokeWidth={1.6} />
                  {t('library.encrypted.replaceToggle')}
                </label>
              )}
            </div>
            {!canReplace && (
              <p className="font-text text-[11px] text-white/40">{t('library.encrypted.replaceUnsupported')}</p>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin border border-white/[0.06] rounded-[10px]">
              {snapshot.map((file) => {
                const status = statusFor(file)
                const isSelected = selected.has(file.path)
                return (
                  <div key={file.path} className="flex items-start gap-2.5 px-3 py-2 border-b border-white/[0.05] last:border-0">
                    <input
                      type="checkbox"
                      className="enc-check mt-1 flex-shrink-0 disabled:opacity-40"
                      checked={isSelected}
                      disabled={running}
                      aria-label={file.title || baseNameOf(file.path)}
                      onChange={() => toggleOne(file.path)}
                    />
                    {running && isSelected && !results[file.path] ? (
                      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-mint-text/70" strokeWidth={1.6} />
                    ) : (
                      iconFor(file)
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-text text-[13px] text-white/85 truncate">
                        {file.title || baseNameOf(file.path)}
                      </p>
                      <p className="font-text text-[11px] text-white/50 truncate">
                        {[file.artist, familyLabel(file.family), formatSize(file.size)]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {status.detail && (
                        <p className="font-text text-[11px] text-white/50 truncate" title={status.detail}>
                          {status.detail}
                        </p>
                      )}
                    </div>
                    <span className="font-text text-[11px] text-white/50 flex-shrink-0 max-w-[96px] text-right">
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
                  <Button
                    variant="primary"
                    onClick={handleStart}
                    disabled={selected.size === 0}
                  >
                    <Download className="h-4 w-4 mr-2" strokeWidth={1.6} />
                    {selected.size === snapshot.length
                      ? t('library.encrypted.replaceAll')
                      : t('library.encrypted.replaceSelected')}
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

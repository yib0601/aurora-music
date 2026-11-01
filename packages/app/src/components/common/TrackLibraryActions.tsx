import { create } from 'zustand'
import { platform } from '@/services/platform'
import { useLibraryStore } from '@/stores/libraryStore'
import { useT } from '@/i18n'
import { toast } from '@/components/common/Toast'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Track } from '@/types'

/**
 * 曲目行「从曲库移除 / 在文件夹中显示」两个动作的共用实现。
 *
 * 为什么抽出来而不是各菜单各写一份：曲目菜单在仓库里共有四套代码
 * （VirtualTrackTable 的行菜单、VirtualCardGrid 的卡片菜单、收藏页/最近播放页的
 * table 菜单、歌曲详情页的头部菜单）。「二次确认 + 能力探测 + 失败提示」一旦各处
 * 手写，必然出现「某处忘了确认」或「某处点了没反应」。
 *
 * 确认态放在**模块级 store**、弹层由 App 挂一次（RemoveTrackConfirmHost）：
 * 菜单行是虚拟化且 memo 的，把 Dialog 放进每一行会让上千行各持一份弹层状态，
 * 且滚动出视口时行会被卸载，弹层会在用户点确认之前凭空消失。
 */
interface RemoveTrackConfirmState {
  /** 待确认的曲目：null 表示弹层关闭 */
  pending: Track | null
  busy: boolean
  request: (track: Track) => void
  cancel: () => void
  confirm: () => Promise<void>
}

const useRemoveTrackConfirm = create<RemoveTrackConfirmState>((set, get) => ({
  pending: null,
  busy: false,
  request: (track) => set({ pending: track }),
  cancel: () => {
    // 删除进行中不允许关闭：关掉弹层但删了一半，用户会以为没删
    if (get().busy) return
    set({ pending: null })
  },
  confirm: async () => {
    const target = get().pending
    if (!target) return
    set({ busy: true })
    try {
      await useLibraryStore.getState().removeTrack(target.id)
    } finally {
      set({ busy: false, pending: null })
    }
  },
}))

/** 请求从曲库移除（任意菜单项调用；真正的删除发生在确认之后） */
export function requestRemoveTrackFromLibrary(track: Track): void {
  useRemoveTrackConfirm.getState().request(track)
}

/** 当前平台是否支持「在文件夹中显示」：UI 据它决定是否渲染菜单项，而不是点了才失败 */
export function canRevealInFolder(): boolean {
  return typeof platform.revealTrack === 'function'
}

/**
 * 在文件管理器中定位曲目。平台无此能力时直接返回（入口本就不该显示）。
 * 失败只给一句通用提示：文件已被外部删除 / 远端曲目没有本机文件 / 老版 preload
 * 对用户是同一件事——这个位置现在打不开。
 */
export async function revealTrackInFolder(trackId: string, failedLabel: string): Promise<void> {
  const reveal = platform.revealTrack
  if (typeof reveal !== 'function') return
  let ok = false
  try {
    ok = await reveal(trackId)
  } catch {
    ok = false
  }
  if (!ok) toast(failedLabel, { type: 'error' })
}

/**
 * 「从曲库移除」二次确认弹层。**全局挂一次**（见 App.tsx），任何页面的菜单都能唤起。
 *
 * 用仓库既有的 Dialog 组件而不是 window.confirm：原生弹窗在 Electron 里是阻塞式模态，
 * 且承载不了「只删记录、不删磁盘文件」这句需要独立排版的说明——而这句话正是
 * 本操作唯一的风险提示，用户对「移除 vs 删除」的预期差别很大。
 */
export function RemoveTrackConfirmHost() {
  const t = useT()
  const pending = useRemoveTrackConfirm((s) => s.pending)
  const busy = useRemoveTrackConfirm((s) => s.busy)
  const cancel = useRemoveTrackConfirm((s) => s.cancel)
  const confirm = useRemoveTrackConfirm((s) => s.confirm)

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) cancel() }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('library.action.removeFromLibrary')}</DialogTitle>
          <DialogDescription>{t('library.action.removeFromLibraryHint')}</DialogDescription>
        </DialogHeader>
        {pending && (
          <p className="font-text text-[13px] text-white/70 truncate" title={pending.title}>
            {pending.title}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button variant="secondary" onClick={confirm} disabled={busy}>
            {t('library.action.removeFromLibrary')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

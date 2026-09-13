import { create } from 'zustand'
import { isDesktop } from '@/lib/utils'
import type { AssetKind } from '@/services/update-asset'

/**
 * 内置更新下载的全局状态：横幅、设置页与下载对话框共用同一个下载任务，
 * 避免多处重复触发；进度/完成/失败由模块级事件订阅从主进程推进。
 */

export type UpdatePhase = 'idle' | 'downloading' | 'done' | 'error'

export interface UpdateTask {
  url: string
  kind: AssetKind
  version: string
  /** 用于展示的安装包类型名，如「RPM 包」 */
  label: string | null
}

interface UpdateDownloadState {
  phase: UpdatePhase
  task: UpdateTask | null
  received: number
  total: number | null
  /** 下载完成后的安装包路径（done 阶段） */
  filePath: string | null
  /** error 阶段的原因 */
  error: string | null
  /** 详情对话框是否可见（下载中可收起，完成/失败时自动重新弹出） */
  visible: boolean
  start: (task: UpdateTask) => void
  cancel: () => void
  reset: () => void
  show: () => void
  hide: () => void
}

let eventCleanups: Array<() => void> = []

function teardownEvents() {
  eventCleanups.forEach((fn) => fn())
  eventCleanups = []
}

/** 订阅主进程下载事件（重复订阅前先清理，保证只有一套监听） */
function setupEvents(set: (partial: Partial<UpdateDownloadState>) => void) {
  const api = (window as any).electronAPI?.updater
  if (!api) return
  eventCleanups = [
    api.onProgress((p: { received: number; total: number | null }) => {
      set({ received: p.received, total: p.total })
    }),
    api.onDone((p: { filePath: string }) => {
      // 完成时重新弹出详情框，即使用户下载中收起了它
      set({ phase: 'done', filePath: p.filePath, visible: true })
    }),
    api.onError((message: string) => {
      set({ phase: 'error', error: message || '下载失败，请稍后重试', visible: true })
    }),
  ]
}

export const useUpdateDownloadStore = create<UpdateDownloadState>()((set, get) => ({
  phase: 'idle',
  task: null,
  received: 0,
  total: null,
  filePath: null,
  error: null,
  visible: false,

  start: (task) => {
    if (!isDesktop()) return
    if (get().phase === 'downloading') return // 已有任务在跑
    teardownEvents()
    setupEvents((partial) => set(partial))
    set({ phase: 'downloading', task, received: 0, total: null, filePath: null, error: null, visible: true })
    ;(window as any).electronAPI.updater
      .download(task.url, task.kind)
      .catch((err: unknown) => {
        // 正常失败已由 onError 事件落到 error 状态；
        // 这里只兜底「事件通道缺失」或取消后 invoke 拒绝的情况
        if (get().phase === 'downloading') {
          set({
            phase: 'error',
            error: err instanceof Error && err.message ? err.message : '下载失败，请稍后重试',
            visible: true,
          })
        }
      })
  },

  cancel: () => {
    const api = (window as any).electronAPI?.updater
    api?.cancel?.().catch(() => {})
    teardownEvents()
    set({ phase: 'idle', task: null, received: 0, total: null, filePath: null, error: null, visible: false })
  },

  reset: () => {
    teardownEvents()
    set({ phase: 'idle', task: null, received: 0, total: null, filePath: null, error: null, visible: false })
  },

  show: () => {
    if (get().phase !== 'idle') set({ visible: true })
  },

  hide: () => set({ visible: false }),
}))

/** 是否支持内置下载（仅桌面端且 preload 暴露了 updater 能力） */
export function isInAppUpdateAvailable(): boolean {
  return isDesktop() && !!(window as any).electronAPI?.updater
}

/** 便捷入口：发起内置下载；不支持时返回 false，调用方自行回退浏览器下载 */
export function startInAppDownload(task: UpdateTask): boolean {
  if (!isInAppUpdateAvailable()) return false
  useUpdateDownloadStore.getState().start(task)
  return true
}

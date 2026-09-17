import { create } from 'zustand'
import { isDesktop, isMobile } from '@/lib/utils'
import type { AssetKind } from '@/services/update-asset'
import {
  cancelDownload as cancelMobileDownload,
  downloadApk,
  isMobileUpdaterAvailable,
  queryProgress,
} from '@/services/mobile-update'

/**
 * 内置更新下载的全局状态：横幅、设置页与下载对话框共用同一个下载任务，
 * 避免多处重复触发。
 *
 * 两条平台链路统一到同一套 phase/task：
 * - 桌面端：Electron 主进程流式下载，进度/完成/失败经 updater 事件通道推进；
 * - Android：系统 DownloadManager 下载，按固定间隔轮询 progress() 推进。
 * UI（横幅 / 设置页 / 下载对话框）无需区分平台。
 */

export type UpdatePhase = 'idle' | 'downloading' | 'done' | 'error'

export interface UpdateTask {
  url: string
  /** 候选下载地址（GitHub 官方 + 加速前缀）：主进程按序降级重试；缺省时只用 url */
  altUrls?: string[]
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

// ---- 移动端：原生下载 + 轮询进度 ----

/** 轮询间隔：原生下载线程没有事件通道，只能定时查询（1 秒足够跟上进度条） */
const POLL_INTERVAL_MS = 1000
let pollTimer: ReturnType<typeof setInterval> | null = null

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * 启动轮询：把原生下载状态映射到 store。
 * done/error 时停止；查询本身抛错记为失败。
 */
function startPolling(set: (partial: Partial<UpdateDownloadState>) => void) {
  stopPolling()
  pollTimer = setInterval(async () => {
    try {
      const p = await queryProgress()
      if (p.phase === 'done') {
        stopPolling()
        set({
          phase: 'done',
          filePath: p.filePath ?? null,
          received: p.received,
          total: p.total || null,
          visible: true,
        })
      } else if (p.phase === 'error') {
        stopPolling()
        set({ phase: 'error', error: p.error || '下载失败，请稍后重试', visible: true })
      } else if (p.phase === 'idle') {
        // 任务被取消/重置：不再继续轮询
        stopPolling()
      } else {
        set({ received: p.received, total: p.total || null })
      }
    } catch (err) {
      stopPolling()
      set({
        phase: 'error',
        error: err instanceof Error && err.message ? err.message : '下载失败，请稍后重试',
        visible: true,
      })
    }
  }, POLL_INTERVAL_MS)
}

/**
 * 移动端下载：多源降级（GitHub 官方 → 加速前缀）由原生侧按序尝试，
 * 这里只负责发起 + 轮询进度。
 */
async function startMobileDownload(
  task: UpdateTask,
  set: (partial: Partial<UpdateDownloadState>) => void
) {
  try {
    await downloadApk(task.url, task.version, task.altUrls)
    // 用户在异步间隙取消了任务：撤销这次下载
    if (useUpdateDownloadStore.getState().phase !== 'downloading') {
      cancelMobileDownload()
      return
    }
    startPolling(set)
  } catch (err) {
    if (useUpdateDownloadStore.getState().phase === 'downloading') {
      set({
        phase: 'error',
        error: err instanceof Error && err.message ? err.message : '下载失败，请稍后重试',
        visible: true,
      })
    }
  }
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
    if (get().phase === 'downloading') return // 已有任务在跑
    teardownEvents()
    set({ phase: 'downloading', task, received: 0, total: null, filePath: null, error: null, visible: true })

    if (isDesktop()) {
      setupEvents((partial) => set(partial))
      ;(window as any).electronAPI.updater
        .download(task.url, task.kind, task.altUrls ?? [])
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
      return
    }

    // Android：系统 DownloadManager 下载 + 轮询进度（多源降级在 JS 侧按序重试）
    if (isMobile()) {
      startMobileDownload(task, (partial) => set(partial))
    }
  },

  cancel: () => {
    if (isDesktop()) {
      const api = (window as any).electronAPI?.updater
      api?.cancel?.().catch(() => {})
    } else {
      // 移动端：停轮询并让原生下载线程取消任务、清理残留文件
      stopPolling()
      cancelMobileDownload()
    }
    teardownEvents()
    set({ phase: 'idle', task: null, received: 0, total: null, filePath: null, error: null, visible: false })
  },

  reset: () => {
    teardownEvents()
    if (!isDesktop()) stopPolling()
    set({ phase: 'idle', task: null, received: 0, total: null, filePath: null, error: null, visible: false })
  },

  show: () => {
    if (get().phase !== 'idle') set({ visible: true })
  },

  hide: () => set({ visible: false }),
}))

/**
 * 是否支持内置下载：
 * - 桌面端：Electron preload 暴露了 updater 能力；
 * - Android：原生 Update 插件已注册（DownloadManager 下载 + FileProvider 安装）。
 */
export function isInAppUpdateAvailable(): boolean {
  if (isDesktop()) return !!(window as any).electronAPI?.updater
  if (isMobile()) return isMobileUpdaterAvailable()
  return false
}

/** 便捷入口：发起内置下载；不支持时返回 false，调用方自行回退浏览器下载 */
export function startInAppDownload(task: UpdateTask): boolean {
  if (!isInAppUpdateAvailable()) return false
  useUpdateDownloadStore.getState().start(task)
  return true
}

import { create } from 'zustand'
import { toErrorInfo, type ErrorInfo } from '@aurora/shared'
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
 *
 * 错误约定：`error` 存**结构化载荷**（码 + 参数 + detail），不存已渲染的句子。
 * 三条来源（主进程事件通道的 message、原生插件的 error 文本、JS 异常）统一经
 * `toErrorInfo()` 归一，渲染层用 `translateError(error, t)` 按当前语言出文案。
 * 这样英文界面上不会冒出中文错误，中文界面也不会冒出英文栈。
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
  /** release API 给出的安装包字节数：主进程用它兜底校验下载完整性 */
  size?: number | null
  /** release API 给出的 sha256 摘要（`sha256:<hex>`）：主进程下载完成后校验内容 */
  digest?: string | null
}

interface UpdateDownloadState {
  phase: UpdatePhase
  task: UpdateTask | null
  received: number
  total: number | null
  /** 实时速度（字节/秒），主进程未提供时为 null */
  speed: number | null
  /** 下载线路说明（如「系统代理 127.0.0.1:7897」/「直连」），仅桌面端会推送 */
  route: string | null
  /** 下载完成后的安装包路径（done 阶段） */
  filePath: string | null
  /** error 阶段的原因：结构化载荷，渲染期走 translateError(error, t) */
  error: ErrorInfo | null
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

/**
 * 归一一条失败原因：任何来源都收敛成结构化载荷。
 *
 * 三条来源各自的样子不同，这里做唯一一次收口：
 * - 主进程事件通道回传的多是技术原文（`HTTP 502`、校验失败原因）；
 * - Android 原生插件回传中文短句（`已取消`）——那是**状态**不是文案，
 *   必须在这里认出来换成码，否则英文界面上会直接出现中文；
 * - JS 异常（fetch/AuroraError）走 shared 的 `toErrorInfo` 已经是结构化载荷。
 *
 * 导出是为了可单测：它把三条异构来源收敛成一套码，是整个更新链路
 * 「不把抛出点的语言烧到界面上」的收口点。
 */
export function normalizeFailure(err: unknown): ErrorInfo {
  if (err === null || err === undefined) return { code: 'update.error.downloadFailed' }
  const raw = err instanceof Error ? err.message : String(err)
  if (!raw.trim()) return { code: 'update.error.downloadFailed' }

  // 取消：用户主动中止不是故障，给专属码而不是「下载失败」
  if (!/AURORA_ERR:/.test(raw) && /取消|cancel/i.test(raw)) return { code: 'update.error.canceled' }

  // 主进程把 HTTP 状态码当原因回传（`HTTP 403`）：shared 的 NATIVE_PATTERNS 只认
  // fetch 抛出的英文网络异常，认不出裸状态码字符串，这里补一条，让它是「网络不可达」
  // 而不是泛泛的「下载失败」，状态码留在 detail 里。
  const httpMatch = /^HTTP \d{3}$/.exec(raw.trim())
  if (httpMatch) {
    const code = Number(raw.trim().slice(5))
    if (code === 408 || code === 504) return { code: 'errors.network.timeout', detail: raw.trim() }
    if (code >= 500 || code === 403 || code === 429) {
      return { code: 'errors.network.unreachable', detail: raw.trim() }
    }
  }

  const info = toErrorInfo(err)
  // 未识别的裸文本会落到 errors.raw（模板 `{message}`）把原文透出上屏；
  // 更新链路一律兜底成「下载失败」，原文留在 detail 里供诊断。
  if (info.code === 'errors.raw') {
    return { code: 'update.error.downloadFailed', detail: info.detail ?? raw }
  }
  return info
}

/** 订阅主进程下载事件（重复订阅前先清理，保证只有一套监听） */
function setupEvents(set: (partial: Partial<UpdateDownloadState>) => void) {
  const api = (window as any).electronAPI?.updater
  if (!api) return
  eventCleanups = [
    api.onProgress((p: { received: number; total: number | null; speed?: number | null }) => {
      set({ received: p.received, total: p.total, speed: p.speed ?? null })
    }),
    api.onRoute?.((p: { label: string }) => set({ route: p.label })) ?? (() => {}),
    api.onDone((p: { filePath: string }) => {
      // 完成时重新弹出详情框，即使用户下载中收起了它
      set({ phase: 'done', filePath: p.filePath, visible: true })
    }),
    api.onError((message: string) => {
      // 主进程回传的是技术原文（HTTP 状态、校验失败原因等），交给归一函数识别；
      // 认不出来的一律兜底成「下载失败」并把原文留在 detail 里
      set({ phase: 'error', error: normalizeFailure(message), visible: true })
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
        set({ phase: 'error', error: normalizeFailure(p.error), visible: true })
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
        error: normalizeFailure(err),
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
        error: normalizeFailure(err),
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
  speed: null,
  route: null,
  filePath: null,
  error: null,
  visible: false,

  start: (task) => {
    if (get().phase === 'downloading') return // 已有任务在跑
    teardownEvents()
    set({
      phase: 'downloading',
      task,
      received: 0,
      total: null,
      speed: null,
      route: null,
      filePath: null,
      error: null,
      visible: true,
    })

    if (isDesktop()) {
      setupEvents((partial) => set(partial))
      ;(window as any).electronAPI.updater
        .download(task.url, task.kind, task.altUrls ?? [], task.size ?? null, task.digest ?? null)
        .catch((err: unknown) => {
          // 正常失败已由 onError 事件落到 error 状态；
          // 这里只兜底「事件通道缺失」或取消后 invoke 拒绝的情况
          if (get().phase === 'downloading') {
            set({
              phase: 'error',
              error: normalizeFailure(err),
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
    set({
      phase: 'idle',
      task: null,
      received: 0,
      total: null,
      speed: null,
      route: null,
      filePath: null,
      error: null,
      visible: false,
    })
  },

  reset: () => {
    teardownEvents()
    if (!isDesktop()) stopPolling()
    set({
      phase: 'idle',
      task: null,
      received: 0,
      total: null,
      speed: null,
      route: null,
      filePath: null,
      error: null,
      visible: false,
    })
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

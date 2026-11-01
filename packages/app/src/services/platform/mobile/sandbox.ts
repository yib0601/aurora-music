/**
 * 移动端洛雪脚本沙箱：主线程侧的 Worker 驱动器。
 *
 * ## 解决的唯一问题
 *
 * 移动端没有 `node:vm`，`lxHost` 原本回落 `new Function` —— 第三方脚本里的
 * `while(true){}` 会**永久冻结 WebView 主线程**（界面卡死、连停止按钮都点不到）。
 * Web 平台唯一能打断同步代码的是 `Worker.terminate()`，它从外部强制结束线程。
 *
 * ## 为什么另起一套实现而不是给 `lxHost` 注入 evaluate
 *
 * `LxHostDeps.evaluate` 的契约是**同步返回**（`vm.runInContext` 语义），而 Worker
 * 是异步的。更根本的原因是请求通道：Worker 里的 `fetch` 受 CORS 约束，移动端必须用
 * 主线程的 `CapacitorHttp`；而脚本与截图宿主的对象身份（`globalThis.liscript` 这类
 * 写回、宿主读回）无法跨线程共享。
 *
 * 所以这里做的是**完整替代**：Worker 内既跑脚本也持有宿主，主线程只负责
 * 启动 / 超时终止 / 代发请求 / 收结果。`lxHost` 的 `evaluate` 保持不动
 * （桌面端仍走 `node:vm`）。
 *
 * ## 一处必须守住的语义：超时**一定**终止
 *
 * 这是本模块存在的全部理由，所以任何路径都必须落到 `terminate()`：
 * 正常完成、超时、脚本抛错、调用方取消 —— 全部 terminate。
 * 不 terminate 的 Worker 会带着一个可能在死循环的脚本永远转下去。
 */

/**
 * Worker 源码。
 *
 * `?raw` 由 Vite 处理（把文件内容读成字符串）。`lxSandbox.worker.js` 是**纯 JS**
 * 而不是 TS：它要用 `Function.apply` 构造遮蔽参数，且 Worker 是经典脚本环境，
 * 走 TS 编译链只会让"到底运行了什么"更难核对。
 */
import workerSource from './lxSandbox.worker.js?raw'

/** 默认脚本执行预算：与桌面端 `scriptTimeoutMs` 同量级 */
const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000
/** 单次取结果预算：与桌面端 `callTimeoutMs` 同量级 */
const DEFAULT_CALL_TIMEOUT_MS = 20_000

/** Worker 里的请求经主线程代发（CapacitorHttp，不受 CORS 约束） */
export type SandboxRequestFn = (
  url: string,
  options: Record<string, unknown>,
  callback: (err: unknown, resp: Record<string, unknown> | null) => void
) => void

/** 探测结果（与 shared 的 `LxSourceInspection` 结构兼容） */
export interface SandboxInspection {
  ok: boolean
  error?: string
  platforms: Record<string, { name?: string; actions: string[]; qualitys: string[] }>
  packed?: boolean
}

/** 一次沙箱会话：跑一个脚本，可发多次 call，用完必须 dispose */
export interface SandboxSession {
  inspection: SandboxInspection
  call(source: string, action: string, info: Record<string, unknown>): Promise<unknown>
  /** 终止 Worker（幂等）。任何路径都必须调用它 */
  dispose(): void
}

/** 建 Worker（Blob URL；用完 revoke 避免泄漏） */
function createWorker(): { worker: Worker; revoke: () => void } {
  const blob = new Blob([workerSource], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  const worker = new Worker(url)
  return {
    worker,
    revoke: () => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // 已 revoke 过：无害
      }
    },
  }
}

/**
 * 启动一个沙箱会话。
 *
 * `request` 由调用方注入主线程的请求实现（移动端是 `CapacitorHttp` 包装）。
 * 不在这里直接 import `nativeFetch`：那会让本模块在单测里拖进一整套 Capacitor 依赖。
 *
 * 失败语义：脚本超时 / 抛错时**不抛异常**，而是返回 `inspection.ok = false` +
 * 可读原因。调用方（探测 / 取址）据此给出"这条源不可用"，而不是让上层看到
 * 一个看不懂的 Worker 错误。
 */
export async function openSandbox(options: {
  script: string
  request: SandboxRequestFn
  scriptTimeoutMs?: number
  callTimeoutMs?: number
}): Promise<SandboxSession> {
  const scriptTimeout = options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS
  const callTimeout = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS

  const { worker, revoke } = createWorker()
  let disposed = false
  /** 待回应的请求 id → resolve */
  const pending = new Map<number, (value: { ok: boolean; value?: unknown; message?: string }) => void>()
  let nextCallId = 1
  const pendingCalls = new Map<number, (value: { ok: boolean; value?: unknown; message?: string }) => void>()

  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      worker.terminate()
    } catch {
      // 已经终止：无害
    }
    revoke()
    // 把还在等的调用全部落地，避免调用方永久挂起
    for (const resolve of pendingCalls.values()) {
      resolve({ ok: false, message: 'sandbox disposed' })
    }
    pendingCalls.clear()
    pending.clear()
  }

  // ─── 收 Worker 消息 ───
  let resolveInited: (inspection: SandboxInspection) => void = () => {}
  const initedPromise = new Promise<SandboxInspection>((resolve) => {
    resolveInited = resolve
  })

  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as { type?: string } & Record<string, unknown>
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'inited') {
      resolveInited(msg.inspection as SandboxInspection)
      return
    }

    if (msg.type === 'request') {
      // 脚本请求 → 主线程代发（CapacitorHttp）
      const id = Number(msg.id)
      options.request(
        String(msg.url),
        (msg.options || {}) as Record<string, unknown>,
        (err, resp) => {
          if (disposed) return
          worker.postMessage({ type: 'response', id, err: err ? String(err) : null, resp })
        }
      )
      return
    }

    if (msg.type === 'callResult') {
      const resolve = pendingCalls.get(Number(msg.id))
      if (resolve) {
        pendingCalls.delete(Number(msg.id))
        resolve({
          ok: Boolean(msg.ok),
          value: msg.value,
          message: typeof msg.message === 'string' ? msg.message : undefined,
        })
      }
    }
  }

  worker.onerror = (event: ErrorEvent) => {
    // Worker 内未捕获的异常：明确收场，不让调用方挂起
    resolveInited({
      ok: false,
      error: event.message || 'sandbox worker error',
      platforms: {},
    })
    dispose()
  }

  // ─── 启动脚本 ───
  worker.postMessage({ type: 'run', script: options.script })

  // 脚本预算：到点**强制终止**（这是整个模块存在的理由）
  const scriptTimer = setTimeout(() => {
    resolveInited({
      ok: false,
      error: `script timed out after ${scriptTimeout}ms`,
      platforms: {},
    })
    // 超时即销毁：Worker 可能正卡在死循环里，留着只会持续占 CPU
    dispose()
  }, scriptTimeout)

  const inspection = await initedPromise
  clearTimeout(scriptTimer)

  // 脚本失败或已 super 时直接返回终态（Worker 已 terminate）
  if (!inspection.ok || disposed) {
    dispose()
    return {
      inspection,
      call: async () => {
        throw new Error(inspection.error || 'sandbox unavailable')
      },
      dispose,
    }
  }

  return {
    inspection,
    dispose,
    call: async (source, action, info) => {
      if (disposed) throw new Error('sandbox disposed')
      const id = nextCallId++
      const resultPromise = new Promise<{ ok: boolean; value?: unknown; message?: string }>((resolve) => {
        pendingCalls.set(id, resolve)
      })
      worker.postMessage({ type: 'call', id, source, action, info })

      // 调用预算：到点 terminate（脚本回调可能永不 settle）
      const timer = setTimeout(() => {
        const resolve = pendingCalls.get(id)
        if (resolve) {
          pendingCalls.delete(id)
          resolve({ ok: false, message: `call timed out after ${callTimeout}ms` })
        }
        dispose()
      }, callTimeout)

      const result = await resultPromise
      clearTimeout(timer)
      if (!result.ok) throw new Error(result.message || 'sandbox call failed')
      return result.value
    },
  }
}

/** 某运行环境是否具备 Worker（移动端 WebView 与浏览器都有；Node 单测环境没有） */
export function sandboxSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof Blob !== 'undefined'
}

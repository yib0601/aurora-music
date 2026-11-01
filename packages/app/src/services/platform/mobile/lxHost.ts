import {
  HOST_CAPABILITY_VERSION,
  toLxMusicInfo,
  auroraError,
  fetchLxScript as sharedFetchLxScript,
  inspectLxSource as sharedInspectLxSource,
  registerHostCapability,
  resolveLxSourceUrl as sharedResolveLxSourceUrl,
  searchLxSource as sharedSearchLxSource,
  setLxHostDeps,
  setLxScriptProvider,
} from '@aurora/shared'
import { appTranslate } from '@/i18n'
import type {
  DownloadQuality,
  LxHostDeps,
  LxRequestFn,
  LxRequestOptions,
  LxScriptSource,
  LxSearchResult,
  LxSourceInspection,
  LxTrackRef,
} from '@aurora/shared'
import { createNativeFetch } from './nativeFetch'
import { openSandbox, sandboxSupported, type SandboxRequestFn } from './sandbox'

/**
 * 移动端洛雪脚本宿主适配层。
 *
 * 与桌面端的差别只在「宿主依赖怎么来」：
 * - 桌面端宿主依赖含函数，只能放在主进程装配，渲染层经 IPC 转发（见 desktop/src/ipc/lxSource.ts）；
 * - 移动端渲染层本身就是执行侧，直接调 @aurora/shared，依赖用原生 HTTP 包装成洛雪回调式。
 *
 * 宿主依赖里含函数，无法跨进程传递，因此必须在这里注册一次（setLxHostDeps）。
 */

/** 移动端没有 Node 的 crypto / zlib：只注入能纯 Web 实现的 buffer，
 *  用到签名或解压的脚本在手机端会按「工具不可用」降级失败（不影响常规取址脚本） */
function createWebUtils(): LxHostDeps['utils'] {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  return {
    buffer: {
      // 签名函数体保持与 LxHostDeps 声明一致（多传参数不影响实现）；
      // 参数名加下划线前缀表明「此处刻意不使用」，避免被读成漏用参数
      from: (..._args: unknown[]) => {
        const [input] = _args
        if (typeof input === 'string') return encoder.encode(input)
        if (input instanceof Uint8Array) return input
        if (input instanceof ArrayBuffer) return new Uint8Array(input)
        if (Array.isArray(input)) return new Uint8Array(input as number[])
        return new Uint8Array(0)
      },
      bufToString: (buf: unknown) => decoder.decode((buf as Uint8Array) || undefined),
    },
  }
}

/** 把原生 HTTP fetch 包装成洛雪宿主的回调式请求实现 */
export function createMobileLxRequest(): LxRequestFn {
  const nativeFetch = createNativeFetch()
  return (url, options, callback) => {
    const opts: LxRequestOptions = options || {}
    const controller = new AbortController()
    const timeout = Math.min(Number(opts.response_timeout ?? opts.timeout ?? 60000) || 60000, 60000)
    const timer = setTimeout(() => controller.abort(), timeout)
    let settled = false
    const finish = (err: unknown, resp: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(err, resp as never)
    }

    void (async () => {
      try {
        const method = String(opts.method || 'GET').toUpperCase()
        const headers: Record<string, string> = { ...(opts.headers || {}) }
        let body: string | undefined
        if (opts.body !== undefined && opts.body !== null && method !== 'GET' && method !== 'HEAD') {
          body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
          if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json'
          }
        }
        const resp = await nativeFetch(url, { method, headers, body, signal: controller.signal })
        const raw = await resp.text()
        let parsed: unknown = raw
        try {
          parsed = JSON.parse(raw)
        } catch {
          /* 非 JSON 响应：body 原样给文本 */
        }
        const outHeaders: Record<string, string> = {}
        resp.headers.forEach((v, k) => {
          outHeaders[k] = v
        })
        finish(null, {
          statusCode: resp.status,
          statusMessage: resp.statusText,
          headers: outHeaders,
          bytes: raw.length,
          raw,
          body: parsed,
        })
      } catch (err) {
        // 底层异常原样透出（脚本宿主据此判错），仅在无 message 时给当前语言的兜底文案
        finish((err as Error)?.message || appTranslate()('errors.network.unreachable'), null)
      }
    })()

    return () => {
      clearTimeout(timer)
      try {
        controller.abort()
      } catch {
        /* 已结束的请求再 abort 无害 */
      }
    }
  }
}

let installed = false

/** 脚本源码缓存：键为「音源 id + 脚本地址」，与桌面端主进程同一套语义 */
const scriptCache = new Map<string, Promise<string>>()

/**
 * 取脚本源码：配置自带 script 直接用；否则按 sourceUrl 现拉并缓存。
 * 失败不留在缓存里，下一次调用是重试而不是复用上次的失败。
 */
async function ensureScript(source: LxScriptSource): Promise<string> {
  const inline = typeof source.script === 'string' ? source.script.trim() : ''
  if (inline) return String(source.script)
  if (!source.sourceUrl) throw auroraError('runtime.error.scriptSourceUrlMissing')
  const key = `${source.id}|${source.sourceUrl}`
  let pending = scriptCache.get(key)
  if (!pending) {
    pending = sharedFetchLxScript(source.sourceUrl)
    scriptCache.set(key, pending)
    pending.catch(() => {
      if (scriptCache.get(key) === pending) scriptCache.delete(key)
    })
  }
  return await pending
}

/** 注册移动端宿主依赖（幂等；移动端只在原生容器里才有意义） */
export function installMobileLxHost(): void {
  if (installed) return
  installed = true
  const deps: LxHostDeps = {
    request: createMobileLxRequest(),
    env: 'mobile',
    version: '2.0.0',
    callTimeoutMs: 20000,
    // 移动端无 node:vm：不注入 evaluate，宿主回落到 new Function（无同步超时中断能力）
    // scriptTimeoutMs 也随之无效（它只在注入 evaluate 时生效），故不传
    utils: createWebUtils(),
  }
  setLxHostDeps(deps)

  // 登记成宿主能力。移动端的 `script.host` 有**两个实现**：
  //   - 这份 `deps`（`new Function` 回退，同步死循环打不断）
  //   - `sandbox.ts` 的 Worker 沙箱（`terminate()` 能强制结束）
  //
  // 这里注册的是**基础档**：它保证「有脚本宿主可用」，而"能否打断死循环"属于
  // 更强的运行时特性，由 `sandboxSupported()` 在需要时探测（见 `lxHost` 尾部的
  // Worker 沙箱路径）。注册表表达"能力有无"，具体实现档位由实现自己回答 ——
  // 把它们揉进同一份能力语义会让判定变成"有时可打断、有时不可"的隐式状态。
  registerHostCapability('script.host', HOST_CAPABILITY_VERSION['script.host'], deps)

  setLxScriptProvider(async (source) => {
    try {
      return await ensureScript(source as LxScriptSource)
    } catch (err) {
      console.warn('[Lx] 脚本拉取失败:', source.id, err)
      return null
    }
  })
}

export async function fetchLxScript(url: string): Promise<string> {
  installMobileLxHost()
  return await sharedFetchLxScript(url)
}

export async function inspectLxSource(source: LxScriptSource): Promise<LxSourceInspection> {
  installMobileLxHost()
  return await sharedInspectLxSource(source)
}

export async function searchLxSource(
  source: LxScriptSource,
  query: string,
  options?: { limit?: number }
): Promise<LxSearchResult[]> {
  installMobileLxHost()
  return await sharedSearchLxSource(source, query, undefined, options)
}

export async function resolveLxSourceUrl(
  source: LxScriptSource,
  ref: LxTrackRef,
  quality: DownloadQuality
): Promise<{ url: string; quality: string }> {
  installMobileLxHost()
  return await sharedResolveLxSourceUrl(source, ref, quality)
}

// ─── Worker 沙箱执行路径 ──────────────────────────────────────────
//
// 上面注册的 `setLxHostDeps` 走的是 `lxHost` 的 `new Function` 回退路径 ——
// 那条路上第三方脚本的同步死循环会**永久冻结 WebView**。
//
// 本文件末尾这组函数提供**另一条**路径：脚本在 Web Worker 里跑，超时用
// `terminate()` 强制终止。它不复用 `lxHost` 的 evaluate 契约（那个是同步语义，
// Worker 是异步的），而是完整替代：Worker 内既跑脚本也持宿主，主线程只负责
// 启动 / 超时终止 / 代发请求 / 收结果。详见 `sandbox.ts` 顶部说明。

/**
 * 把 `LxRequestFn`（洛雪回调式）适配成沙箱要求的形状。
 *
 * 两者语义相同（成功回调 `(null, resp)`，失败回调 `(err, null)`），
 * 差别只是 resp 的类型收窄 —— 沙箱侧要纯数据（能过 structured clone）。
 */
function sandboxRequest(): SandboxRequestFn {
  const base = createMobileLxRequest()
  return (url, options, callback) => {
    base(url, options as LxRequestOptions, (err, resp) => {
      // resp 里的 body 可能含函数（脚本自己塞的），structured clone 会抛；
      // 这里只透传纯数据字段，body 若不是可序列化值则降级为 raw
      callback(err, resp ? (sanitizeForClone(resp) as Record<string, unknown>) : null)
    })
  }
}

/** 把值裁成**可 structured clone** 的纯数据；不可序列化的部分降级为原始文本 */
function sanitizeForClone(value: unknown): unknown {
  try {
    // 试一次克隆：能过就直接用（绝大多数响应体是纯 JSON）
    structuredClone(value)
    return value
  } catch {
    // 含函数或循环引用：只留最关键的纯数据字段
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of ['statusCode', 'statusMessage', 'headers', 'bytes', 'raw']) {
        const item = record[key]
        if (item === undefined) continue
        try {
          structuredClone(item)
          out[key] = item
        } catch {
          /* 该字段不可序列化：丢弃 */
        }
      }
      return out
    }
    return String(value)
  }
}

/** 探测一条脚本（Worker 沙箱路径；不支持时返回 null 让调用方回落 lxHost） */
export async function inspectLxSourceInSandbox(
  source: LxScriptSource
): Promise<LxSourceInspection | null> {
  if (!sandboxSupported()) return null
  const script = await ensureScript(source)
  const session = await openSandbox({ script, request: sandboxRequest() })
  try {
    return {
      ok: session.inspection.ok,
      ...(session.inspection.error ? { error: session.inspection.error } : {}),
      platforms: session.inspection.platforms as LxSourceInspection['platforms'],
    }
  } finally {
    // 任何路径都必须 terminate：Worker 可能正卡在死循环
    session.dispose()
  }
}

/**
 * 取址（Worker 沙箱路径；不支持时返回 null 让调用方回落 lxHost）。
 *
 * 每次取址新建一个 Worker：Worker 一旦 terminate 就丢了脚本状态，
 * 而"一定会被打断"比"省一次 boot"重要得多（见 sandbox.ts 的已知局限 1）。
 */
export async function resolveLxSourceUrlInSandbox(
  source: LxScriptSource,
  ref: LxTrackRef,
  quality: DownloadQuality
): Promise<{ url: string; quality: string } | null> {
  if (!sandboxSupported()) return null
  const script = await ensureScript(source)
  const session = await openSandbox({ script, request: sandboxRequest() })
  try {
    if (!session.inspection.ok) return null
    // 交给脚本的 info 与桌面端同源（toLxMusicInfo 负责字段映射）
    const info = toLxMusicInfoSafe(ref.platform, ref.meta)
    const value = await session.call(ref.platform, 'musicUrl', {
      type: quality,
      musicInfo: { musicInfos: { [ref.platform]: info } },
    })
    // 脚本可能返回字符串，也可能返回 { url }
    const url =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string'
          ? String((value as { url: string }).url)
          : ''
    if (!url || !/^https?:\/\//i.test(url)) return null
    return { url, quality: String(quality) }
  } catch (err) {
    console.warn('[Lx][sandbox] 取址失败:', err)
    return null
  } finally {
    session.dispose()
  }
}

/** `toLxMusicInfo` 的容错包装：映射失败时给空对象（脚本会按自己的规则降级） */
function toLxMusicInfoSafe(platform: string, meta: Record<string, unknown> | null | undefined) {
  try {
    return toLxMusicInfo(platform, meta)
  } catch {
    return {}
  }
}

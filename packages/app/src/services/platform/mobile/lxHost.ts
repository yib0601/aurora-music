import {
  auroraError,
  fetchLxScript as sharedFetchLxScript,
  inspectLxSource as sharedInspectLxSource,
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
  setLxHostDeps({
    request: createMobileLxRequest(),
    env: 'mobile',
    version: '2.0.0',
    callTimeoutMs: 20000,
    // 移动端无 node:vm：不注入 evaluate，宿主回落到 new Function（无同步超时中断能力）
    // scriptTimeoutMs 也随之无效（它只在注入 evaluate 时生效），故不传
    utils: createWebUtils(),
  })
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
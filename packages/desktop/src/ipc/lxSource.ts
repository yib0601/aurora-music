/**
 * 洛雪音源（kind='lx'）在主进程的执行入口。
 *
 * 为什么必须在主进程做：
 * - 脚本宿主（@aurora/shared/lxHost）的依赖里含函数（request / utils），函数无法经
 *   IPC 序列化，宿主只能在「发起调用的那一侧」装配；渲染层那侧是 preload + ipcRenderer，
 *   只有主进程能拿到 Node 网络栈与真实 crypto / zlib；
 * - 渲染进程直连上游（酷我 / 第三方公共 API）会被 CORS 拦（在线搜索同理走主进程）；
 * - 部分脚本要做 md5 / aes / rsa 签名或 zlib 解压，这些只有 Node 侧才有同步实现。
 *
 * 本文件只做四件事：装配 Node 版宿主依赖、缓存脚本源码、注册 IPC、把错误转成可读中文。
 * 业务语义（搜索聚合、取址编排）在 @aurora/shared，不在这里。
 */

import { ipcMain } from 'electron'
import vm from 'node:vm'
import { createHash, createCipheriv, publicEncrypt, randomBytes as nodeRandomBytes, constants as nodeCryptoConstants } from 'crypto'
import { deflate as zlibDeflate, inflate as zlibInflate } from 'zlib'
import {
  clearLxSourceCache,
  fetchLxScript,
  inspectLxSource,
  isUsableLxMeta,
  resolveLxSourceUrl,
  searchLxSource,
  setLxHostDeps,
  setLxScriptProvider,
  toLxMusicInfo,
} from '@aurora/shared'
import type {
  DownloadQuality,
  LxHostDeps,
  LxRequestFn,
  LxRequestOptions,
  LxResponse,
  LxSearchResult,
  LxScriptSource,
  LxSourceInspection,
  LxTrackRef,
  OnlineSourceConfig,
} from '@aurora/shared'

/** 单次请求超时上限：脚本给的 timeout 可能很大，统一压到 60s 内，避免主进程挂住 */
const MAX_REQUEST_TIMEOUT = 60000
const DEFAULT_REQUEST_TIMEOUT = 60000
/** 脚本源码拉取超时（用户点「测试 / 保存」时不能等太久） */
const SCRIPT_FETCH_TIMEOUT = 20000
/** 脚本单次初始化（含 Liscript 解包）的执行上限：脚本可能有同步死循环 */
const SCRIPT_EVAL_TIMEOUT = 10000
/**
 * 单次向脚本取结果（musicUrl / search）的超时。
 * 搜索是并发聚合，一条坏脚本的上游回退链能连着打好几跳；
 * 不设上限就会把整轮搜索拖成「一直在转」，故收紧到 20s。
 */
const SCRIPT_CALL_TIMEOUT = 20000

// ─── node:vm 版脚本执行器 ─────────────────────────────────────────

/**
 * node:vm 版脚本执行器。
 *
 * 为什么必须注入：宿主默认的 `new Function` 里，**同步死循环无法被打断**——
 * pdone 的 lx/latest.js 实测把整轮加载卡死（宿主已遮蔽 process/require 等
 * Node 标识挡住这一个分支，但同类脚本无法穷举）。runInContext 的 timeout
 * 能中断同步死循环，主进程不会被第三方脚本拖住。
 *
 * 契约（与 LxHostDeps.evaluate 的注释一致，见 shared/src/lxHost.ts）：
 * - `script` 是**函数体**（含 "use strict" 与 return），这里包成函数再跑；
 * - `sandbox` 是**已自洽的全局对象**：伪全局（lx / liscript）与宿主全局都平铺在键上，
 *   `globalThis` / `window` / `self` 已由宿主指向它自身。
 *   **执行器不得再对 sandbox 做加工**——早期实现为了「补构造器 / 置空 Node 标识」
 *   浅拷贝了一层，并把 globalThis 指向副本，结果 vm 里 `globalThis.lx` 取不到，
 *   脚本第一行解构 `globalThis.lx` 就抛「Cannot read properties of undefined」。
 *   遮蔽与补齐都是宿主的职责，这里只负责建上下文与超时。
 */
export function createVmEvaluator(): (script: string, sandbox: Record<string, unknown>, timeoutMs: number) => unknown {
  return (script, sandbox, timeoutMs) => {
    const context = vm.createContext(sandbox, {
      name: 'lx-source',
      codeGeneration: { strings: true, wasm: false },
    })
    return vm.runInContext(`(function(){\n${script}\n})()`, context, {
      timeout: timeoutMs || SCRIPT_EVAL_TIMEOUT,
      filename: 'lx-source.js',
    })
  }
}

// ─── Node 版宿主请求实现 ──────────────────────────────────────────

/** 归一化超时：响应超时优先，其次总超时，再兜默认值；一律不超过上限 */
function pickTimeout(options: LxRequestOptions): number {
  const raw = Number(options.response_timeout ?? options.timeout ?? DEFAULT_REQUEST_TIMEOUT)
  const ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT
  return Math.min(ms, MAX_REQUEST_TIMEOUT)
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === lower)
}

/** 把脚本给的 body / form / formData 归一成 fetch 能直接用的请求体 */
function buildRequestBody(
  options: LxRequestOptions,
  headers: Record<string, string>
): string | Uint8Array | undefined {
  const { body, form, formData } = options
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') return body
    if (body instanceof Uint8Array) return body
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json'
    return JSON.stringify(body)
  }
  const urlencoded = formData ?? form
  if (urlencoded !== undefined && urlencoded !== null) {
    const params = new URLSearchParams()
    if (urlencoded instanceof URLSearchParams) {
      for (const [k, v] of urlencoded) params.append(k, String(v))
    } else if (typeof urlencoded === 'object') {
      for (const [k, v] of Object.entries(urlencoded as Record<string, unknown>)) params.append(k, String(v))
    }
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    return params.toString()
  }
  return undefined
}

/**
 * 洛雪宿主请求协议的 Node 实现。
 *
 * 回调形态严格按契约：callback(err, resp, body)
 * - resp.raw 是原始文本，resp.body 能 JSON.parse 就解析、否则是文本；
 * - resp.bytes 是文本按 UTF-8 编码的字节数（与洛雪宿主一致：脚本据此判断响应体积）；
 * - 失败时只回调 err，不回调 resp（避免脚本拿到半截响应继续解析）。
 */
export function createNodeLxRequest(): LxRequestFn {
  return (url, options, callback) => {
    const opts = options || {}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), pickTimeout(opts))
    let settled = false

    const finish = (err: unknown, resp: LxResponse | null, body?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(err, resp, body)
    }

    void (async () => {
      try {
        const method = String(opts.method || 'GET').toUpperCase()
        const headers: Record<string, string> = { ...(opts.headers || {}) }
        // 上游多为音频接口，缺省补一个常规 UA，避免被当成空 UA 的脚本请求拒掉
        if (!hasHeader(headers, 'user-agent')) {
          headers['User-Agent'] =
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        const payload = method === 'GET' || method === 'HEAD' ? undefined : buildRequestBody(opts, headers)

        const resp = await fetch(url, {
          method,
          headers,
          // 主进程 tsconfig 的 lib 只含 ES2020（无 DOM），BodyInit 不在作用域；
          // 这里按 fetch 实际接受的形态给一个最小显式类型
          body: payload as string | Uint8Array | undefined,
          signal: controller.signal,
          redirect: 'follow',
        })
        const text = await resp.text()
        const outHeaders: Record<string, string> = {}
        resp.headers.forEach((v, k) => {
          outHeaders[k] = v
        })
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          /* 非 JSON 响应（HTML / 纯文本 / 网关报错页）：body 原样给文本 */
        }
        finish(
          null,
          {
            statusCode: resp.status,
            statusMessage: resp.statusText,
            headers: outHeaders,
            bytes: Buffer.byteLength(text, 'utf8'),
            raw: text,
            body: parsed,
          },
          parsed
        )
      } catch (err) {
        const e = err as Error
        const message =
          e?.name === 'AbortError'
            ? `请求超时（${pickTimeout(opts)}ms）`
            : e?.message || '网络请求失败'
        finish(new Error(message), null)
      }
    })()

    // 取消函数：脚本提前放弃请求时用（超时由 timer 负责）
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

// ─── Node 版工具实现（crypto / zlib / buffer） ─────────────────────

function toBuffer(input: unknown): Buffer {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input)
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input))
  if (typeof input === 'string') return Buffer.from(input, 'utf8')
  if (Array.isArray(input)) return Buffer.from(input as number[])
  if (input && typeof input === 'object' && Array.isArray((input as any).data)) {
    return Buffer.from((input as any).data)
  }
  throw new Error('不支持的二进制入参')
}

/** Node 版 crypto：与洛雪桌面端 preload 暴露的接口对齐 */
export function createNodeLxUtils(): LxHostDeps['utils'] {
  return {
    crypto: {
      md5: (str: string) => createHash('md5').update(String(str), 'utf8').digest('hex'),
      randomBytes: (size: number) => nodeRandomBytes(Math.max(0, Math.floor(size) || 0)),
      aesEncrypt: (buffer: unknown, mode: string, key: unknown, iv: unknown) => {
        const algorithm = `aes-128-${String(mode || 'cbc').toLowerCase()}`
        // ecb 模式不需要 iv（传了 Node 会报错）
        const cipher = /ecb/i.test(algorithm)
          ? createCipheriv(algorithm, toBuffer(key), null)
          : createCipheriv(algorithm, toBuffer(key), toBuffer(iv))
        return Buffer.concat([cipher.update(toBuffer(buffer)), cipher.final()])
      },
      rsaEncrypt: (buffer: unknown, key: unknown) => {
        const keyInput = typeof key === 'string' ? key : toBuffer(key)
        return publicEncrypt(
          { key: keyInput as any, padding: nodeCryptoConstants.RSA_PKCS1_PADDING },
          toBuffer(buffer)
        )
      },
    },
    zlib: {
      inflate: (buf: unknown) =>
        new Promise((resolve, reject) => {
          zlibInflate(toBuffer(buf), (err, out) => (err ? reject(err) : resolve(out)))
        }),
      deflate: (data: unknown) =>
        new Promise((resolve, reject) => {
          zlibDeflate(toBuffer(data), (err, out) => (err ? reject(err) : resolve(out)))
        }),
    },
    buffer: {
      from: (...args: unknown[]) => {
        const [input, encoding] = args
        if (typeof input === 'string') return Buffer.from(input, (encoding as BufferEncoding) || 'utf8')
        return toBuffer(input)
      },
      bufToString: (buf: unknown, format: string) => toBuffer(buf).toString((format || 'utf8') as BufferEncoding),
    },
  }
}

/** 组装主进程版宿主依赖（模块加载时注册一次；脚本执行不再穿参） */
export function installLxHostDeps(): void {
  setLxHostDeps({
    request: createNodeLxRequest(),
    env: 'desktop',
    version: '2.0.0',
    // 单次取结果超时：搜索是并发聚合，坏脚本不能拖住整轮
    callTimeoutMs: SCRIPT_CALL_TIMEOUT,
    // 脚本首次执行（含 Liscript 自解压引导段）的超时：只有注入了 evaluate 才生效
    scriptTimeoutMs: SCRIPT_EVAL_TIMEOUT,
    // node:vm 执行器：同步死循环可被 timeout 打断（第三方脚本不可控）
    evaluate: createVmEvaluator(),
    utils: createNodeLxUtils(),
  })

  // 脚本源码供应器：聚合搜索 / 取址编排（shared/lxResolver）在需要执行脚本时按源配置来要源码。
  // 不注册的话，渲染层下传的源配置（只有 sourceUrl、没有 script）会被当成「拿不到脚本」而跳过，
  // 用户看到的是「配了源却搜不出歌」。这里复用 ensureScript：同一套按 id+sourceUrl 的缓存，
  // 以及「失败不缓存」的重试语义。
  setLxScriptProvider(async (source: OnlineSourceConfig) => {
    try {
      return await ensureScript(source as LxScriptSource)
    } catch (err) {
      console.warn('[Lx] 脚本拉取失败:', source.id, errText(err))
      return null
    }
  })
}

// ─── 脚本源码缓存 ─────────────────────────────────────────────────

/**
 * 脚本源码缓存：键为「音源 id + 脚本链接」。
 * 同一音源在一次会话里反复取址（每次播放都要取）不该反复下载脚本；
 * 改了脚本链接会得到新的键，不会用到旧内容。
 */
const scriptCache = new Map<string, Promise<string>>()

function scriptCacheKeyOf(source: LxScriptSource): string {
  return `${source.id}|${source.sourceUrl || ''}`
}

/**
 * 清空脚本源码缓存（用户要求强制刷新时用）。
 *
 * 只清「按 URL 拉来的源码」这一层，不动 shared 里的脚本实例缓存：
 * 后者的键是脚本内容的指纹，源码变了自然命中新键；顺手清掉会让别的源正在用的
 * 实例一起重建（用户只是想刷新一个源，代价不该扩散到全部）。需要整体重来时用 lx:clearCache。
 */
export function clearScriptCache(): void {
  scriptCache.clear()
  // lx:clearCache 是「整体重来」语义：旧脚本实例可能已按远程配置做过一次性初始化，
  // 只换源码不会重建它。（单源的 force 刷新走 clearScriptCacheOf，不牵连其它源正在用的实例。）
  clearLxSourceCache()
}

/** 清掉单个源的源码缓存（force 刷新时用，避免牵连其它源） */
function clearScriptCacheOf(source: LxScriptSource): void {
  scriptCache.delete(scriptCacheKeyOf(source))
}

/** 按脚本地址清缓存（设置页只拿到 url、还没有音源配置时的强制刷新路径） */
function clearScriptCacheByUrl(url: string): void {
  for (const key of [...scriptCache.keys()]) {
    if (key.endsWith(`|${url}`)) scriptCache.delete(key)
  }
}

/**
 * 取脚本源码：优先用配置里已填的 script（设置页保存时已拉取），否则按 sourceUrl 现拉并缓存。
 * 强制刷新由调用方先 clearScriptCacheOf 再调本函数（避免同一件事两处实现）。
 */
async function ensureScript(source: LxScriptSource): Promise<string> {
  const inline = typeof source.script === 'string' ? source.script.trim() : ''
  if (inline) return String(source.script)
  if (!source.sourceUrl) throw new Error('音源未填写脚本地址')
  const key = scriptCacheKeyOf(source)
  let pending = scriptCache.get(key)
  if (!pending) {
    pending = fetchLxScript(source.sourceUrl, SCRIPT_FETCH_TIMEOUT)
    scriptCache.set(key, pending)
    // 失败不留在缓存里：下一次调用应当是「重试」而不是「复用上次的失败」
    pending.catch(() => {
      if (scriptCache.get(key) === pending) scriptCache.delete(key)
    })
  }
  return await pending
}

// ─── IPC 注册 ─────────────────────────────────────────────────────

/** 入参校验：IPC 入参来自渲染层，全部按不可信处理 */
function isLxSource(value: unknown): value is LxScriptSource {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && v.id.length > 0 && typeof v.name === 'string'
}

function isLxTrackRef(value: unknown): value is LxTrackRef {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.sourceId === 'string' &&
    typeof v.platform === 'string' &&
    !!v.meta &&
    typeof v.meta === 'object'
  )
}

function errText(err: unknown): string {
  return (err as Error)?.message || String(err)
}

/**
 * 取址两路走：先原样、再映射。返回直链；两路都失败时抛出合并后的可读原因。
 *
 * 为什么要两路：条目可能来自脚本自带 search（meta 就是脚本自己的字段，原样回喂最稳），
 * 也可能来自 aurora 音源（字段是通用的 id/title/artist，而脚本读的是 hash/songmid 这类
 * 自己的名字，必须映射）。哪一路有效由脚本说了算，因此都试一遍而不是先猜。
 * 映射路缺必要字段时**不发请求**——绝不猜一个 id 硬打上游（猜错会取到别的歌，比取不到更糟）。
 */
async function resolveWithFallback(
  source: LxScriptSource,
  ref: LxTrackRef,
  quality: DownloadQuality
): Promise<{ url: string; quality: string }> {
  const errors: string[] = []

  if (isUsableLxMeta(ref.platform, ref.meta)) {
    try {
      const script = await ensureScript(source)
      return await resolveLxSourceUrl({ ...source, script }, ref, quality)
    } catch (err) {
      errors.push(`原样取址：${errText(err)}`)
    }
  }

  const mapped = toLxMusicInfo(ref.platform, ref.meta)
  if (!mapped.ok) {
    errors.push(mapped.reason)
  } else {
    try {
      const script = await ensureScript(source)
      return await resolveLxSourceUrl({ ...source, script }, { ...ref, meta: mapped.musicInfo }, quality)
    } catch (err) {
      errors.push(`映射取址：${errText(err)}`)
    }
  }

  throw new Error(errors.join('；'))
}

export function registerLxSourceIpc(): void {
  installLxHostDeps()

  // 拉取脚本源码（设置页填脚本链接时用；主进程拉取可避开渲染层 CORS）
  ipcMain.handle('lx:fetchScript', async (_event, url: string, force?: boolean): Promise<string> => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('脚本地址无效')
    if (force) clearScriptCacheByUrl(url)
    return await fetchLxScript(url, SCRIPT_FETCH_TIMEOUT)
  })

  // 探测脚本能力（平台 / 音质档位 / 是否自带搜索），设置页「测试」用
  ipcMain.handle(
    'lx:inspect',
    async (_event, source: LxScriptSource, force?: boolean): Promise<LxSourceInspection> => {
      if (!isLxSource(source)) return { ok: false, platforms: {}, error: '音源配置无效' }
      try {
        if (force) clearScriptCacheOf(source)
        const script = await ensureScript(source)
        return await inspectLxSource({ ...source, script })
      } catch (err) {
        return { ok: false, platforms: {}, error: errText(err) }
      }
    }
  )

  // 脚本自带搜索（仅幻音 / 汽水这类带 search / musicSearch 能力的脚本有）
  ipcMain.handle(
    'lx:search',
    async (_event, source: LxScriptSource, query: string, limit?: number): Promise<LxSearchResult[]> => {
      if (!isLxSource(source)) throw new Error('音源配置无效')
      if (typeof query !== 'string' || !query.trim()) return []
      const script = await ensureScript(source)
      return await searchLxSource({ ...source, script }, query, undefined, {
        limit: Math.min(Math.max(Math.floor(Number(limit) || 30), 1), 100),
      })
    }
  )

  // 按定位信息取直链（播放 / 下载时按需调用）
  ipcMain.handle(
    'lx:resolveUrl',
    async (
      _event,
      ref: LxTrackRef,
      source: OnlineSourceConfig,
      quality?: DownloadQuality
    ): Promise<{ url: string; quality: string }> => {
      if (!isLxTrackRef(ref)) throw new Error('曲目缺少洛雪定位信息')
      if (!isLxSource(source)) throw new Error('音源配置无效')
      if (source.kind && source.kind !== 'lx') throw new Error(`音源「${source.name}」不是洛雪脚本源`)
      if (source.enabled === false) throw new Error(`洛雪音源「${source.name}」已停用`)
      // 默认档位与 App 的默认下载音质一致（flac）；lxHost 内部按脚本声明的档位回落，不会硬要无损
      return await resolveWithFallback(source, ref, quality || 'flac')
    }
  )

  // 清缓存：脚本源码 + 宿主脚本实例（设置页「刷新脚本」用）
  ipcMain.handle('lx:clearCache', () => {
    clearScriptCache()
  })
}
/**
 * 洛雪音乐（lx-music-desktop / lx-music-mobile）用户自定义音源宿主
 *
 * 本模块让 Aurora 直接复用洛雪格式的音源脚本（如 pdone/lx-music-source 仓库里的
 * 六音 / Huibq / 幻音 / ikun / 野花 等），无需服务端改造。
 *
 * 洛雪协议要点（对照 lx-music-desktop 的 src/main/modules/userApi/renderer/preload.js）：
 *   - 脚本拿到沙箱全局 `lx`，用 `lx.on(lx.EVENT_NAMES.request, handler)` 注册请求回调，
 *     用 `lx.send(lx.EVENT_NAMES.inited, { sources: {...} })` 声明自己在各平台上的能力；
 *   - 宿主向 handler 发 `{ source, action, info }`：`action='musicUrl'` 要求返回音频直链，
 *     `action='search' | 'musicSearch'`（少数脚本才有，例如幻音咪咕 / 全豆要汽水）要求
 *     返回曲目元信息数组；
 *   - 脚本内的网络请求一律经 `lx.request(url, options, cb)` 走宿主（宿主负责 UA / 代理 / 超时），
 *     不直接碰 fetch —— 这也是脚本能跨端复用的原因。
 *
 * 与 aurora 自有协议的关系：这里是**执行器**，不改变配置形态。
 * 洛雪源是只有 musicUrl（没有公共搜索接口）的「取址型源」，因此曲目由本应用自己按
 * 歌名搜索（走 aurora 搜索音源或脚本自带的 search 能力），再交给脚本取直链。
 *
 * 安全性：脚本以 `new Function` 在参数遮蔽的伪全局里执行（脚本内的 globalThis / window /
 * document / localStorage 都指向宿主提供的对象，拿不到真实全局与 Node 能力），
 * 与洛雪把脚本丢进独立渲染进程的思路一致，但不需要额外开窗口。
 */

import LZString from 'lz-string'
import { fetchWithTimeout } from './fetchWithTimeout'
import { auroraError, describeError, toErrorInfo } from './i18n/errors'
import type { MessageKey } from './i18n'
import type { DownloadQuality, OnlineSourceConfig, OnlineTrackSearchResult, SourceTrackRef } from './types'

/**
 * 洛雪脚本源的曲目定位令牌：即协议层的中性类型 SourceTrackRef。
 * 保留该别名供翻译层内部（本文件、lxResolver、两端执行接入与既有 IPC）沿用，
 * 协议层本身不再出现脚本专属字样。
 */
export type LxTrackRef = SourceTrackRef

/** 搜索结果条目：脚本源额外带一份取址定位信息（重取直链时原样回喂脚本） */
export type LxSearchResult = OnlineTrackSearchResult & {
  trackRef?: SourceTrackRef
}

// ─── 洛雪脚本运行时类型 ───────────────────────────────────────────

export interface LxRequestOptions {
  method?: string
  timeout?: number
  response_timeout?: number
  headers?: Record<string, string>
  body?: unknown
  form?: unknown
  formData?: unknown
}

export interface LxResponse {
  statusCode: number
  statusMessage?: string
  headers?: Record<string, string>
  bytes?: number
  raw?: string
  body?: any
}

export type LxRequestCallback = (err: unknown, resp: LxResponse | null, body?: any) => void

/** 宿主注入的请求实现：桌面端走主进程 Node 网络栈，移动端走 WebView fetch */
export type LxRequestFn = (url: string, options: LxRequestOptions, callback: LxRequestCallback) => () => void

/** 脚本声明的单平台能力 */
export interface LxPlatformCapability {
  name?: string
  type?: string
  actions: string[]
  qualitys: string[]
}

/**
 * 一条洛雪音源脚本 —— 即 `kind:'lx'` 的 OnlineSourceConfig 本身（结构兼容）。
 * `sourceUrl` 是用户填的脚本链接，脚本源码运行前由平台侧拉取后填入 `script`。
 */
export type LxScriptSource = OnlineSourceConfig & {
  /** 脚本源码（运行前必须已填充：设置页保存时拉取，或运行时按 sourceUrl 现拉） */
  script?: string
}

/** 洛雪脚本声明的平台集合（桌面端支持面） */
export const LX_KNOWN_PLATFORMS = ['kw', 'kg', 'tx', 'wy', 'mg', 'git', 'local'] as const

/**
 * 平台展示名：**协议标识 → 文案键**（不是中文名）。
 *
 * 值必须是键：平台名是界面文案（英文界面下要显示 Kuwo/Kugou…），在模块级求值
 * 会把语言冻结在模块加载那一刻（i18n.md 硬规则 1）。取键的时机是**渲染期**。
 * `LX_KNOWN_PLATFORMS` 里的标识串（kw/kg/wy…）是**协议标识**，参与脚本能力匹配，
 * 一律不翻译。
 */
export const LX_PLATFORM_LABEL_KEYS: Record<string, MessageKey> = {
  kw: 'core.platform.kw',
  kg: 'core.platform.kg',
  tx: 'core.platform.tx',
  wy: 'core.platform.wy',
  mg: 'core.platform.mg',
  git: 'core.platform.git',
  local: 'core.platform.local',
}

/**
 * @deprecated 兼容别名，值与 LX_PLATFORM_LABEL_KEYS 同一个对象（桶文件仍在导出旧名）。
 * 语义已变：**值是文案键，不再是中文名** —— 直接上屏会露出键名，
 * 调用方须改用 `t(LX_PLATFORM_LABEL_KEYS[key] ?? key)`；新代码请直接用新名。
 */
export const LX_PLATFORM_LABELS = LX_PLATFORM_LABEL_KEYS

export interface LxSourceInspection {
  ok: boolean
  /** 脚本自报的名称 / 版本（liscript 包装时才有） */
  name?: string
  version?: string
  description?: string
  author?: string
  homepage?: string
  /** 各平台能力 */
  platforms: Record<string, LxPlatformCapability>
  /**
   * 加载失败原因（ok=false 时）。
   * 形态：结构化错误载荷（`AURORA_ERR:{code,params,detail}`）或第三方脚本抛出的自由文本；
   * 两者都交给显示端的 `translateError(error, t)` 渲染（自由文本按原样透出，不吞信息）。
   */
  error?: string
  /** 是否经过 liscript 自解压包装 */
  packed?: boolean
}

// ─── 宿主构建 ─────────────────────────────────────────────────────

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' } as const

/**
 * 脚本作用域里被**参数遮蔽**的全局名。
 *
 * 两个必须遮蔽的类别：
 *  1) 宿主对象：globalThis / window / self / console —— 脚本只能看到我们给的伪全局，
 *     拿不到真实全局，也就写不到应用状态；
 *  2) Node 标识：process / require / module / exports / global —— 实测有脚本
 *     （pdone 的 lx/latest.js）**探测到 process 就改走 Node 分支，同步挂死**，
 *     整轮加载再也回不来。洛雪的脚本跑在渲染进程里、Node 全局不在其作用域内，
 *     这里必须还原同样的环境。
 * 未列举的名字（Object / JSON / Promise / Math…）仍取真实全局，脚本正常逻辑不受影响。
 */
const SHADOWED_GLOBALS = [
  'globalThis',
  'window',
  'self',
  'document',
  'navigator',
  'location',
  'localStorage',
  'console',
  'process',
  'require',
  'module',
  'exports',
  'global',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'fetch',
  'Buffer',
  'URL',
  'URLSearchParams',
  'TextDecoder',
  'TextEncoder',
  'crypto',
] as const

/** 单次取结果的默认超时 */
const DEFAULT_CALL_TIMEOUT_MS = 20_000

/** 脚本首次执行（boot）的默认超时：只覆盖同步段，正常脚本在毫秒级返回 */
const DEFAULT_EVAL_TIMEOUT_MS = 10_000

/**
 * 给任意 Promise 加超时：超时抛调用方给的错误（文案在这里不落地，由调用方按
 * 结构化错误码组装），不吞掉原始异常 —— 原始的 reject 原样透出。
 */
function withTimeout<T>(task: Promise<T>, ms: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), ms)
    task.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

interface LxBox {
  /** 脚本声明的能力 */
  inspection: LxSourceInspection
  /** 向脚本发起一次请求；脚本未注册 handler 时抛错 */
  call: (source: string, action: string, info: Record<string, unknown>) => Promise<any>
  /** 已废弃的内部句柄（保持引用，便于调试） */
  state: { inited: any; updateAlert: any; error?: string }
}

export interface LxHostDeps {
  request: LxRequestFn
  env?: 'desktop' | 'mobile'
  version?: string
  /** 是否需要脚本日志（默认静默，避免第三方脚本刷屏） */
  verbose?: boolean
  /**
   * 可选的脚本执行器（默认用 `new Function`）。
   * 桌面端主进程注入 `node:vm` 版即可获得「同步死循环可被 timeout 打断」的能力。
   * 注入后，脚本（含 Liscript 自解压的引导段）一律交给它执行。
   *
   * 契约：传入的 `script` 是**函数体**（含 `return` 与 `"use strict"`），执行器需自行
   * 包成函数再跑（如 `vm.runInContext('(function(){' + script + '})()', ctx, { timeout })`）；
   * 执行器只需 `vm.createContext(sandbox)`（sandbox 已自洽：globalThis/window/self 指向它自身，
   * 伪全局与宿主全局都平铺在键上）；超时抛错即可，宿主会转为可读错误。
   * **不得对 sandbox 做拷贝**：宿主依赖它的对象身份读回脚本写入的数据（Liscript 解包即如此）。
   */
  evaluate?: (script: string, sandbox: Record<string, unknown>, timeoutMs: number) => unknown
  /** 脚本首次执行（boot）的超时（毫秒，默认 10s；仅在注入 evaluate 时生效） */
  scriptTimeoutMs?: number
  /**
   * 单次向脚本取结果（musicUrl / search）的超时（毫秒，默认 20s）。
   * 第三方脚本可能把上游不可达挂成长尾请求，而搜索是**并发聚合**的：
   * 一条坏脚本不设上限就会拖住整轮搜索，用户看到的是「搜索一直在转」。
   */
  callTimeoutMs?: number
  /**
   * 平台侧工具实现（部分脚本做签名 / 解压会用到）。
   * 桌面端由 Electron 主进程注入 Node 实现；移动端注入 WebView 可用的等价实现，缺失时降级。
   */
  utils?: {
    crypto?: {
      aesEncrypt?: (buffer: unknown, mode: string, key: unknown, iv: unknown) => unknown
      rsaEncrypt?: (buffer: unknown, key: unknown) => unknown
      randomBytes?: (size: number) => unknown
      md5?: (str: string) => string
    }
    zlib?: {
      inflate?: (buf: unknown) => Promise<unknown>
      deflate?: (data: unknown) => Promise<unknown>
    }
    buffer?: {
      from?: (...args: unknown[]) => unknown
      bufToString?: (buf: unknown, format: string) => string
    }
  }
}

/**
 * 全局宿主依赖：平台（桌面主进程 / 移动端 WebView）启动时注入一次，
 * 之后的搜索 / 取址都不必再穿参——这一点很关键：宿主实现里含函数，
 * 无法经 IPC 序列化传参，因此只能在「发起调用的那一侧」注册。
 * 传参版本（deps 参数）保留给单测与特殊场景，未传时用这里注册的。
 */
let globalDeps: LxHostDeps | null = null

/** 注册宿主依赖（平台启动时调用一次） */
export function setLxHostDeps(deps: LxHostDeps | null): void {
  globalDeps = deps
  boxCache.clear()
}

/** 取当前注册的宿主依赖；未注册返回 null（调用方据此给出可读错误） */
export function getLxHostDeps(): LxHostDeps | null {
  return globalDeps
}

/**
 * 依赖归一化：显式参数优先，其次全局注册。
 *
 * 刻意**不在这里抛错**：`evaluate` / `utils` 这些能力在「解析 Liscript 包装」阶段就要用，
 * 而那时并不需要 request。缺少 request 时给一个调用即抛的占位，真正的「宿主未初始化」
 * 提示落在发起请求的那一刻（脚本报错文本也更贴近事实）。
 */
function normDeps(deps?: LxHostDeps | null): LxHostDeps {
  const base = deps || globalDeps
  if (base && typeof base.request === 'function') return base
  const missingRequest = (() => {
    throw auroraError('core.error.lxHostNotReady')
  }) as unknown as LxRequestFn
  return { ...(base || {}), request: missingRequest }
}

const LX_HOST_VERSION = '2.0.0'

/** 静默 console：脚本里的调试输出默认丢弃 */
function quietConsole(): Console {
  const noop = () => {}
  return {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    group: noop,
    groupEnd: noop,
    table: noop,
    time: noop,
    timeEnd: noop,
  } as unknown as Console
}

/** 构造一个洛雪宿主：伪全局 + lx 桥 */
function createHost(deps?: LxHostDeps | null) {
  const effective = normDeps(deps)
  const state: { inited: any; updateAlert: any; error?: string } = { inited: null, updateAlert: null }
  const events: { request: ((arg: any) => any) | null } = { request: null }

  const fakeGlobal: Record<string, unknown> = {}
  fakeGlobal.liscript = {} as Record<string, unknown>

  const lx = {
    EVENT_NAMES,
    version: effective.version || LX_HOST_VERSION,
    env: effective.env || 'desktop',
    currentScriptInfo: { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' },
    on(name: string, handler: unknown) {
      if (name === EVENT_NAMES.request) {
        events.request = handler as (arg: any) => any
        return Promise.resolve()
      }
      return Promise.reject(new Error(`The event is not supported: ${name}`))
    },
    send(name: string, data: unknown) {
      if (name === EVENT_NAMES.inited) {
        state.inited = data
        return Promise.resolve()
      }
      if (name === EVENT_NAMES.updateAlert) {
        state.updateAlert = data
        return Promise.resolve()
      }
      return Promise.reject(new Error(`Unknown event name: ${name}`))
    },
    request(url: string, options: LxRequestOptions, callback: LxRequestCallback) {
      return effective.request(url, options || {}, callback)
    },
    utils: {
      // 脚本里的签名 / 解压工具一律转发到平台注入的实现（见 LxHostDeps.utils）：
      // 桌面端由主进程给 Node 版（真实 crypto / zlib），移动端给 WebView 版，缺失时降级为空
      crypto: {
        md5: (str: string) => effective.utils?.crypto?.md5?.(str),
        aesEncrypt: (buffer: unknown, mode: string, key: unknown, iv: unknown) =>
          effective.utils?.crypto?.aesEncrypt?.(buffer, mode, key, iv),
        rsaEncrypt: (buffer: unknown, key: unknown) => effective.utils?.crypto?.rsaEncrypt?.(buffer, key),
        randomBytes: (size: number) => effective.utils?.crypto?.randomBytes?.(size),
      },
      buffer: {
        from: (...args: unknown[]) => effective.utils?.buffer?.from?.(...args),
        bufToString: (buf: unknown, format: string) =>
          effective.utils?.buffer?.bufToString?.(buf, format) ?? '',
      },
      zlib: {
        // 脚本宿主能力缺失：面向脚本开发者（脚本自己决定要不要用 zlib），
        // 不是界面文案，故保持英文原文，不进字典。
        inflate: (buf: unknown) =>
          effective.utils?.zlib?.inflate?.(buf) ??
          Promise.reject(new Error('zlib unavailable: host provided no utils.zlib.inflate')),
        deflate: (data: unknown) =>
          effective.utils?.zlib?.deflate?.(data) ??
          Promise.reject(new Error('zlib unavailable: host provided no utils.zlib.deflate')),
      },
    },
  }

  fakeGlobal.lx = lx

  return { fakeGlobal, lx, state, events }
}

/**
 * 把脚本构造为可执行函数：全部宿主全局以参数形式遮蔽，脚本拿不到真实 global。
 *
 * 局限（已知）：`new Function` 里的**同步死循环无法被打断**，会卡住调用线程。
 * 桌面端主进程可经 LxHostDeps.evaluate 注入 `node:vm` 版执行器（runInContext 支持
 * timeout，可中断同步死循环）；移动端 WebView 无此能力，沿用这里的实现。
 * 符号遮蔽已挡掉实测会挂死的那个分支（见 SHADOWED_GLOBALS）。
 */
function compileScript(
  script: string,
  fakeGlobal: Record<string, unknown>,
  quiet: boolean,
  evaluate?: LxHostDeps['evaluate'],
  timeoutMs?: number
) {
  const consoleImpl = quiet ? quietConsole() : console
  const body = `"use strict";\n${script}\n;return globalThis.__lx_exports__ || undefined`
  const fn = new Function(...SHADOWED_GLOBALS, body) as (...args: unknown[]) => unknown
  const args = SHADOWED_GLOBALS.map((name) => {
    switch (name) {
      case 'globalThis':
      case 'window':
      case 'self':
        return fakeGlobal
      case 'console':
        return consoleImpl
      case 'document':
      case 'navigator':
      case 'location':
      case 'localStorage':
      case 'process':
      case 'require':
      case 'module':
      case 'exports':
      case 'global':
        return undefined
      case 'setTimeout':
      case 'clearTimeout':
      case 'setInterval':
      case 'clearInterval':
      case 'queueMicrotask':
      case 'fetch':
      case 'Buffer':
      case 'URL':
      case 'URLSearchParams':
      case 'TextDecoder':
      case 'TextEncoder':
      case 'crypto':
        return (globalThis as any)[name]
      default:
        return undefined
    }
  })
  // 传入的伪全局必须与真实全局**同一个对象**：`new Function` 版把 fakeGlobal 直接当
  // globalThis 用，脚本（以及 Liscript 引导段）写进去的东西都落在它上面，宿主随后从这个
  // 对象读回结果（如 `fakeGlobal.liscript`）。若这里换成浅拷贝，脚本写的是副本，
  // 宿主读的是原件 —— 表现为「Liscript 解包后拿到空对象、脚本永远初始化不了」。
  // 因此：同一个对象同时承担两个角色（伪全局的容器 + 脚本可见的 globalThis/window/self）。
  for (const name of ['globalThis', 'window', 'self']) {
    fakeGlobal[name] = fakeGlobal
  }

  // 平台注入执行器时（桌面端是 node:vm）交给它跑：同步死循环可被 timeout 打断。
  // 未注入（移动端 WebView 没有 vm 能力）则回落 new Function，语义一致、风险见上。
  if (evaluate) {
    // 交给执行器的 sandbox 就是 fakeGlobal 本身：宿主全局按遮蔽规则平铺，
    // globalThis / window / self 已指向它自身，执行器只需 vm.createContext(sandbox)。
    SHADOWED_GLOBALS.forEach((name, i) => {
      fakeGlobal[name] = args[i]
    })
    fakeGlobal.globalThis = fakeGlobal
    fakeGlobal.window = fakeGlobal
    fakeGlobal.self = fakeGlobal
    return () => evaluate(body, fakeGlobal, timeoutMs || DEFAULT_EVAL_TIMEOUT_MS)
  }
  return () => fn(...args)
}

// ─── liscript 自解压 ──────────────────────────────────────────────

interface PackedMeta {
  script?: string
  rawScript?: string
  name?: string
  version?: string
  description?: string
  author?: string
  homepage?: string
}

/**
 * 部分音源（如六音）用 Liscript 自解压包装：脚本体只负责把源码写进 `globalThis.liscript`。
 * 这里先跑一遍拿到包装数据，再用 lz-string 解出真正的源码。
 */
function unpackLiscript(script: string, deps?: LxHostDeps | null): { code: string; meta: PackedMeta } | null {
  if (!/liscript/i.test(script)) return null
  const { fakeGlobal } = createHost(deps)
  const run = compileScript(script, fakeGlobal, true, deps?.evaluate, deps?.scriptTimeoutMs)
  try {
    run()
  } catch {
    return null
  }
  const data = fakeGlobal.liscript as PackedMeta | undefined
  if (!data || typeof data.script !== 'string') return null
  const decode = (input: string): string | null => {
    // 洛雪 Liscript 的压缩形态在各版本间有差异（Base64 / UTF16 / 原始），逐个试
    const candidates: ((s: string) => string | null | undefined)[] = [
      (s) => LZString.decompressFromBase64(s),
      (s) => LZString.decompressFromUTF16(s),
      (s) => LZString.decompress(s),
      (s) => LZString.decompressFromEncodedURIComponent(s),
    ]
    for (const fn of candidates) {
      try {
        const out = fn(input)
        if (out && out.length > 32) return out
      } catch {
        /* 换下一种 */
      }
    }
    return null
  }
  const code = decode(data.script)
  if (!code) return null
  const rawCode = typeof data.rawScript === 'string' ? decode(data.rawScript) : null
  return { code: rawCode || code, meta: data }
}

/**
 * 解包 + 编译 + 等 inited。
 * deps.request 是宿主网络实现，脚本运行期间的请求都会经它发出。
 */
async function bootLxScript(
  script: string,
  deps: LxHostDeps | null | undefined,
  packedMeta: PackedMeta | null
): Promise<LxBox> {
  const effective = normDeps(deps)
  const { fakeGlobal, state, events } = createHost(effective)
  if (packedMeta) {
    ;(fakeGlobal.liscript as PackedMeta) = packedMeta
  }
  const run = compileScript(script, fakeGlobal, !effective.verbose, effective.evaluate, effective.scriptTimeoutMs)
  let evalError: string | undefined
  try {
    run()
  } catch (err) {
    evalError = (err as Error)?.message || String(err)
  }

  // 脚本可能在解析后异步 send(inited)；给一个短窗口等待
  if (!state.inited && !evalError) {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !state.inited) {
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  const inspection = inspectInited(state, evalError, Boolean(packedMeta))
  const timeoutMs = effective.callTimeoutMs || DEFAULT_CALL_TIMEOUT_MS
  return {
    inspection,
    state,
    call: async (source, action, info) => {
      if (!events.request) throw auroraError('core.error.lxNoRequestHandler')
      return await withTimeout(
        Promise.resolve(events.request({ source, action, info })),
        timeoutMs,
        () => auroraError('core.error.lxCallTimeout', { source, action, ms: timeoutMs })
      )
    },
  }
}

/** 从 inited 数据里提炼平台能力；与洛雪的 preload 一样做白名单收窄 */
function inspectInited(
  state: { inited: any; error?: string },
  evalError: string | undefined,
  packed: boolean
): LxSourceInspection {
  const out: LxSourceInspection = { ok: false, platforms: {}, packed }
  if (evalError) {
    out.error = evalError
    return out
  }
  const inited = state.inited
  if (!inited || typeof inited !== 'object' || !inited.sources || typeof inited.sources !== 'object') {
    out.error = auroraError('core.error.lxNotInited').message
    return out
  }
  for (const [platform, raw] of Object.entries<any>(inited.sources)) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.type && raw.type !== 'music') continue
    const actions = Array.isArray(raw.actions) ? raw.actions.filter((a: unknown) => typeof a === 'string') : []
    const qualitys = Array.isArray(raw.qualitys) ? raw.qualitys.filter((q: unknown) => typeof q === 'string') : []
    out.platforms[platform] = {
      name: typeof raw.name === 'string' ? raw.name : undefined,
      type: 'music',
      actions,
      qualitys,
    }
  }
  out.ok = Object.keys(out.platforms).length > 0
  if (!out.ok) out.error = auroraError('core.error.lxNoPlatforms').message
  return out
}

// ─── 对外门面 ─────────────────────────────────────────────────────

/** 脚本缓存：同一脚本只加载一次（第三方脚本可能拉远程配置，重复加载代价高） */
const boxCache = new Map<string, Promise<LxBox>>()

/**
 * 脚本指纹：用 FNV-1a 扫一遍全量脚本，而不是「长度 + 首尾片段」——
 * 后者在脚本主体被改写、而长度与首尾恰好没变时**不会失效**，取址会一直用旧脚本行为，
 * 这是最难查的一类问题。全量哈希没有这个盲区，代价只是一次线性扫描。
 */
function cacheKeyOf(source: LxScriptSource): string {
  const script = source.script || ''
  let hash = 0x811c9dc5
  for (let i = 0; i < script.length; i++) {
    hash ^= script.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${source.id}:${script.length}:${hash.toString(16)}`
}

/** 清空脚本缓存（音源配置变更时调用） */
export function clearLxSourceCache(): void {
  boxCache.clear()
}

/** 探测一条脚本的能力（设置页「测试」用） */
export async function inspectLxSource(
  source: LxScriptSource,
  deps?: LxHostDeps | null
): Promise<LxSourceInspection> {
  const script = String(source.script || '')
  if (!script.trim()) return { ok: false, platforms: {}, error: auroraError('core.error.lxScriptEmpty').message }
  const packed = unpackLiscript(script, deps)
  const code = packed ? packed.code : script
  try {
    const box = await bootLxScript(code, deps, packed ? packed.meta : null)
    const out = box.inspection
    if (packed?.meta) {
      out.name = packed.meta.name
      out.version = packed.meta.version
      out.description = packed.meta.description
      out.author = packed.meta.author
      out.homepage = packed.meta.homepage
    }
    return out
  } catch (err) {
    return { ok: false, platforms: {}, error: (err as Error)?.message || String(err) }
  }
}

/** 取（或构造）脚本宿主，重复调用复用同一实例 */
async function boxOf(source: LxScriptSource, deps?: LxHostDeps | null): Promise<LxBox> {
  const key = cacheKeyOf(source)
  const hit = boxCache.get(key)
  if (hit) return hit
  const script = String(source.script || '')
  if (!script.trim()) throw auroraError('core.error.lxSourceNoScript', { name: source.name })
  const task = (async () => {
    const packed = unpackLiscript(script, deps)
    const box = await bootLxScript(packed ? packed.code : script, deps, packed ? packed.meta : null)
    // inspection.error 本身就是「码载荷或脚本自由文本」，原样转成可抛错误即可：
    // 再包一层会把第三方脚本的真实报错吞掉（那是排查脚本问题唯一的线索）。
    if (!box.inspection.ok) {
      throw box.inspection.error ? new Error(box.inspection.error) : auroraError('core.error.lxInitFailed')
    }
    return box
  })()
  // 失败不缓存，允许用户改配置后重试
  task.catch(() => boxCache.delete(key))
  boxCache.set(key, task)
  return task
}

/**
 * 音质档位归一：外部（脚本作者文档、命令行、老配置）常见 '128k' / '320k' / '128' 混写，
 * 统一收敛到 Aurora 的三档；无法识别时按标准档处理，绝不抛错。
 */
export function normalizeLxQuality(input: unknown): DownloadQuality {
  const text = String(input ?? '').trim().toLowerCase()
  if (text.startsWith('flac') || text === 'lossless' || text === 'hires') return 'flac'
  if (text.startsWith('320')) return '320'
  return '128'
}

/**
 * 洛雪音质档位 → 脚本声明的档位（取最接近的一档）。
 * 输入档位先归一化：传 '128k' 这类写法不会让查表落空。
 */
export function lxQualityFor(available: string[], wanted: DownloadQuality | string): string {
  const prefer: Record<DownloadQuality, string[]> = {
    flac: ['flac24bit', 'flac', 'hires', '320k', '128k'],
    '320': ['320k', 'flac', 'flac24bit', '128k'],
    '128': ['128k', '320k', 'flac', 'flac24bit'],
  }
  const table = prefer[normalizeLxQuality(wanted)]
  for (const q of table) {
    if (available.includes(q)) return q
  }
  return available[0] || '128k'
}

/** 脚本返回的曲目对象里常见的 id 字段（用于稳定去重，不参与取址） */
const LX_ID_FIELDS = ['id', 'songmid', 'songId', 'hash', 'rid', 'mid', 'copyrightId']

function lxKeyOf(item: Record<string, any>): string {
  for (const f of LX_ID_FIELDS) {
    const v = item[f]
    if (v !== undefined && v !== null && String(v).trim()) return String(v)
  }
  // 没有 id 的脚本（如幻音咪咕）：退回元信息指纹，保证同一首歌每次结果 id 一致
  return `${item.name || item.title || ''}|${item.singer || item.artist || ''}|${item.albumName || item.album || ''}`
}

/** 秒/毫秒/“mm:ss” 三种时长写法归一化为秒 */
function lxDurationOf(item: Record<string, any>): number {
  const raw = item.interval ?? item.duration
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 3600 ? Math.round(raw / 1000) : Math.round(raw)
  if (typeof raw === 'string') {
    if (/^\d+:\d+(:\d+)?$/.test(raw)) {
      const parts = raw.split(':').map((n) => Number(n) || 0)
      return parts.reduce((acc, n) => acc * 60 + n, 0)
    }
    const n = Number(raw)
    if (Number.isFinite(n)) return n > 3600 ? Math.round(n / 1000) : Math.round(n)
  }
  return 0
}

/** 归一化脚本 search 返回值：数组 / { list } / { data } 包裹都认 */
function normalizeSearchPayload(payload: any): Record<string, any>[] {
  if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === 'object')
  if (payload && typeof payload === 'object') {
    for (const field of ['list', 'data', 'songs', 'result', 'results']) {
      const v = (payload as any)[field]
      if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object')
      if (v && typeof v === 'object' && Array.isArray(v.list)) return v.list.filter((x: any) => x && typeof x === 'object')
    }
  }
  return []
}

/**
 * 用洛雪脚本自带的搜索能力搜曲（仅部分脚本有：幻音咪咕、全豆要汽水等）。
 * 返回条目**不含直链**（audioUrl 为空），播放/下载时用 resolveLxSourceUrl 按 meta 取址。
 */
export async function searchLxSource(
  source: LxScriptSource,
  query: string,
  deps?: LxHostDeps | null,
  options?: { limit?: number }
): Promise<LxSearchResult[]> {
  const trimmed = String(query || '').trim()
  if (!trimmed) return []
  const box = await boxOf(source, deps)
  const limit = options?.limit ?? 30
  const out: LxSearchResult[] = []
  const failures: Array<{ platform: string; error: unknown }> = []

  for (const [platform, cap] of Object.entries(box.inspection.platforms)) {
    const action = cap.actions.includes('search')
      ? 'search'
      : cap.actions.includes('musicSearch')
        ? 'musicSearch'
        : null
    if (!action) continue
    try {
      const payload = await box.call(platform, action, { keyword: trimmed, page: 1, limit, pagesize: limit })
      for (const item of normalizeSearchPayload(payload).slice(0, limit)) {
        const title = String(item.name || item.title || item.songName || '').trim()
        if (!title) continue
        const meta = { ...item } as Record<string, unknown>
        out.push({
          id: `${source.id}-${platform}-${lxKeyOf(item)}`,
          title,
          // i18n-exempt: 匹配数据 —— coverMatch.PLACEHOLDER_ARTISTS 拿这个串判定「歌手未知」，
          // 按语言翻译它会让英文界面下的封面匹配门禁行为漂移
          artist: String(item.singer || item.artist || item.artists || '未知艺术家'),
          album: String(item.albumName || item.album || ''),
          duration: lxDurationOf(item),
          coverUrl: item.picUrl || item.coverUrl || item.img || undefined,
          // 直链留空：脚本源的搜索只给元信息，地址在播放/下载时按需取
          audioUrl: '',
          audioQuality: undefined,
          source: source.id,
          sourceName: source.name,
          trackRef: { sourceId: source.id, platform, meta },
        })
      }
    } catch (err) {
      // 单平台失败只记录不中断（其它平台可能仍有结果）。原始异常**整个留着**：
      // 下面要按它的码决定上抛什么，诊断串则交给 describeError 现场生成。
      failures.push({ platform, error: err })
    }
  }

  if (out.length === 0 && failures.length > 0) {
    const detail = failures.map((f) => `${f.platform}: ${describeError(f.error)}`).join('; ')
    // 全是同一种原因时**原样上抛那个码**：超时就该显示超时，别被概括成「没有结果」
    // （那是把可行动的信息抹平）。多种原因并存才收成一句概括，明细放 detail。
    const infos = failures.map((f) => toErrorInfo(f.error))
    const first = infos[0]
    if (first && infos.every((info) => info.code === first.code)) {
      throw auroraError(first.code, first.params, detail)
    }
    throw auroraError('core.error.lxSearchFailed', { count: failures.length }, detail)
  }
  return out
}

/**
 * 按 meta 向洛雪脚本索取直链（musicUrl）。
 * 音质从脚本声明的档位里挑最接近的一档；脚本抛错时按档位从高到低再试一次。
 */
export async function resolveLxSourceUrl(
  source: LxScriptSource,
  ref: SourceTrackRef,
  quality: DownloadQuality | string,
  deps?: LxHostDeps | null
): Promise<{ url: string; quality: string }> {
  const box = await boxOf(source, deps)
  const cap = box.inspection.platforms[ref.platform]
  if (!cap) throw auroraError('core.error.lxPlatformUnsupported', { name: source.name, platform: ref.platform })
  const available = cap.qualitys.length > 0 ? cap.qualitys : ['128k']
  const wanted = lxQualityFor(available, quality)
  // 高优先档位失败时向下回落（脚本对不同档位的上游可用性差异很大）
  const ladder = [wanted, ...available.filter((q) => q !== wanted)].slice(0, 3)
  let lastErr: unknown = null
  for (const q of ladder) {
    try {
      const url = await box.call(ref.platform, 'musicUrl', { type: q, musicInfo: ref.meta })
      if (typeof url === 'string' && /^https?:/i.test(url)) return { url, quality: q }
      lastErr = auroraError('core.error.lxUrlInvalid')
    } catch (err) {
      lastErr = err
    }
  }
  // 原样抛出最后一次失败：它可能是脚本自己抛的错误（自由文本），也可能是上面那几条
  // 结构化错误 —— 两者都比「取址失败」四个字信息量大，不用概括句把它抹平。
  if (lastErr) throw lastErr
  throw auroraError('core.error.lxResolveFailed')
}

// ─── 脚本拉取 ─────────────────────────────────────────────────────

/** 脚本源码体积上限（MB）：脚本不该比这更大，超了多半是拉到了网页而不是脚本 */
const LX_SCRIPT_MAX_MB = 4

/** 拉取远程脚本源码（用户填脚本链接时用）；失败抛结构化错误，文案由显示端按语言渲染 */
export async function fetchLxScript(url: string, timeoutMs = 15000): Promise<string> {
  const resp = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*',
      },
    },
    timeoutMs
  )
  if (!resp.ok) throw auroraError('core.error.lxScriptDownload', { status: resp.status })
  const text = await resp.text()
  if (!text.trim()) throw auroraError('core.error.lxScriptEmpty')
  if (text.length > LX_SCRIPT_MAX_MB * 1024 * 1024) {
    throw auroraError('core.error.lxScriptTooLarge', { limit: LX_SCRIPT_MAX_MB })
  }
  return text
}
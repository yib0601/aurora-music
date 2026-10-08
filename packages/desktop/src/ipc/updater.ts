import { app, ipcMain, net, session, shell } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { auroraError } from '@aurora/shared'
import { mainErrorText, mainTranslate } from '../i18n'

/**
 * 内置更新下载与安装：
 * - 渲染层从 GitHub Releases 选好安装包后，把直链交给主进程流式下载到「下载」目录；
 * - 进度节流推送到渲染层（updater:progress），完成/失败分别发 updater:done / updater:error；
 * - AppImage 下载后自动注入可执行权限；
 * - 「现在安装」按包类型走各自的系统入口：
 *   exe / AppImage → 直接启动安装器（Windows NSIS 自带向导；AppImage 由用户确认后退出当前应用）；
 *   deb / rpm → 打开终端执行 sudo 覆盖安装命令（桌面端应用无法自行提权）；
 *   dmg → 挂载 dmg 并让 Finder 显示，用户把 App 拖进「应用程序」完成覆盖。
 *
 * 下载线路的两条硬规则（都源于实测，改动前请先复测）：
 * 1. 走 Electron 的 net.fetch（Chromium 网络服务），不能用 Node 全局 fetch。
 *    Node 的 fetch 是 undici 直连，既不读系统代理也不认 gsettings：系统里明摆着
 *    配了 127.0.0.1:7897 的代理，它照样绕过去直连 GitHub。实测 GitHub release
 *    资产（8MB 采样）：Node fetch 直连 0.27MB/s，Chromium 栈经系统代理 1.1~1.6MB/s，
 *    78MB 的安装包从「五分钟起步」变成「一分钟左右」。
 * 2. 公共加速前缀（gh-proxy / ghfast）实测只有 35KB/s，比直连还慢，只能当最后兜底。
 *    所以不能「先官方直连、拿到响应头就一直忍着」，必须靠低速看门狗主动换源。
 */

export interface UpdaterProgress {
  received: number
  total: number | null
  /** 实时速度（字节/秒）；无法估算时为 null */
  speed: number | null
}

export interface UpdaterDonePayload {
  filePath: string
  kind: string
}

/** 下载线路描述，用于在下载对话框里告诉用户「正在经系统代理下载」还是「直连」 */
export interface UpdaterRoute {
  label: string
  proxy: string | null
}

/** 支持的安装包类型白名单（渲染层传入，避免被伪造出任意文件） */
const INSTALLER_KINDS = new Set(['apk', 'exe', 'appimage', 'deb', 'rpm', 'dmg'])

/**
 * 下载地址白名单：GitHub 官方域名，或「公共加速前缀 + GitHub 原始链接」。
 * 与渲染层 services/update-source.ts 的前缀列表保持一致（主进程无法复用 app 包代码），
 * 任何其他域名一律拒绝，避免该 IPC 被利用来下载任意文件。
 */
const GITHUB_HOSTS = new Set(['github.com', 'objects.githubusercontent.com'])
const PROXY_HOSTS = new Set(['gh-proxy.com', 'ghfast.top'])

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.host.toLowerCase() : null
  } catch {
    return null
  }
}

function isAllowedDownloadUrl(url: string): boolean {
  const host = hostOf(url)
  if (!host) return false
  return GITHUB_HOSTS.has(host) || PROXY_HOSTS.has(host)
}

/** 下载中的请求；同一时间只允许一个，新请求会拒绝（渲染层已有互斥，这里兜底） */
let activeAbort: AbortController | null = null

function downloadDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

/** 清理目录内同一应用的旧安装包，避免「下载」目录越攒越多（只删本应用、只留最新） */
function cleanupOldArtifacts(dir: string, keepFile: string) {
  try {
    const keep = path.resolve(keepFile)
    for (const entry of fs.readdirSync(dir)) {
      if (!/^Aurora-Music-.*\.(AppImage|appimage|deb|rpm|exe|dmg)$/i.test(entry)) continue
      const full = path.join(dir, entry)
      if (path.resolve(full) === keep) continue
      try {
        fs.rmSync(full, { force: true })
      } catch {
        // 删不掉不影响本次更新
      }
    }
  } catch {
    // 忽略
  }
}

/** 主进程把 URL 的文件名取出来（兜底按包类型生成） */
function fileNameFromUrl(url: string, kind: string): string {
  try {
    const tail = new URL(url).pathname.split('/').filter(Boolean).pop() || ''
    // 取 basename：pathname 里被编码的 %2F 解码后会带出路径分隔符，
    // 直接拼进下载目录就能写到任意位置，这里必须先削掉目录部分
    const name = path.basename(decodeURIComponent(tail))
    if (name && /^[\w.-]+\.[A-Za-z0-9]{2,8}$/.test(name)) return name
  } catch {
    // 落到兜底
  }
  const ext: Record<string, string> = { apk: '.apk', exe: '.exe', appimage: '.AppImage', deb: '.deb', rpm: '.rpm', dmg: '.dmg' }
  return `Aurora-Music-update${ext[kind] || ''}`
}

/** 目标路径已存在时依次追加 " (1)" " (2)"… */
function uniquePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName)
  const stem = fileName.slice(0, -ext.length)
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? fileName : `${stem} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

/**
 * 组装下载候选地址列表（GitHub 官方直链 + 加速前缀）。
 * 渲染层传入的 altUrls 只是「顺序建议」，每一项仍逐个校验：
 * 只接受 GitHub 官方域名或白名单加速域名，避免被伪造出任意文件下载。
 */
function normalizeDownloadUrls(url: unknown, altUrls: unknown): string[] {
  const raw = [url, ...(Array.isArray(altUrls) ? altUrls : [])]
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    if (!isAllowedDownloadUrl(item)) continue
    if (seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

// ───────────────────────── 下载网络层 ─────────────────────────

const UPSTREAM_USER_AGENT = 'Aurora-Music-Updater'

/** 建连超时：大陆网络直连 GitHub 失败时 TCP 建连会挂起 10~40s，必须先放弃再换源 */
const CONNECT_TIMEOUT_MS = 8000

/** 看门狗采样节拍：每 1s 评估一次速度与存活 */
const WATCH_TICK_MS = 1000

/** 低速阈值：低于它基本可断定这条源走不通（实测代理链路 1.1~1.6MB/s、直连 0.27MB/s、前缀 0.035MB/s） */
const SLOW_BPS = 384 * 1024

/** 判定「持续低速」所需的最小观察窗口，短于此不下结论，避免起步抖动误判 */
const SLOW_WINDOW_MS = 8000

/** 已下载比例超过它就不再换源：快到终点了，重连不值 */
const SWITCH_TAIL_RATIO = 0.85

/** 硬卡死：多久完全没有数据就判定这条连接废了（关掉低速中止后仍有这层保护） */
const HARD_STALL_MS = 30000

/** 竞速探测：每个候选源最多读多少字节来估速 */
const PROBE_BYTES = 512 * 1024
/** 竞速探测的总时限（含建连） */
const PROBE_TIMEOUT_MS = 6000
/** 单次下载最多触发几次竞速换源 */
const MAX_RACES = 2

/** 竞速探测的候选上限：并发探测太多源会互相抢带宽，还把失败路径拉长 */
const MAX_PROBE_SOURCES = 4

/** 速度采样窗口不足这个时长就不报速度（避免起步/换源瞬间用毫秒级间隔算出假高速） */
const MIN_SPEED_WINDOW_MS = 500

const TIMEOUT = Symbol('watchdog-timeout')

/** 读取超时竞速：超时返回 TIMEOUT，底层 promise 保持 pending 交给下一轮复用，不会丢数据 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T | typeof TIMEOUT>
}

/** 从父信号派生一个可单独中止的信号（当前请求超时/看门狗中止时不牵连整个任务） */
function deriveAbort(parent: AbortSignal): { ctrl: AbortController; dispose: () => void } {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (parent.aborted) ctrl.abort()
  else parent.addEventListener('abort', onAbort)
  return { ctrl, dispose: () => parent.removeEventListener('abort', onAbort) }
}

type NetFetchInit = Parameters<typeof net.fetch>[1]

/**
 * 说明当前线路：Chromium 会把系统代理设置解析成 "PROXY host:port; DIRECT" 这样的规则串。
 * 结果只用于展示与诊断——真正的代理生效由 Chromium 网络栈自动完成。
 */
async function describeRoute(url: string): Promise<UpdaterRoute> {
  try {
    const raw = await session.defaultSession.resolveProxy(url)
    const first = raw.split(';').map((part) => part.trim()).find(Boolean) || 'DIRECT'
    const matched = /^(PROXY|HTTPS|SOCKS5?|SOCKS4?)\s+(\S+)/i.exec(first)
    if (matched) {
      // 线路说明经 updater:route 直接上屏（渲染层只做透传），所以现取当前语言的成品句
      return { label: mainTranslate()('desktop.updater.routeProxy', { proxy: matched[2] }), proxy: matched[2] }
    }
  } catch {
    // resolveProxy 不可用时按直连展示
  }
  return { label: mainTranslate()('desktop.updater.routeDirect'), proxy: null }
}

/** Content-Range 里的起点与总长：只认「bytes 起-止/总长」这一种写法，其余形式一律视为不可信 */
function contentRangeInfo(res: Response): { start: number; total: number | null } | null {
  const raw = res.headers.get('content-range')
  if (!raw) return null
  const matched = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(raw.trim())
  if (!matched) return null
  const start = Number(matched[1])
  const total = matched[3] === '*' ? null : Number(matched[3])
  if (!Number.isFinite(start) || start < 0) return null
  return { start, total: total !== null && Number.isFinite(total) && total > 0 ? total : null }
}

function contentLengthOf(res: Response): number | null {
  const raw = res.headers.get('content-length')
  if (!raw) return null
  const size = Number(raw)
  return Number.isFinite(size) && size > 0 ? size : null
}

interface OpenedResponse {
  res: Response
  /** 服务端确实从 offset 处接着给数据 */
  resumed: boolean
  /** 完整包长度；这条响应没给出可信长度时为 null */
  total: number | null
  /** 无法确认这条 206 到底从哪开始发数据时为 false：这种情况必须弃用该源 */
  trusted: boolean
}

/**
 * 判断这次响应到底有没有「从 offset 接着给数据」，以及它是否可以采信。
 *
 * 依据（拿不准一律不采信，代价是换个源，换不来坏包）：
 * 1. 有 Content-Range：起点等于 offset 才算续传；起点为 0 说明服务端把整包重发（可截断重下）；
 *    起点是别的值则完全没法用。
 * 2. 没有 Content-Range（加速层常把它剥掉）：只能靠长度反推 —— body 长度等于
 *    「已知总长 - offset」是剩余部分（续传），等于「已知总长」是整包重发；
 *    已知总长未知时无从判断，弃用该响应（否则可能把「后半段」当整包写进文件开头）。
 */
function classifyResponse(
  res: Response,
  offset: number,
  info: { start: number } | null,
  knownTotal: number | null
): { resumed: boolean; trusted: boolean } {
  if (res.status !== 206 || offset <= 0) return { resumed: false, trusted: true }
  if (info) return { resumed: info.start === offset, trusted: info.start === offset || info.start === 0 }
  const length = contentLengthOf(res)
  if (knownTotal === null || length === null) return { resumed: false, trusted: false }
  const resumed = length === knownTotal - offset
  return { resumed, trusted: resumed || length === knownTotal }
}

/**
 * 发起一次下载请求，只约束「拿到响应头」这一段：建连超时后立刻中止，交给外层换源。
 * 拿到响应头之后计时器解除，读取阶段由看门狗（低速/卡死）负责中止。
 */
async function openResponse(
  url: string,
  offset: number,
  ctrl: AbortController,
  knownTotal: number | null
): Promise<OpenedResponse> {
  const timeoutId = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS)
  try {
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': UPSTREAM_USER_AGENT,
        Accept: '*/*',
        ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
      },
      redirect: 'follow',
      // Chromium 默认把这类请求当低优先级；实测 high 能把吞吐拉高约 50%
      priority: 'high',
      signal: ctrl.signal,
    } as NetFetchInit)
    if (!res.ok || !res.body) throw auroraError('desktop.error.updater.httpStatus', { status: res.status })
    clearTimeout(timeoutId)
    const info = contentRangeInfo(res)
    const { resumed, trusted } = classifyResponse(res, offset, info, knownTotal)
    // 长度来源优先级：本次响应的 Content-Range 总长 → 续传时沿用已知总长 → 整包响应自己的 Content-Length
    const total = info?.total ?? (resumed ? knownTotal : contentLengthOf(res))
    return { res, resumed, trusted, total }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 源既不给 Content-Length 也不给 Content-Range 时的兜底：用 `Range: bytes=0-0`
 * 问一次总长（响应里的 `Content-Range: bytes 0-0/N` 就是包体大小）。
 * 拿不到长度就无法判断「流干净结束」是下完了还是被截断，这一步是那种情况下唯一的对账依据。
 * 探测只信 Content-Range：`Content-Length: 1` 是这一个字节的长度，不是包体大小。
 */
async function probeTotalSize(url: string, ctrl: AbortController): Promise<number | null> {
  // 自带超时且只中止探测自己：源挂着不回响应头时，不能把整次下载一起拖死
  const attempt = deriveAbort(ctrl.signal)
  const timeoutId = setTimeout(() => attempt.ctrl.abort(), CONNECT_TIMEOUT_MS)
  try {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': UPSTREAM_USER_AGENT, Accept: '*/*', Range: 'bytes=0-0' },
      redirect: 'follow',
      priority: 'high',
      signal: attempt.ctrl.signal,
    } as NetFetchInit)
    const info = contentRangeInfo(res)
    try {
      await res.body?.cancel()
    } catch {
      // 探测响应体直接丢弃
    }
    return info?.total ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
    attempt.dispose()
  }
}

/** 读一小段估算某条源的实速（字节/秒）；失败或不可用返回 0 */
async function probeSpeed(url: string, signal: AbortSignal): Promise<number> {
  const attempt = deriveAbort(signal)
  const startedAt = Date.now()
  const deadline = setTimeout(() => attempt.ctrl.abort(), PROBE_TIMEOUT_MS)
  let bytes = 0
  try {
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': UPSTREAM_USER_AGENT,
        Accept: '*/*',
        Range: `bytes=0-${PROBE_BYTES - 1}`,
      },
      redirect: 'follow',
      priority: 'high',
      signal: attempt.ctrl.signal,
    } as NetFetchInit)
    if (res.ok && res.body) {
      const body = Readable.fromWeb(res.body as any)[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>
      let pending = body.next() as Promise<IteratorResult<Uint8Array>>
      for (;;) {
        const chunk = await raceWithTimeout(pending, PROBE_TIMEOUT_MS)
        if (chunk === TIMEOUT || chunk.done) break
        bytes += chunk.value.length
        if (bytes >= PROBE_BYTES) break
        pending = body.next() as Promise<IteratorResult<Uint8Array>>
      }
      attempt.ctrl.abort() // 主动断开，别继续占对端带宽
    }
  } catch {
    // 探测失败按 0 处理：探测只是择优，失败不该影响主流程
  } finally {
    clearTimeout(deadline)
    attempt.dispose()
  }
  const seconds = Math.max(0.2, (Date.now() - startedAt) / 1000)
  return bytes / seconds
}

interface PumpTask {
  res: Response
  savePath: string
  offset: number
  total: number | null
  /** release API 给出的安装包字节数：源不给 Content-Length 时用它兜底校验完整性 */
  expectedSize: number | null
  /** 是否允许「持续低速即中止换源」；竞速已证明当前源最快时关掉，只保留硬卡死保护 */
  watchdog: boolean
  ctrl: AbortController
  external: AbortSignal
  onProgress: (payload: UpdaterProgress) => void
}

interface PumpResult {
  status: 'completed' | 'stalled' | 'failed' | 'aborted'
  received: number
  speed: number
  error?: unknown
}

/**
 * 把响应体写进文件，并在过程中做进度上报与看门狗判定。
 * 失败/中止时不删除文件：已写入的字节是有效的，换源后按 Range 续传。
 */
async function pumpToFile(task: PumpTask): Promise<PumpResult> {
  let received = task.offset
  const startedAt = Date.now()
  let lastDataAt = startedAt
  let lastCheckAt = startedAt
  let lastEmit = 0
  let stalled = false
  let starved = false
  const samples: Array<{ t: number; n: number }> = [{ t: startedAt, n: received }]

  const speedOver = (windowMs: number): number => {
    const now = Date.now()
    const cutoff = now - windowMs
    let base = samples[0]
    for (const sample of samples) {
      if (sample.t <= cutoff) base = sample
      else break
    }
    const elapsed = now - base.t
    // 窗口还没铺满（刚起步、刚换源）时不做除法：极短时间里的第一块数据
    // 会被放大成一个假的高速度，界面上看着像突然起飞
    if (elapsed < MIN_SPEED_WINDOW_MS) return 0
    return ((received - base.n) / elapsed) * 1000
  }

  const sample = (now: number) => {
    samples.push({ t: now, n: received })
    if (samples.length > 64) samples.shift()
  }

  /**
   * 看门狗评估，每秒一次：
   * - 硬卡死（长时间零数据）任何情况下都中止，即使已经关掉低速中止；
   * - 持续低速只在 watchdog 打开时中止换源。
   * 注意「有数据但很慢」是最常见的情形（大陆直连 GitHub 约 270KB/s），
   * 所以这个评估必须在数据到达的路径上跑，不能只挂在读超时分支里。
   */
  const evaluate = (now: number) => {
    lastCheckAt = now
    sample(now)
    if (now - lastDataAt >= HARD_STALL_MS) {
      starved = true
      task.ctrl.abort()
      return
    }
    if (
      task.watchdog &&
      now - startedAt >= SLOW_WINDOW_MS &&
      speedOver(SLOW_WINDOW_MS) < SLOW_BPS &&
      (task.total === null || received < task.total * SWITCH_TAIL_RATIO)
    ) {
      stalled = true
      task.ctrl.abort()
    }
  }

  let handle: fs.promises.FileHandle | null = null
  let iterator: AsyncIterator<Uint8Array> | null = null

  try {
    handle = await fs.promises.open(task.savePath, task.offset > 0 ? 'a' : 'w')
    iterator = Readable.fromWeb(task.res.body as any)[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>
    let pending = iterator.next() as Promise<IteratorResult<Uint8Array>>

    for (;;) {
      const chunk = await raceWithTimeout(pending, WATCH_TICK_MS)
      const now = Date.now()

      if (chunk === TIMEOUT) {
        // 这一拍没有数据（pending 保持，数据到了立刻续上）
        evaluate(now)
        continue
      }

      if (chunk.done) {
        // 流「干净结束」也要对账：源不给 Content-Length 时，被截断的连接同样会正常 end，
        // 不比对长度就会把半截安装包当成功（后面 chmod、发 done、清理旧包一路照做）
        const expected = task.total ?? task.expectedSize ?? null
        if (expected === null) {
          // 一点长度依据都没有（源不给、release API 没给、Range 探测也失败）：
          // 无法判断完整性，只能如实失败——「下到一半」绝不能当成功
          return {
            status: 'failed',
            received,
            speed: speedOver(SLOW_WINDOW_MS),
            error: auroraError('desktop.error.updater.integrityUnknown'),
          }
        }
        if (received !== expected) {
          return {
            status: 'failed',
            received,
            speed: speedOver(SLOW_WINDOW_MS),
            error: auroraError('desktop.error.updater.incomplete', { received, expected }),
          }
        }
        break
      }

      const buffer = chunk.value
      lastDataAt = now
      const { bytesWritten } = await handle.write(buffer)
      received += bytesWritten
      if (bytesWritten !== buffer.length) {
        // 短写会让内存计数超出文件实际长度，下次换源的 Range 起点就会错位
        throw auroraError('desktop.error.updater.diskWriteFailed')
      }

      if (now - lastEmit >= 200) {
        lastEmit = now
        sample(now)
        const speed = speedOver(2000)
        task.onProgress({ received, total: task.total, speed: speed > 0 ? speed : null })
      }
      if (now - lastCheckAt >= WATCH_TICK_MS) evaluate(now)

      pending = iterator.next() as Promise<IteratorResult<Uint8Array>>
    }

    task.onProgress({ received, total: task.total, speed: null })
    return { status: 'completed', received, speed: 0 }
  } catch (err) {
    const speed = speedOver(SLOW_WINDOW_MS)
    if (starved) {
      return { status: 'failed', received, speed, error: auroraError('desktop.error.updater.stalled') }
    }
    if (stalled) return { status: 'stalled', received, speed }
    if (task.external.aborted) return { status: 'aborted', received, speed }
    return { status: 'failed', received, speed, error: err }
  } finally {
    // 每条退出路径都要放掉句柄与读取端：否则换源重试会持续泄漏 fd 与半开的流
    if (handle) {
      try {
        await handle.close()
      } catch {
        // 关闭失败不影响结果判定
      }
    }
    if (iterator && typeof iterator.return === 'function') {
      try {
        await iterator.return()
      } catch {
        // 已经结束的流会直接返回
      }
    }
  }
}

/** 并发探测候选源，挑出明显快于当前速度的那个；没有值得换的就返回 null */
async function pickFasterSource(urls: string[], currentSpeed: number, signal: AbortSignal): Promise<string | null> {
  const probed = await Promise.all(urls.map(async (url) => ({ url, speed: await probeSpeed(url, signal) })))
  probed.sort((a, b) => b.speed - a.speed)
  const best = probed[0]
  // 只有「明显更快」才值得中途换源：重连并重新协商 Range 本身有成本
  const floor = Math.max(currentSpeed * 1.5, SLOW_BPS)
  return best && best.speed > floor ? best.url : null
}

interface InstallerDownloadTask {
  candidates: string[]
  savePath: string
  signal: AbortSignal
  onProgress: (payload: UpdaterProgress) => void
  onRoute: (route: UpdaterRoute) => void
  /** release API 给出的安装包字节数，用于最终完整性校验（源不给长度头时是唯一依据） */
  expectedSize?: number | null
  /** release API 给出的 sha256 摘要（小写 hex），下载完成后端到端校验内容 */
  expectedDigest?: string | null
}

/** 文件当前实际字节数：换源续传以它为准，内存计数只作参考 */
function fileSizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** 复用同一把续传/校验逻辑的摘要计算：端到端比对，能发现「长度对但内容错」的坏包 */
async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** 归一化 sha256 摘要：接受 `sha256:<64 位十六进制>` 或裸 hex，其它一律丢弃 */
function normalizeDigest(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  const prefixed = /^sha256:([0-9a-f]{64})$/.exec(raw)
  if (prefixed) return prefixed[1]
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null
}

/**
 * 多源下载主循环：按序尝试候选源，遇到低速/卡死时主动换源并用 Range 续传。
 * 返回最终写入的字节数。
 */
export async function downloadInstaller(task: InstallerDownloadTask): Promise<number> {
  const route = await describeRoute(task.candidates[0])
  task.onRoute(route)
  console.log(`[Updater] 下载线路：${route.label}，候选源 ${task.candidates.length} 个`)

  const expectedSize = typeof task.expectedSize === 'number' && task.expectedSize > 0 ? task.expectedSize : null
  const expectedDigest = normalizeDigest(task.expectedDigest)
  const queue = [...task.candidates]
  // 竞速证明「已经是最快」的源：放回队列重试时关掉低速中止，避免来回横跳
  const settled = new Set<string>()
  let received = 0
  // 已知的完整包长度：先信 release API，任何一条响应给出可信长度就覆盖它
  let knownTotal: number | null = expectedSize
  let probedTotal = false
  let racesLeft = MAX_RACES
  let lastError: unknown = null

  while (queue.length) {
    const url = queue.shift() as string
    const attempt = deriveAbort(task.signal)
    try {
      // 以磁盘上的实际字节数为权威偏移：写失败/短写会让内存计数与文件脱节，
      // 拿它当 Range 起点就会出现「中间缺一段、总长看着刚好」的坏包
      received = fileSizeOf(task.savePath)
      const opened = await openResponse(url, received, attempt.ctrl, knownTotal)
      if (!opened.trusted) {
        // 206 却说不清从哪开始发：宁可换源，也不拿「可能是后半段」的数据去拼文件
        try {
          await opened.res.body?.cancel()
        } catch {
          // 直接丢弃这条响应
        }
        console.log('[Updater] 源返回 206 但无法确认数据起点，改用下一个源')
        lastError = auroraError('desktop.error.updater.rangeUnknown')
        continue
      }
      let offset = received
      if (!opened.resumed && offset > 0) {
        // 这条源没按 offset 续传（不支持 Range，或回了 206 却从头发数据）：
        // 只能从头下，先丢掉已写入的部分
        offset = 0
        try {
          fs.truncateSync(task.savePath, 0)
        } catch {
          // 截断失败会在写入时暴露，交给外层报错
        }
      }
      if (opened.total !== null) knownTotal = opened.total
      // 响应与 release 都没给出长度时，用一次 Range 探测问出总长：没有长度就没法
      // 区分「流干净结束」和「被截断」，最终对账会失效
      if (knownTotal === null && !probedTotal) {
        probedTotal = true
        const probed = await probeTotalSize(url, attempt.ctrl)
        if (probed !== null) {
          knownTotal = probed
          console.log(`[Updater] 源未提供长度，Range 探测得到总长 ${probed} 字节`)
        }
      }

      const outcome = await pumpToFile({
        res: opened.res,
        savePath: task.savePath,
        offset,
        total: knownTotal,
        expectedSize,
        watchdog: !settled.has(url),
        ctrl: attempt.ctrl,
        external: task.signal,
        onProgress: task.onProgress,
      })
      received = outcome.received

      if (outcome.status === 'completed') {
        if (expectedDigest) {
          const actual = await sha256Of(task.savePath)
          if (actual !== expectedDigest) {
            // 长度对得上但内容不是官方那份：多半是中转源改写/损坏，丢弃后换个源重下
            console.error(`[Updater] 摘要不匹配：期望 ${expectedDigest.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
            try {
              fs.rmSync(task.savePath, { force: true })
            } catch {
              // 删不掉会在下一次写入时被截断覆盖
            }
            lastError = auroraError('desktop.error.updater.digestMismatch')
            continue
          }
          console.log('[Updater] 安装包摘要校验通过')
        }
        return received
      }
      if (outcome.status === 'aborted') throw auroraError('desktop.error.updater.canceled')

      if (outcome.status === 'stalled' && racesLeft > 0 && queue.length) {
        console.log(
          `[Updater] 当前源过慢（${(outcome.speed / 1024).toFixed(0)} KB/s，已下 ${(received / 1048576).toFixed(2)} MB），竞速探测 ${Math.min(queue.length, MAX_PROBE_SOURCES)} 个候选源` // i18n-exempt: 开发者日志，不进界面
        )
        const faster = await pickFasterSource(queue.slice(0, MAX_PROBE_SOURCES), outcome.speed, task.signal)
        if (faster) {
          racesLeft--
          // 把选中的源提到队首：它在队列里的原位置要一并摘掉，避免同一源被排两次
          const at = queue.indexOf(faster)
          if (at >= 0) queue.splice(at, 1)
          queue.unshift(faster)
          console.log(`[Updater] 换到更快的源继续下载：${faster.slice(0, 80)}`)
          continue
        }
        console.log('[Updater] 没有更快的源，继续用当前源下载（关闭低速中止，仅保留卡死保护）')
      }

      if (outcome.status === 'stalled') {
        // 没有更快的源：退回当前源接着下，关掉低速中止（硬卡死保护仍在）
        settled.add(url)
        queue.unshift(url)
        continue
      }

      lastError = outcome.error ?? auroraError('desktop.error.updater.interrupted')
    } catch (err) {
      lastError = err
      if (task.signal.aborted) throw auroraError('desktop.error.updater.canceled')
      // 建连失败/HTTP 错误：换下一个候选源
    } finally {
      attempt.dispose()
    }
  }

  // 换源全败：把最后一条失败原因渲染成当前语言的成品句作为 {detail}，嵌进外层整句；
  // 一条可读原因都没有时才用通用兜底
  const detail = lastError === null || lastError === undefined ? '' : mainErrorText(lastError)
  throw detail
    ? auroraError('desktop.error.updater.downloadFailed', { detail })
    : auroraError('desktop.error.updater.downloadFailedGeneric')
}

// ───────────────────────── IPC ─────────────────────────

/**
 * 向窗口发送事件的安全封装：handlers.ts 里的 sendToRenderer 是模块私有，
 * 这里由 registerUpdaterIpc 注入主窗口引用。
 */
let send: (channel: string, ...args: unknown[]) => void = () => {}

export function registerUpdaterIpc(sender: (channel: string, ...args: unknown[]) => void) {
  send = sender

  ipcMain.handle('updater:download', async (_event, url: unknown, kind: unknown, altUrls: unknown, expectedSize: unknown, expectedDigest: unknown) => {
    const candidates = normalizeDownloadUrls(url, altUrls)
    if (!candidates.length) throw auroraError('desktop.error.common.urlInvalid')
    if (typeof kind !== 'string' || !INSTALLER_KINDS.has(kind)) {
      throw auroraError('desktop.error.updater.kindInvalid')
    }
    if (activeAbort) throw auroraError('desktop.error.updater.busy')

    const abort = new AbortController()
    activeAbort = abort
    // 文件名统一按 GitHub 官方原始链接推导：加速链接的 pathname 同样是原始链接
    const savePath = uniquePath(downloadDir(), fileNameFromUrl(candidates[0], kind))

    try {
      await downloadInstaller({
        candidates,
        savePath,
        signal: abort.signal,
        expectedSize: typeof expectedSize === 'number' && expectedSize > 0 ? expectedSize : null,
        expectedDigest: normalizeDigest(expectedDigest),
        onProgress: (payload) => send('updater:progress', payload),
        onRoute: (route) => send('updater:route', route),
      })

      // AppImage 需要可执行权限才能运行
      if (kind === 'appimage') {
        try {
          fs.chmodSync(savePath, 0o755)
        } catch {
          // 权限设置失败不阻断，用户可手动 chmod +x
        }
      }

      cleanupOldArtifacts(downloadDir(), savePath)
      send('updater:done', { filePath: savePath, kind })
      return { filePath: savePath }
    } catch (err) {
      // 失败时清理残留的部分文件
      try {
        fs.rmSync(savePath, { force: true })
      } catch {
        // 忽略
      }
      if (abort.signal.aborted) {
        throw auroraError('desktop.error.updater.canceled')
      }
      console.error('[Updater] 下载失败:', err)
      // updater:error 的 message 由渲染层直接上屏（只做透传，不会再解码），
      // 所以这里渲染成当前语言的成品句；reject 侧换成结构化错误，由渲染层
      // translateError 按语言渲染（外层整句 + 内层原因）
      const message = err === null || err === undefined
        ? mainTranslate()('desktop.error.updater.downloadFailedGeneric')
        : mainErrorText(err)
      send('updater:error', message)
      throw auroraError('desktop.error.updater.downloadFailed', { detail: message })
    } finally {
      // 只回收自己这个任务：取消后立刻重下时，不能把新任务的锁清掉
      if (activeAbort === abort) activeAbort = null
    }
  })

  ipcMain.handle('updater:cancel', () => {
    const abort = activeAbort
    // 先摘锁再中止：否则取消后马上点重试会撞上「已有更新下载在进行中」，被渲染层显示成一次报错
    activeAbort = null
    abort?.abort()
  })

  // 在文件管理器中定位已下载的安装包
  ipcMain.handle('updater:reveal', (_event, filePath: unknown) => {
    if (typeof filePath === 'string' && path.isAbsolute(filePath) && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath)
    }
  })

  ipcMain.handle('updater:install', async (_event, filePath: unknown, kind: unknown) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
      throw auroraError('desktop.error.updater.installerMissing')
    }
    if (typeof kind !== 'string' || !INSTALLER_KINDS.has(kind)) {
      throw auroraError('desktop.error.updater.kindInvalid')
    }

    if (kind === 'exe') {
      // Windows NSIS 安装器：启动后由向导接管，当前实例退出避免占用文件
      shell.openPath(filePath).then((err) => {
        if (err) console.error('[Updater] 启动安装器失败:', err)
        else app.quit()
      })
      return { action: 'launched' as const }
    }

    if (kind === 'appimage') {
      // AppImage 无法原地覆盖：退出当前应用，用户运行新文件即完成「更新」
      try {
        fs.chmodSync(filePath, 0o755)
      } catch {
        // 忽略
      }
      const err = await shell.openPath(filePath)
      if (err) {
        throw auroraError('desktop.error.updater.launchFailed', { detail: err })
      }
      app.quit()
      return { action: 'launched' as const }
    }

    if (kind === 'deb' || kind === 'rpm') {
      // deb/rpm 覆盖安装需要 root，GUI 应用无法安全提权：
      // 打开系统终端并自动填入安装命令，用户确认密码即可
      const cmd =
        kind === 'deb'
          ? `sudo apt install -y '${filePath}'`
          : `sudo dnf install -y '${filePath}' || sudo rpm -Uvh '${filePath}'`
      const opened = await openTerminalWithCommand(cmd)
      if (!opened) {
        throw auroraError('desktop.error.updater.terminalFailed', { command: cmd })
      }
      return { action: 'terminal' as const, command: cmd }
    }

    if (kind === 'dmg') {
      // macOS：dmg 无法原地覆盖安装（App 在 /Applications 里运行中，替换需用户拖拽）。
      // 挂载 dmg 并让 Finder 显示，用户把 Aurora Music 拖进「应用程序」即完成更新；
      // 不退出当前实例——用户可能还想继续听，且退出会让拖拽替换更难操作。
      const err = await shell.openPath(filePath)
      if (err) {
        throw auroraError('desktop.error.updater.openFailed', { detail: err })
      }
      return { action: 'mounted' as const }
    }

    // apk 等：下载即完成，安装由系统在文件管理器中引导
    return { action: 'none' as const }
  })
}

/**
 * 打开系统终端并预填命令（不自动执行，sudo 密码必须由用户亲手输入）。
 * 常见终端依次探测；都找不到时返回 false。
 */
async function openTerminalWithCommand(cmd: string): Promise<boolean> {
  const { spawn } = await import('child_process')

  const attempts: Array<{ bin: string; args: string[] }> = [
    // GNOME Terminal：-- 之后整段作为 sh -c 的命令
    { bin: 'gnome-terminal', args: ['--', 'bash', '-c', cmd] },
    // Konsole / XFCE：-e 直接接命令
    { bin: 'konsole', args: ['-e', cmd] },
    { bin: 'xfce4-terminal', args: ['-e', cmd] },
    // xterm 兜底
    { bin: 'xterm', args: ['-e', cmd] },
  ]

  for (const { bin, args } of attempts) {
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
      const failed = await new Promise<boolean>((resolve) => {
        child.once('error', () => resolve(true))
        // spawn 成功但二进制不存在会立刻触发 error；给 300ms 判定窗口
        setTimeout(() => resolve(false), 300)
        child.unref()
      })
      if (!failed) return true
    } catch {
      // 试下一个候选终端
    }
  }
  return false
}

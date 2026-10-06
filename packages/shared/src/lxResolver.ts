/**
 * 洛雪脚本音源的「曲目定位 → 直链」编排层
 *
 * 洛雪脚本的 `musicUrl` 只吃脚本自己定义的 `musicInfo` 字段名，各平台差异很大；
 * 且脚本源的搜索结果有两类来源：
 *   1) 脚本自带的 search / musicSearch（如幻音咪咕、全豆要汽水）：返回的原始条目**本来
 *      就是脚本自己的字段名**，原样回喂即可，不需要映射；
 *   2) 本应用自己的搜索（aurora 音源服务）：只有通用元信息（title/artist/album/id…），
 *      必须按平台映射成脚本字段才能取址。
 * 本模块只做这两件事的归一化 + 取址编排，具体脚本执行仍由 lxHost 负责。
 *
 * 平台字段差异（**本机对真实脚本实测确认，勿凭直觉改**）：
 *   - 酷我 kw：huibq 脚本读 `musicInfo.hash ?? musicInfo.songmid`；实测只给 songmid 就能
 *     拿到 bd-*.kuwo.cn 直链（酷我侧 hash 与 songmid 同源），两者都写最稳；
 *   - 酷狗 kg：同为 hash / songmid，实测同样两者都写；
 *   - QQ tx：songmid（脚本按它拼 vkey 取址请求）；
 *   - 网易 wy：脚本普遍读 songmid，不同脚本字段名略有出入，故 songmid / id 都写；
 *   - 咪咕 mg：幻音脚本走 xcvts API 按「歌名 + 歌手」搜索取址，**不需要任何 id**，
 *     字段名是 name / singer / albumName —— 这是唯一「无 id 也能取址」的平台。
 *
 * 缺字段策略：映射不出必要字段就返回失败并带原因，**绝不猜一个 id 硬发请求**。
 */

import { getLxHostDeps, resolveLxSourceUrl, searchLxSource, type LxHostDeps, type LxScriptSource } from './lxHost'
import type {
  DownloadQuality,
  LxTrackRef,
  OnlineSourceConfig,
  OnlineTrackSearchResult,
} from './types'

/** 聚合搜索时单源返回条数上限（与 lxHost.searchLxSource 默认口径一致） */
export const LX_SEARCH_LIMIT = 30

// ─── 脚本源码供应 ─────────────────────────────────────────────────

/**
 * 洛雪脚本源码供应器：平台侧注册一次（桌面端可取主进程缓存的脚本，移动端取本地缓存）。
 * 聚合搜索 / 取址在需要执行脚本时按源配置取源码。
 * 与 lxHost 一样，函数无法经 IPC 序列化，因此只能由「发起调用的那一侧」注册。
 */
export type LxScriptProvider = (
  source: OnlineSourceConfig
) => string | null | undefined | Promise<string | null | undefined>

let scriptProvider: LxScriptProvider | null = null

/** 注册 / 清空脚本源码供应器（音源配置变更后建议重新注册） */
export function setLxScriptProvider(fn: LxScriptProvider | null): void {
  scriptProvider = fn
}

/** 取当前脚本源码供应器（未注册返回 null） */
export function getLxScriptProvider(): LxScriptProvider | null {
  return scriptProvider
}

/**
 * 取一条 lx 源的脚本源码，两路来源依次尝试：
 *   1) 配置对象上运行时自带的 `script` 字段（主进程 enrich / 测试内联脚本走这条）；
 *   2) 平台注册的供应器（渲染层 / 移动端走这条）。
 * 都拿不到返回 null —— 调用方据此跳过该源并给出可读告警，绝不静默失败。
 */
export async function resolveLxScript(source: OnlineSourceConfig): Promise<string | null> {
  const inline = (source as LxScriptSource).script
  if (typeof inline === 'string' && inline.trim()) return inline
  const provider = scriptProvider
  if (!provider) return null
  try {
    const text = await provider(source)
    if (typeof text === 'string' && text.trim()) return text
  } catch {
    /* 供应器失败按「拿不到脚本」处理 */
  }
  return null
}

/** 组装可执行的洛雪音源（补齐 script）；取不到脚本返回 null */
export async function asLxScriptSource(source: OnlineSourceConfig): Promise<LxScriptSource | null> {
  const script = await resolveLxScript(source)
  return script ? { ...source, script } : null
}

// ─── 平台字段规格 ─────────────────────────────────────────────────

interface LxPlatformSpec {
  /**
   * 脚本取址用的标识字段候选名（按优先级）。映射时把**同一个真实值**写入全部候选名——
   * 脚本生态里同一平台不同脚本读的字段名不统一，写全比猜一个更稳。
   */
  idFields: string[]
  /** 是否必须带「歌名 + 歌手」（按名搜索取址的脚本，如幻音咪咕） */
  needName: boolean
  /** 报错信息里用的中文平台名 */
  label: string
}

const LX_PLATFORM_SPECS: Record<string, LxPlatformSpec> = {
  kw: { idFields: ['hash', 'songmid'], needName: false, label: '酷我' },
  kg: { idFields: ['hash', 'songmid'], needName: false, label: '酷狗' },
  tx: { idFields: ['songmid', 'mid'], needName: false, label: 'QQ' },
  wy: { idFields: ['songmid', 'id'], needName: false, label: '网易' },
  // 咪咕：幻音脚本按歌名 + 歌手搜索取址，不需要 id
  mg: { idFields: [], needName: true, label: '咪咕' },
  git: { idFields: ['id', 'songmid'], needName: false, label: 'Git' },
  local: { idFields: ['id'], needName: false, label: '本地' },
}

/** 未知平台兜底：脚本生态里最常见的标识字段名，给了就试，没有就报缺字段 */
const LX_FALLBACK_SPEC: LxPlatformSpec = {
  idFields: ['songmid', 'hash', 'id', 'mid', 'rid', 'copyrightId'],
  needName: false,
  label: '未知平台',
}

/** 脚本曲目对象里可直接当标识用的字段名（判断一份 meta 是否已能直接回喂脚本） */
const LX_META_ID_ALIASES = ['songmid', 'hash', 'id', 'mid', 'rid', 'copyrightId', 'songId']

function specOf(platform: string): LxPlatformSpec {
  return LX_PLATFORM_SPECS[String(platform || '').trim().toLowerCase()] || LX_FALLBACK_SPEC
}

function textOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  const s = String(v).trim()
  return s
}

function numOf(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ─── 元信息 → 脚本字段 ────────────────────────────────────────────

/** 映射结果：成功给出可直接喂脚本的 musicInfo；失败给出原因与缺失字段 */
export type LxMetaMapping =
  | { ok: true; musicInfo: Record<string, unknown> }
  | { ok: false; reason: string; missing: string[] }

/**
 * 把通用元信息映射成脚本 `musicUrl` 需要的字段名。
 *
 * 入参字段（宽容兼容脚本自己的命名）：
 *   title / name / songName、artist / singer / artists、album / albumName、
 *   duration / interval、id / songmid / hash / mid / rid / copyrightId。
 * 缺少平台必要字段时返回 `ok:false` 与原因，调用方据此**不发请求**。
 */
export function toLxMusicInfo(
  platform: string,
  meta: Record<string, unknown> | null | undefined
): LxMetaMapping {
  const key = String(platform || '').trim().toLowerCase()
  const spec = specOf(key)
  const src = (meta || {}) as Record<string, unknown>

  const title = textOf(src.title ?? src.name ?? src.songName)
  const artist = textOf(src.artist ?? src.singer ?? src.artists)
  const album = textOf(src.album ?? src.albumName)
  const duration = numOf(src.duration ?? src.interval)

  const musicInfo: Record<string, unknown> = {}
  if (title) {
    musicInfo.name = title
    musicInfo.title = title
  }
  if (artist) {
    musicInfo.singer = artist
    musicInfo.artist = artist
  }
  if (album) {
    musicInfo.albumName = album
    musicInfo.album = album
  }
  if (duration > 0) {
    musicInfo.interval = duration
    musicInfo.duration = duration
  }

  // 标识值：先按平台候选字段名从入参里找现成的，其次用通用 id / hash
  let idValue = ''
  for (const field of spec.idFields) {
    const v = textOf(src[field])
    if (v) {
      idValue = v
      break
    }
  }
  if (!idValue) idValue = textOf(src.id) || textOf(src.hash)
  if (idValue) {
    for (const field of spec.idFields.length > 0 ? spec.idFields : LX_FALLBACK_SPEC.idFields) {
      musicInfo[field] = idValue
    }
  }

  const missing: string[] = []
  if (spec.idFields.length > 0 && !idValue) missing.push(...spec.idFields)
  if (spec.needName) {
    if (!title) missing.push('name')
    if (!artist) missing.push('singer')
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${spec.label}(${key}) 取址缺少必要字段：${missing.join(' / ')}`,
      missing,
    }
  }
  return { ok: true, musicInfo }
}

/**
 * 一份 meta 是否已经能直接回喂脚本（脚本自带 search 返回的原始条目就是这种）。
 * 判定只做「有没有脚本要的字段」这一件事，不校验字段值是否真实存在。
 */
export function isUsableLxMeta(
  platform: string,
  meta: Record<string, unknown> | null | undefined
): boolean {
  if (!meta || typeof meta !== 'object') return false
  const spec = specOf(platform)
  const hasName =
    !!textOf(meta.name ?? meta.title ?? meta.songName) &&
    !!textOf(meta.singer ?? meta.artist ?? meta.artists)
  // 按名搜索取址的平台（幻音咪咕）：有歌名 + 歌手就够，缺 id 无妨
  if (spec.needName) return hasName
  return LX_META_ID_ALIASES.some((field) => !!textOf(meta[field]))
}

// ─── 取址编排 ─────────────────────────────────────────────────────

export interface ResolveLxTrackInput {
  /** 曲目定位信息（搜索结果条目上的 lx 字段） */
  lx: LxTrackRef
  /**
   * 通用元信息：条目来自 aurora 音源（而非脚本自带 search）时用来映射脚本字段。
   * meta 本身已带脚本字段（脚本 search 的原始条目）时可不传。
   */
  meta?: Record<string, unknown> | null
  /** 源配置；未传时从 sources 里按 lx.sourceId 匹配 */
  onlineSource?: OnlineSourceConfig
  /** 候选源列表（多源场景下按 id 定位脚本） */
  sources?: OnlineSourceConfig[]
  /** 目标音质（缺省 128） */
  quality?: DownloadQuality
  /** 宿主依赖；未传回落到全局注册（setLxHostDeps） */
  deps?: LxHostDeps | null
}

/** 取址结果：成功给直链与**实际取到的档位**；失败给 null 地址与原因（绝不抛错） */
export type LxResolveOutcome = { url: string; quality: string } | { url: null; reason: string }

/**
 * 「搜索结果 → 直链」编排：定位脚本 → 归一化 musicInfo → 交给脚本取址。
 * 任何环节失败都返回 `{ url: null, reason }`，不抛错，UI 可据此提示「需在平台上手动指定」。
 */
export async function resolveLxTrack(input: ResolveLxTrackInput): Promise<LxResolveOutcome> {
  const ref = input?.lx
  if (!ref || !ref.sourceId || !ref.platform) {
    return { url: null, reason: '曲目缺少洛雪取址定位信息（lx）' }
  }

  const source =
    input.onlineSource ||
    (input.sources || []).find((s) => s && s.id === ref.sourceId) ||
    null
  if (!source) {
    return { url: null, reason: `未找到洛雪音源配置（id=${ref.sourceId}）` }
  }
  if (source.kind !== 'lx') {
    return { url: null, reason: `音源「${source.name}」不是洛雪脚本源（kind=${source.kind || 'aurora'}）` }
  }
  if (!source.enabled) {
    return { url: null, reason: `洛雪音源「${source.name}」已停用` }
  }

  const scriptSource = await asLxScriptSource(source)
  if (!scriptSource) {
    return { url: null, reason: `洛雪音源「${source.name}」的脚本源码不可得（未内联且无脚本供应器）` }
  }

  const rawMeta = (ref.meta || {}) as Record<string, unknown>
  let musicInfo = rawMeta
  if (!isUsableLxMeta(ref.platform, rawMeta)) {
    const mapped = toLxMusicInfo(ref.platform, (input.meta || rawMeta) as Record<string, unknown>)
    if (!mapped.ok) return { url: null, reason: mapped.reason }
    musicInfo = mapped.musicInfo
  }

  const deps = input.deps ?? getLxHostDeps()
  if (!deps || typeof deps.request !== 'function') {
    return { url: null, reason: '洛雪音源宿主未初始化（缺少 lx.request 实现）' }
  }

  try {
    return await resolveLxSourceUrl(
      scriptSource,
      { ...ref, meta: musicInfo },
      input.quality || '128',
      deps
    )
  } catch (err) {
    return { url: null, reason: (err as Error)?.message || String(err) }
  }
}

/** 便捷封装：只要直链，失败返回 null（UI 判空即可） */
export async function resolveLxTrackUrl(
  input: ResolveLxTrackInput
): Promise<{ url: string; quality: string } | null> {
  const out = await resolveLxTrack(input)
  return out.url ? out : null
}

// ─── 聚合搜索用的单源入口 ─────────────────────────────────────────

/**
 * 聚合搜索的 lx 源分支：脚本自带 search / musicSearch 拿元信息。
 * 条目**不含直链**（audioUrl 为空串），播放 / 下载时再按 lx 定位信息取址。
 * 脚本源码不可得时抛错，由聚合层按「单源失败」处理（不拖垮其它源）。
 */
export async function searchLxSourceForAggregate(
  source: OnlineSourceConfig,
  query: string,
  deps?: LxHostDeps | null
): Promise<OnlineTrackSearchResult[]> {
  const hostDeps = deps ?? getLxHostDeps()
  if (!hostDeps || typeof hostDeps.request !== 'function') {
    throw new Error('洛雪音源宿主未初始化（缺少 lx.request 实现）')
  }
  const scriptSource = await asLxScriptSource(source)
  if (!scriptSource) throw new Error(`洛雪音源「${source.name}」的脚本源码不可得`)
  return await searchLxSource(scriptSource, query, hostDeps, { limit: LX_SEARCH_LIMIT })
}
/**
 * 插件执行器（主进程）。
 *
 * 为什么插件必须在主进程执行：
 * - 渲染层直连上游会被 CORS 拦（在线搜索同理走主进程）；
 * - 汽水实测**带 `Origin` 头请求 API 直接返回 403**，而渲染进程的 fetch 必带 Origin；
 * - 洛雪脚本宿主依赖里含函数，无法经 IPC 序列化，只能在「发起调用的那一侧」装配。
 *
 * 本文件只做三件事：装配注入给插件的 `PluginContext`、把能力调用包成 IPC、
 * 把错误转成可读文案。业务语义在 `@aurora/shared` 的 plugin 层，不在这里。
 *
 * ## 凭证边界
 *
 * 渲染层**永远拿不到凭证原文**：`plugin:authState` 只回状态，凭证的读写只在主进程
 * 经 `pluginCredentials.ts`（safeStorage 加密）完成。
 */

import { ipcMain } from 'electron'
import {
  auroraError,
  getPlugin,
  listPlugins,
  type OnlineSourceConfig,
  type PluginCredential,
  type PluginPlaylist,
  type ResolvedAudio,
  type SourcePlugin,
  type SourceTrackRef,
  type OnlineTrackSearchResult,
  type DownloadQuality,
} from '@aurora/shared'
import { mainErrorText } from '../i18n'
import {
  clearPluginCredential,
  hasPluginCredential,
  isCredentialEncryptionAvailable,
  readPluginCredential,
  savePluginCredential,
} from './pluginCredentials'
import { guardedFetchOf } from '@aurora/shared'

/** 与各插件内部的超时保持同一量级；插件自己也带 AbortController */
const DEFAULT_TIMEOUT_MS = 20000

/**
 * 插件的网络实现：**已安装插件受其清单 `hosts` 白名单约束**。
 *
 * 内置插件的请求目标由我们审过，直接给全局 fetch（Node 内置实现 **不带 Origin**，
 * 这正是汽水 API 能通的关键，不要在这里加 Referer/Origin）。
 *
 * 已安装插件是第三方写的清单，`hosts` 是它的承诺，而承诺靠自觉不算数：越界请求必须
 * **不发出**。`guardedFetchOf` 就是这个包装，未被安装的 id 返回 undefined 即回落全局。
 *
 * 这层必须落在**构造 ctx 的唯一入口**上（本函数 + 下面三处登录态 ctx），
 * 否则「插件只依赖注入的 fetch」这条契约就漏了：插件换一个调用点就绕过了白名单。
 *
 * `configuredUrl` 是 `configured-origin` 形态的判定依据 —— 见 `guardedFetchOf`
 * 的注释：漏传会让那类插件被自己的白名单全拒。拿不到配置的通道（登录态）传 undefined。
 */
function pluginFetchOf(
  pluginId: string,
  config?: OnlineSourceConfig | null
): typeof globalThis.fetch {
  return guardedFetchOf(pluginId, config?.sourceUrl) ?? globalThis.fetch
}

/**
 * 装配插件执行上下文。
 *
 * `fetch` 见 `pluginFetchOf()`：内置插件用全局实现，已安装插件包主机白名单。
 */
function buildContext(
  plugin: SourcePlugin,
  config: OnlineSourceConfig | null
): Record<string, unknown> | never {
  const credential = plugin.id ? readCredentialOf(plugin.id) : null
  return {
    fetch: pluginFetchOf(plugin.id, config),
    headers: config?.headers,
    credential,
  }
}

/** 读凭证（未登录为 null）。损坏的密文由 readPluginCredential 自行清理 */
function readCredentialOf(pluginId: string): PluginCredential | null {
  const payload = readPluginCredential(pluginId)
  if (!payload) return null
  return { pluginId, payload, savedAt: 0 }
}

/** 插件 id 校验：IPC 入参来自渲染层，按不可信处理 */
function requirePlugin(pluginId: unknown): SourcePlugin {
  if (typeof pluginId !== 'string' || !pluginId) {
    throw auroraError('desktop.error.plugin.invalidId', { id: String(pluginId ?? '') })
  }
  const plugin = getPlugin(pluginId)
  if (!plugin) throw auroraError('desktop.error.plugin.notFound', { id: pluginId })
  return plugin
}

function requireConfig(config: unknown): OnlineSourceConfig {
  if (!config || typeof config !== 'object') {
    throw auroraError('desktop.error.plugin.configInvalid')
  }
  const c = config as OnlineSourceConfig
  if (typeof c.id !== 'string' || !c.id) throw auroraError('desktop.error.plugin.configInvalid')
  return c
}

/** 带超时的调用包装：插件内部可能忘了设超时，这里兜底 */
async function withTimeout<T>(run: () => Promise<T>, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(auroraError('desktop.error.plugin.timeout', { ms })),
          ms
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function registerPluginIpc(): void {
  // ─── 元信息与能力查询 ──────────────────────────────────────

  /**
   * 列出全部插件的**可展示元信息**（不含任何实现，也不含凭证）。
   * UI 据此渲染「可添加的音源类型」，不再写死两项数组。
   */
  ipcMain.handle('plugin:list', () => {
    return listPluginMeta()
  })

  // ─── 能力调用 ─────────────────────────────────────────────

  /** 探测（设置页「测试」） */
  ipcMain.handle('plugin:probe', async (_event, pluginId: string, config: unknown) => {
    const plugin = requirePlugin(pluginId)
    if (typeof plugin.probe !== 'function') {
      throw auroraError('desktop.error.plugin.capabilityMissing', {
        id: pluginId,
        capability: 'probe',
      })
    }
    const cfg = requireConfig(config)
    try {
      return await withTimeout(() => plugin.probe!(cfg, buildContext(plugin, cfg) as never))
    } catch (err) {
      // 探测结论直接上屏：失败也返回结构化结果，而不是抛给渲染层
      return { ok: false, kind: 'aurora', capabilities: [], error: mainErrorText(err) }
    }
  })

  /** 搜索 */
  ipcMain.handle(
    'plugin:search',
    async (_event, pluginId: string, config: unknown, query: string, quality?: DownloadQuality) => {
      const plugin = requirePlugin(pluginId)
      if (typeof plugin.search !== 'function') return []
      const cfg = requireConfig(config)
      if (typeof query !== 'string' || !query.trim()) return []
      return await withTimeout(() =>
        plugin.search!(cfg, query, quality, buildContext(plugin, cfg) as never)
      )
    }
  )

  /** 惰性取址 */
  ipcMain.handle(
    'plugin:resolveTrack',
    async (_event, pluginId: string, config: unknown, ref: unknown, quality?: DownloadQuality) => {
      const plugin = requirePlugin(pluginId)
      if (typeof plugin.resolveTrack !== 'function') return null
      const cfg = requireConfig(config)
      if (!ref || typeof ref !== 'object') return null
      return await withTimeout(() =>
        plugin.resolveTrack!(
          cfg,
          ref as SourceTrackRef,
          quality,
          buildContext(plugin, cfg) as never
        )
      )
    }
  )

  /** 列「我的歌单」（需要登录） */
  ipcMain.handle('plugin:userPlaylists', async (_event, pluginId: string, config: unknown) => {
    const plugin = requirePlugin(pluginId)
    if (typeof plugin.listUserPlaylists !== 'function') {
      throw auroraError('desktop.error.plugin.capabilityMissing', {
        id: pluginId,
        capability: 'userPlaylists',
      })
    }
    const cfg = requireConfig(config)
    return await withTimeout(() =>
      plugin.listUserPlaylists!(cfg, buildContext(plugin, cfg) as never)
    )
  })

  /** 取歌单内曲目 */
  ipcMain.handle(
    'plugin:playlistTracks',
    async (_event, pluginId: string, config: unknown, playlistId: string) => {
      const plugin = requirePlugin(pluginId)
      if (typeof plugin.getPlaylistTracks !== 'function') return []
      const cfg = requireConfig(config)
      if (typeof playlistId !== 'string' || !playlistId) return []
      return await withTimeout(() =>
        plugin.getPlaylistTracks!(cfg, playlistId, buildContext(plugin, cfg) as never)
      )
    }
  )

  // ─── 登录（凭证只在主进程持有） ────────────────────────────

  /**
   * 保存凭证。
   *
   * 入参是**用户粘贴的文本**（如整串 Cookie），由插件自己解析出 `sessionid`；
   * 解析与校验都在主进程完成，渲染层拿不到中间产物。
   */
  ipcMain.handle('plugin:login', async (_event, pluginId: string, rawInput: string) => {
    const plugin = requirePlugin(pluginId)
    if (typeof plugin.login !== 'function') {
      throw auroraError('desktop.error.plugin.capabilityMissing', {
        id: pluginId,
        capability: 'auth',
      })
    }
    if (typeof rawInput !== 'string' || !rawInput.trim()) {
      throw auroraError('desktop.error.plugin.credentialInvalid')
    }

    const ctx = {
      fetch: pluginFetchOf(pluginId),
      // login 的入参经 credential.payload.input 传给插件（见 qishuiPlugin.login）
      credential: { pluginId, payload: { input: rawInput }, savedAt: 0 },
    }
    const credential = await withTimeout(() => plugin.login!(ctx as never))

    // 落盘前校验一次：避免存下一份「看着登录了、其实拉不到数据」的凭证
    if (typeof plugin.checkAuth === 'function') {
      const state = await withTimeout(() => plugin.checkAuth!(credential, ctx as never))
      if (state?.valid === false) {
        throw auroraError('desktop.error.plugin.credentialRejected', { id: pluginId })
      }
    }

    savePluginCredential(pluginId, credential.payload)
    return { ok: true }
  })

  /** 查询登录态（**不回凭证原文**） */
  ipcMain.handle('plugin:authState', async (_event, pluginId: string) => {
    const plugin = requirePlugin(pluginId)
    if (!hasPluginCredential(pluginId)) {
      return { loggedIn: false, encryptionAvailable: isCredentialEncryptionAvailable() }
    }
    const credential = readCredentialOf(pluginId)
    if (!credential) {
      return { loggedIn: false, encryptionAvailable: isCredentialEncryptionAvailable() }
    }
    let valid: boolean | undefined
    if (typeof plugin.checkAuth === 'function') {
      try {
        const ctx = { fetch: pluginFetchOf(pluginId), credential }
        const state = await withTimeout(() => plugin.checkAuth!(credential, ctx as never), 10000)
        valid = state?.valid
        return {
          loggedIn: state?.loggedIn !== false,
          valid,
          accountName: state?.accountName,
          encryptionAvailable: isCredentialEncryptionAvailable(),
        }
      } catch {
        // 网络故障与凭证失效无法区分：返回 unknown，UI 不得据此显示「已失效」
        valid = undefined
      }
    }
    return { loggedIn: true, valid, encryptionAvailable: isCredentialEncryptionAvailable() }
  })

  /** 退出登录 */
  ipcMain.handle('plugin:logout', async (_event, pluginId: string) => {
    const plugin = requirePlugin(pluginId)
    const credential = readCredentialOf(pluginId)
    if (typeof plugin.logout === 'function') {
      try {
        await withTimeout(
          () => plugin.logout!({ fetch: pluginFetchOf(pluginId), credential } as never),
          5000
        )
      } catch {
        // 远端登出失败不该阻止本地清凭证：用户的意图是「退出」
      }
    }
    clearPluginCredential(pluginId)
    return { ok: true }
  })
}

/**
 * 插件的可展示元信息。
 *
 * 单独导出是为了让单测能直接断言形状（不经过 IPC），也避免 UI 依赖插件实现对象。
 */
export interface PluginMeta {
  id: string
  displayNameKey: string
  descriptionKey?: string
  version: string
  capabilities: readonly string[]
  /** 该插件是否已保存凭证（只回布尔，不回内容） */
  hasCredential: boolean
}

export function listPluginMeta(): PluginMeta[] {
  return listPlugins().map((plugin) => ({
    id: plugin.id,
    displayNameKey: plugin.displayNameKey,
    descriptionKey: plugin.descriptionKey,
    version: plugin.version,
    capabilities: plugin.capabilities,
    // 只回布尔：凭证原文永不出主进程
    hasCredential: hasPluginCredential(plugin.id),
  }))
}

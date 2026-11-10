import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LanPeerInfo, LanSyncStatus, SyncConfig } from '@aurora/shared'

/**
 * **绝不能进 `settings`（进而进 localStorage）的字段名**。
 *
 * `settings` 整块是 `persist` 的白名单，而渲染层的 localStorage 是明文：写进去等于把
 * 口令/配对码交给任何能读到本机磁盘副本的人（备份、同步盘、同机其它用户）。
 * 这些值只走 `platform.sync.saveCredential`（主进程 safeStorage，§10）。
 */
export const SECRET_SETTING_KEYS = ['password', 'code', 'token', 'secret', 'sessionid'] as const

/** 这个 key 是不是「只许走凭证网关」的秘密字段（大小写不敏感：`Code`/`sessionId` 都算） */
export function isSecretSettingKey(key: string): boolean {
  return SECRET_SETTING_KEYS.includes(key.toLowerCase() as (typeof SECRET_SETTING_KEYS)[number])
}

/** 单条配置的运行时状态（只活在本次会话，不落盘） */
export type SyncRunState = 'idle' | 'running' | 'ok' | 'failed'

/** 一次成功同步的结果摘要（用于卡片上的「上次同步」与 toast） */
export interface SyncRunResult {
  at: number
  added: number
  updated: number
  removed: number
  /** 本次合并结果里的曲目总数（含占位），卡片用于展示规模 */
  trackCount: number
}

export interface SyncConfigRuntime {
  state: SyncRunState
  /** 本次会话最近一次成功的结果（跨会话看 `config.lastSyncAt`） */
  lastResult: SyncRunResult | null
  /**
   * 本次会话最近一次失败的**结构化载荷**（`encodeErrorInfo` 文本），显示端
   * `translateError` 渲染。与 `config.lastError` 的区别：那个是落盘的「上次失败」，
   * 这个是本轮实时状态；两者内容同源，但落盘的那份只在失败/成功时更新。
   */
  lastError: string | null
  /** 退避中：下一次自动重试的时间戳（null = 不在退避） */
  nextRetryAt: number | null
  /**
   * 上次**推给这条配置**的快照内容哈希（不动点判据，验证报告 B-1/N-1）。
   *
   * 只活在本次会话：重启后首轮会多推一次（代价可接受），换来的是「内容没变就不写对端」。
   * null = 本会话还没推过，首轮必须写（否则第一份永远出不去）。
   */
  lastPushedHash: string | null
}

/** 局域网区块的运行时状态（不落盘：服务是否在跑由主进程说了算） */
export interface SyncLanState {
  status: LanSyncStatus | null
  peers: LanPeerInfo[]
  scanning: boolean
}

interface SyncStoreState {
  /** 同步目标配置（**唯一**落盘的部分） */
  configs: SyncConfig[]
  /** 每 config 的运行时状态，键 = config.id */
  runtime: Record<string, SyncConfigRuntime>
  /** 本机设备身份（主进程生成，渲染层只读缓存） */
  device: { deviceId: string; deviceName: string } | null
  lan: SyncLanState

  addConfig: (config: SyncConfig) => void
  updateConfig: (id: string, updates: Partial<Omit<SyncConfig, 'id'>>) => void
  removeConfig: (id: string) => void
  setRuntime: (id: string, patch: Partial<SyncConfigRuntime>) => void
  /** 同步成功：刷 `lastSyncAt`、清 `lastError`、清退避 */
  markSyncOk: (id: string, result: SyncRunResult) => void
  /** 同步失败：写结构化载荷（**绝不含口令**）、记下次重试时间 */
  markSyncFailed: (id: string, errorPayload: string, nextRetryAt: number | null) => void
  setDevice: (device: { deviceId: string; deviceName: string }) => void
  setLanStatus: (status: LanSyncStatus | null) => void
  setLanPeers: (peers: LanPeerInfo[]) => void
  setLanScanning: (scanning: boolean) => void
  /** 记下「这条配置已经推过」的内容哈希（hash 门控，不落盘） */
  markPushed: (id: string, hash: string) => void
}

const EMPTY_RUNTIME: SyncConfigRuntime = {
  state: 'idle',
  lastResult: null,
  lastError: null,
  nextRetryAt: null,
  lastPushedHash: null,
}

/* ------------------------------------------------------------------ *
 * 秘密字段的迁移（历史配置曾经把配对码写进 settings → localStorage）
 * ------------------------------------------------------------------ */

/** 从 settings 里剥掉秘密字段，剥出来的值排队等凭证网关接手 */
interface StrippedSecrets {
  settings: Record<string, unknown>
  secrets: Record<string, string>
}

function stripSecretSettings(settings: Record<string, unknown> | undefined): StrippedSecrets {
  const next: Record<string, unknown> = { ...(settings ?? {}) }
  const secrets: Record<string, string> = {}
  for (const key of SECRET_SETTING_KEYS) {
    const value = next[key]
    if (typeof value === 'string' && value) secrets[key] = value
    delete next[key]
  }
  return { settings: next, secrets }
}

/** 待迁移进凭证网关的秘密（rehydrate 时排队，由引擎启动时一次性 flush） */
let pendingSecretMigrations: Array<{ configId: string; secrets: Record<string, string> }> = []

/** 取出并清空待迁移清单（引擎 `initPlaylistSync` 调用；测试也用它断言迁移结果） */
export function takePendingSecretMigrations(): Array<{ configId: string; secrets: Record<string, string> }> {
  const drained = pendingSecretMigrations
  pendingSecretMigrations = []
  return drained
}

/**
 * 落盘状态迁移（`version: 1 → 2`）：把历史配置 `settings` 里的秘密字段剥掉。
 *
 * 剥出来的值进待迁移队列，由凭证网关重新保存 —— 能救回来最好；网关不可用就丢弃，
 * 用户下次同步会看到「缺少口令」并重输，而不是让明文永远躺在 localStorage 里。
 * 导出是为了可单测（persist 的 `migrate` 只在版本变化时才跑）。
 */
export function migratePersistedSyncState(persisted: unknown): { configs: SyncConfig[] } {
  const raw = (persisted as { configs?: unknown } | null | undefined)?.configs
  if (!Array.isArray(raw)) return { configs: [] }
  const configs: SyncConfig[] = []
  for (const item of raw) {
    const config = item as SyncConfig | null | undefined
    if (!config || typeof config.id !== 'string' || typeof config.pluginId !== 'string') continue
    const { settings, secrets } = stripSecretSettings(config.settings)
    if (Object.keys(secrets).length > 0) pendingSecretMigrations.push({ configId: config.id, secrets })
    configs.push({ ...config, settings })
  }
  return { configs }
}

export const useSyncStore = create<SyncStoreState>()(
  persist(
    (set, get) => ({
      configs: [],
      runtime: {},
      device: null,
      lan: { status: null, peers: [], scanning: false },

      addConfig: (config) =>
        set({
          // 落盘前先剥秘密字段：`settings.code` 曾经就是这样漏进 localStorage 的（S-3）
          configs: [...get().configs, { ...config, settings: stripSecretSettings(config.settings).settings }],
        }),

      updateConfig: (id, updates) =>
        set({
          configs: get().configs.map((c) =>
            c.id === id
              ? {
                  ...c,
                  ...updates,
                  id,
                  ...(updates.settings ? { settings: stripSecretSettings(updates.settings).settings } : {}),
                }
              : c
          ),
        }),

      removeConfig: (id) => {
        const runtime = { ...get().runtime }
        delete runtime[id]
        set({ configs: get().configs.filter((c) => c.id !== id), runtime })
      },

      setRuntime: (id, patch) =>
        set({
          runtime: {
            ...get().runtime,
            [id]: { ...(get().runtime[id] ?? EMPTY_RUNTIME), ...patch },
          },
        }),

      markSyncOk: (id, result) => {
        const runtime = { ...get().runtime }
        runtime[id] = {
          ...(runtime[id] ?? EMPTY_RUNTIME),
          state: 'ok',
          lastResult: result,
          lastError: null,
          nextRetryAt: null,
        }
        set({
          runtime,
          // 落盘字段只在这里更新：lastSyncAt 与 lastError 同属「上次结果」
          configs: get().configs.map((c) =>
            c.id === id ? { ...c, lastSyncAt: result.at, lastError: undefined } : c
          ),
        })
      },

      markSyncFailed: (id, errorPayload, nextRetryAt) => {
        const runtime = { ...get().runtime }
        runtime[id] = {
          ...(runtime[id] ?? EMPTY_RUNTIME),
          state: 'failed',
          lastError: errorPayload,
          nextRetryAt,
        }
        set({
          runtime,
          configs: get().configs.map((c) =>
            c.id === id ? { ...c, lastError: errorPayload } : c
          ),
        })
      },

      setDevice: (device) => set({ device }),
      setLanStatus: (status) => set({ lan: { ...get().lan, status } }),
      setLanPeers: (peers) => set({ lan: { ...get().lan, peers } }),
      setLanScanning: (scanning) => set({ lan: { ...get().lan, scanning } }),

      markPushed: (id, hash) => {
        const runtime = { ...get().runtime }
        runtime[id] = { ...(runtime[id] ?? EMPTY_RUNTIME), lastPushedHash: hash }
        set({ runtime })
      },
    }),
    {
      name: 'aurora-sync-state',
      /**
       * **只落盘 configs**。运行时状态（running / lastResult / LAN 服务与发现列表 /
       * 设备身份 / 上次推送的哈希）落盘后会变成「重启即过期的事实」：服务没跑却显示在跑、
       * 上次结果是上一进程的。设备身份交给主进程持久化，渲染层只缓存。
       */
      partialize: (state) => ({ configs: state.configs }),
      version: 2,
      /**
       * `1 → 2`：把历史配置 `settings.code`（配对码）剥出去交给凭证网关（验证报告 S-3）。
       * 之后版本再变也要保持这个不变量：任何版本的落盘状态都不许带秘密字段。
       */
      migrate: (persisted, version) => {
        if (version < 2) return migratePersistedSyncState(persisted)
        return persisted as { configs: SyncConfig[] }
      },
    }
  )
)

/** 取某条配置的运行状态（组件里用 `useSyncStore` 订阅，非组件用这个） */
export function syncRuntimeOf(id: string): SyncConfigRuntime {
  return useSyncStore.getState().runtime[id] ?? EMPTY_RUNTIME
}

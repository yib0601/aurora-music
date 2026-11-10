import { useState } from 'react'
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, CheckCircle2, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useT } from '@/i18n'
import { toast } from '@/components/common/Toast'
import { platform } from '@/services/platform'
import { syncOnce, testConnection } from '@/services/playlistSync.service'
import { isSecretSettingKey, useSyncStore, type SyncRunState } from '@/stores/syncStore'
import { generateId } from '@/lib/utils'
import { translateError } from '@aurora/shared'
import type { AppTranslator } from '@aurora/shared'
import type { SyncConfig, SyncDirection, SyncFieldDef, SyncPluginMeta } from '@aurora/shared'

/**
 * 歌单同步目标的表单件：卡片 + 新增/编辑弹窗（docs/playlist-sync.md §15）。
 *
 * 与 `pluginConfigCards.tsx` 里的存储卡片是同一套写法：**字段来自插件的声明式
 * `fields`**，本文件不知道任何协议细节（不知道 WebDAV 有账号口令，也不知道
 * 局域网有配对码）。多一个同步协议 = 多一份 `fields`，这里一行都不用改。
 *
 * 口令纪律（§10）：`kind: 'password'` 的值只喂 `platform.sync.saveCredential`，
 * 不进 `settings`（于是也不进 zustand persist），渲染层永不回读——编辑时留空 = 不改。
 */

/** 配对码/口令的保存状态（只取「存住了没、能不能加密」，从不回读原文） */
interface CredentialView {
  saved: boolean
  encryptionAvailable: boolean
}

const EMPTY_CREDENTIAL: CredentialView = { saved: false, encryptionAvailable: true }

/** 卡片与弹窗共用的输入框样式（与存储卡片同一套 token） */
const INPUT_CLS = 'inset-field w-full px-2.5 py-1.5 font-text text-caption text-white/70'

const DIRECTION_OPTIONS: readonly SyncDirection[] = ['bidirectional', 'pullOnly', 'pushOnly']

const DIRECTION_LABEL_KEYS = {
  bidirectional: 'sync.config.directionBidirectional',
  pullOnly: 'sync.config.directionPullOnly',
  pushOnly: 'sync.config.directionPushOnly',
} as const

const DIRECTION_HINT_KEYS = {
  bidirectional: 'sync.config.directionBidirectionalHint',
  pullOnly: 'sync.config.directionPullOnlyHint',
  pushOnly: 'sync.config.directionPushOnlyHint',
} as const

const STATE_LABEL_KEYS = {
  idle: 'sync.state.idle',
  running: 'sync.state.running',
  ok: 'sync.state.ok',
  failed: 'sync.state.failed',
} as const

/** 方向图标：左箭头=拉、右箭头=推、双向=交换。图标是**辅助**，文案才是判据 */
function DirectionIcon({ direction, className }: { direction: SyncDirection; className?: string }) {
  const Icon =
    direction === 'pullOnly' ? ArrowDownToLine : direction === 'pushOnly' ? ArrowUpFromLine : ArrowLeftRight
  return <Icon className={className ?? 'h-3.5 w-3.5 mr-1.5'} strokeWidth={1.6} />
}

/** 时间戳 → 「9/12 21:03」。只用于卡片上的「上次同步」，不需要相对时间 */
function formatWhen(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toLocaleString()
  }
}

/**
 * 字段值规范化（与存储卡片同一口径）。
 *
 * 放在提交处而不是输入处：用户正在输入的中间态（如地址末尾的 `/`）不该被抢走光标，
 * 但落盘的值必须是插件能直接用的形状。
 */
function normalizeFieldValue(field: SyncFieldDef, raw: string): string {
  const value = raw.trim()
  if (field.kind === 'url') return value.replace(/\/+$/, '')
  if (field.kind === 'path') return value.replace(/^\/+|\/+$/g, '')
  return value
}

/** 单字段校验：只做「必填 / 像不像绝对地址 / 端口范围」，协议细节交给插件探测 */
function fieldErrorOf(field: SyncFieldDef, raw: string, t: AppTranslator): string | null {
  const value = raw.trim()
  if (field.required && !value) return t('sources.webdav.fieldRequired', { field: t(field.labelKey) })
  if (field.kind === 'url' && value && !/^https?:\/\/.+/i.test(value)) {
    return t('sources.webdav.fieldRequired', { field: t(field.labelKey) })
  }
  if (field.kind === 'port' && value) {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return t('sources.webdav.fieldRequired', { field: t(field.labelKey) })
    }
  }
  return null
}

/** 把 `settings` 里的值读成字符串（缺省回落字段声明里的 `defaultValue`） */
function readSetting(config: SyncConfig, field: SyncFieldDef): string {
  const value = config.settings[field.key]
  if (value === undefined || value === null) return field.defaultValue ?? ''
  return String(value)
}

/** 一条配置的非口令字段摘要：卡片副标题用，让用户一眼分辨是哪台设备/哪个目录 */
function settingsSummaryOf(config: SyncConfig, fields: readonly SyncFieldDef[]): string[] {
  return fields
    // 口令字段不可能有值可读；`code` 这类秘密字段在小写比较前先按名字挡掉
    // （插件声明成 `text` 时也必须不显示 —— 副标题是全屏可见的明文）
    .filter((field) => field.kind !== 'password' && !isSecretSettingKey(field.key))
    .map((field) => {
      const value = config.settings[field.key]
      return value === undefined || value === null ? '' : String(value)
    })
    .filter(Boolean)
}

/* ------------------------------------------------------------------ *
 * 卡片
 * ------------------------------------------------------------------ */

/**
 * 一个同步目标。
 *
 * 状态优先级（卡片只显示一条，避免三行字互相打架）：
 * 正在同步 > 连接测试结果 > 上次失败 > 上次成功 > 尚未同步。
 */
export function SyncConfigCard({
  config,
  plugin,
  onUpdate,
  onRemove,
}: {
  config: SyncConfig
  /** 该配置所属插件的声明（决定编辑态渲染哪些字段）；查不到时只允许改名/方向 */
  plugin?: SyncPluginMeta
  onUpdate: (updates: Partial<Omit<SyncConfig, 'id'>>) => void
  onRemove: () => void
}) {
  const t = useT()
  const runtime = useSyncStore((state) => state.runtime[config.id])
  const state: SyncRunState = runtime?.state ?? 'idle'

  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(config.name)
  const [directionDraft, setDirectionDraft] = useState<SyncDirection>(config.direction)
  const [autoSyncDraft, setAutoSyncDraft] = useState(config.autoSync)
  const [values, setValues] = useState<Record<string, string>>({})
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({})
  const [credential, setCredential] = useState<CredentialView>(EMPTY_CREDENTIAL)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [syncing, setSyncing] = useState(false)

  const fields = plugin?.fields ?? []
  const hasPasswordField = fields.some((field) => field.kind === 'password')

  const refreshCredential = () => {
    void (async () => {
      const state = await platform.sync?.credentialState(config.id)
      if (state) setCredential({ saved: state.saved, encryptionAvailable: state.encryptionAvailable })
    })()
  }

  const startEditing = () => {
    setNameDraft(config.name)
    setDirectionDraft(config.direction)
    setAutoSyncDraft(config.autoSync)
    const next: Record<string, string> = {}
    for (const field of fields) {
      if (field.kind !== 'password') next[field.key] = readSetting(config, field)
    }
    setValues(next)
    // 口令永远是空：渲染层拿不到原文，留空表示不改
    setSecretDraft({})
    refreshCredential()
    setEditing(true)
  }

  const canSave = nameDraft.trim().length > 0 && fields.every((f) => !fieldErrorOf(f, values[f.key] ?? '', t))

  const handleSave = () => {
    if (!canSave) return
    const settings: Record<string, unknown> = {}
    for (const field of fields) {
      // 秘密字段一律不进 settings（它整块落 localStorage）：只走凭证网关
      if (field.kind === 'password' || isSecretSettingKey(field.key)) continue
      const value = normalizeFieldValue(field, values[field.key] ?? '')
      // 空值不落盘：清空一个字段等于「用默认值」，而不是把一个空串写进 settings
      if (value) settings[field.key] = value
    }
    onUpdate({ name: nameDraft.trim(), settings, direction: directionDraft, autoSync: autoSyncDraft })

    const secrets = Object.fromEntries(Object.entries(secretDraft).filter(([, value]) => value.trim().length > 0))
    if (Object.keys(secrets).length > 0) {
      void (async () => {
        const result = await platform.sync?.saveCredential(config.id, secrets)
        if (result) {
          setCredential({ saved: result.saved, encryptionAvailable: result.encryptionAvailable })
        }
        refreshCredential()
      })()
    }
    setEditing(false)
  }

  const latestConfig = (): SyncConfig =>
    useSyncStore.getState().configs.find((item) => item.id === config.id) ?? config

  const handleSyncNow = () => {
    setSyncing(true)
    setTestMessage(null)
    void syncOnce(latestConfig())
      .then((outcome) => {
        if (!outcome.ok) {
          // 失败文案由引擎写进 store（结构化载荷），这里只提示一次「去卡片看详情」
          toast(t('sync.toast.failed', { reason: t('sync.state.failed') }), { type: 'error' })
          return
        }
        const applied = outcome.added + outcome.updated + outcome.removed
        toast(applied > 0 ? t('sync.toast.applied', { count: applied }) : t('sync.toast.upToDate'), {
          type: applied > 0 ? 'success' : 'info',
        })
      })
      .finally(() => setSyncing(false))
  }

  const handleTest = () => {
    setTesting(true)
    setTestMessage(null)
    void testConnection(latestConfig())
      .then((result) => {
        setTestMessage({
          ok: result.ok,
          text: result.ok ? (result.detail ?? t('sync.card.testOk')) : translateError(result.message, t),
        })
      })
      .finally(() => setTesting(false))
  }

  const subtitle = [plugin ? t(plugin.displayNameKey) : config.pluginId, ...settingsSummaryOf(config, fields)].join(
    ' · '
  )

  const directionLabel = t(DIRECTION_LABEL_KEYS[config.direction])

  /** 失败载荷：本轮的优先于落盘的（落盘那份是上次会话的，可能已经过期） */
  const errorPayload = runtime?.lastError ?? config.lastError ?? null

  const stateLine = (() => {
    if (state === 'running' || syncing) return { text: t('sync.state.running'), tone: 'muted' as const }
    if (testMessage) {
      return { text: testMessage.text, tone: testMessage.ok ? ('ok' as const) : ('bad' as const) }
    }
    if (errorPayload) {
      return { text: t('sync.card.lastError', { reason: translateError(errorPayload, t) }), tone: 'bad' as const }
    }
    if (config.lastSyncAt) {
      return { text: t('sync.card.lastSyncAt', { time: formatWhen(config.lastSyncAt) }), tone: 'ok' as const }
    }
    return { text: t('sync.card.lastSyncNever'), tone: 'muted' as const }
  })()

  const toneCls =
    stateLine.tone === 'bad' ? 'text-coral/80' : stateLine.tone === 'ok' ? 'text-mint/80' : 'text-white/40'

  const credentialLabel = credential.saved
    ? credential.encryptionAvailable
      ? t('sources.webdav.credentialSaved')
      : t('sources.webdav.credentialUnavailable')
    : t('sources.webdav.credentialMissing')

  return (
    <div className="inset-row px-3.5 py-3">
      <div className="flex items-center gap-2">
        <DirectionIcon direction={config.direction} className="h-4 w-4 text-mint flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-text text-caption-strong text-white/85 truncate">{config.name}</p>
          <p className="font-text text-caption text-white/50 truncate">{subtitle}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          title={config.enabled ? t('sync.card.autoSyncOn') : t('sync.card.autoSyncOff')}
          onClick={() => onUpdate({ enabled: !config.enabled })}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
            config.enabled ? 'bg-mint' : 'bg-white/[0.12]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
              config.enabled ? 'translate-x-4.5' : 'translate-x-1'
            }`}
          />
        </button>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            title={t('common.action.edit')}
            className="h-7 w-7 rounded-[8px] text-white/40 hover:text-mint hover:bg-mint/10 transition-colors duration-200 ease-mineradio"
            onClick={startEditing}
          >
            <Pencil className="h-4 w-4" strokeWidth={1.6} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          title={t('sync.config.delete')}
          className="h-7 w-7 rounded-[8px] text-white/40 hover:text-coral hover:bg-coral/10 transition-colors duration-200 ease-mineradio"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.6} />
        </Button>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2.5">
          <p className="font-text text-caption-strong text-white/85">{t('sync.panel.editTitle')}</p>
          <input
            type="text"
            value={nameDraft}
            placeholder={t('sync.config.namePlaceholder')}
            onChange={(event) => setNameDraft(event.target.value)}
            className={INPUT_CLS}
            aria-label={t('sync.config.nameLabel')}
          />

          {/* 方向：三个选项各自带一句说明。用一排按钮而不是下拉 —— 三项且语义要解释 */}
          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sync.config.directionLabel')}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {DIRECTION_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDirectionDraft(option)}
                  className={`flex items-center rounded-[8px] px-2.5 py-1.5 font-text text-caption transition-colors duration-200 ease-mineradio ${
                    directionDraft === option
                      ? 'bg-mint/15 text-mint'
                      : 'bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white/80'
                  }`}
                >
                  <DirectionIcon direction={option} />
                  {t(DIRECTION_LABEL_KEYS[option])}
                </button>
              ))}
            </div>
            <p className="font-text text-caption text-white/40 mt-1">{t(DIRECTION_HINT_KEYS[directionDraft])}</p>
          </div>

          {fields.map((field) =>
            field.kind === 'password' ? (
              <div key={field.key}>
                <input
                  type="password"
                  value={secretDraft[field.key] ?? ''}
                  placeholder={t(field.labelKey)}
                  onChange={(event) => setSecretDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  className={INPUT_CLS}
                  autoComplete="new-password"
                  aria-label={t(field.labelKey)}
                />
                <div className="flex items-center gap-2 mt-1">
                  <p
                    className={`font-text text-caption ${
                      credential.encryptionAvailable ? 'text-white/40' : 'text-coral/70'
                    }`}
                  >
                    {credentialLabel}
                  </p>
                  {credential.saved && (
                    <button
                      type="button"
                      onClick={() =>
                        void platform.sync?.clearCredential(config.id).then((result) => {
                          if (result) {
                            setCredential({ saved: result.saved, encryptionAvailable: result.encryptionAvailable })
                          }
                          refreshCredential()
                        })
                      }
                      className="font-text text-caption text-white/40 hover:text-coral/80 underline underline-offset-2"
                    >
                      {t('sources.webdav.clearCredential')}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div key={field.key}>
                <input
                  type="text"
                  value={values[field.key] ?? ''}
                  placeholder={field.placeholderKey ? t(field.placeholderKey) : t(field.labelKey)}
                  onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  className={INPUT_CLS}
                  autoComplete="off"
                  aria-label={t(field.labelKey)}
                />
                {field.hintKey && <p className="font-text text-caption text-white/40 mt-1">{t(field.hintKey)}</p>}
              </div>
            )
          )}

          {/* 自动同步：开关 + 一句解释（「每 5 分钟」这种频率必须让用户先知道） */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={autoSyncDraft}
              onClick={() => setAutoSyncDraft((prev) => !prev)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
                autoSyncDraft ? 'bg-mint' : 'bg-white/[0.12]'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
                  autoSyncDraft ? 'translate-x-4.5' : 'translate-x-1'
                }`}
              />
            </button>
            <p className="font-text text-caption text-white/70">{t('sync.config.autoSync')}</p>
          </div>
          <p className="font-text text-caption text-white/40">{t('sync.config.autoSyncHint')}</p>

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-white/60 hover:text-white/90"
              onClick={() => setEditing(false)}
            >
              {t('sync.config.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-8 px-4 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
              disabled={!canSave}
              onClick={handleSave}
            >
              {t('sync.config.save')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-3"
              disabled={syncing || state === 'running'}
              onClick={handleSyncNow}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} strokeWidth={1.6} />
              {t('sync.card.syncNow')}
            </Button>
            {plugin?.capabilities.includes('probe') && (
              <Button variant="secondary" size="sm" className="h-8 px-3" disabled={testing} onClick={handleTest}>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" strokeWidth={1.6} />
                {testing ? t('sync.card.testing') : t('sync.card.test')}
              </Button>
            )}
            <p className="font-text text-caption text-white/40">{t('sync.card.direction', { direction: directionLabel })}</p>
          </div>
          <p className={`mt-1.5 font-text text-caption truncate ${toneCls}`} title={stateLine.text}>
            {state === 'ok' && !errorPayload && !testMessage ? `${t(STATE_LABEL_KEYS.ok)} · ` : ''}
            {stateLine.text}
          </p>
          {hasPasswordField && !plugin?.capabilities.includes('probe') && credential.saved && (
            <p className="mt-0.5 font-text text-caption text-white/30 truncate">{credentialLabel}</p>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 新增 / 编辑弹窗
 * ------------------------------------------------------------------ */

/** 弹窗提交的配置（id 由调用方生成；运行期字段不在此列） */
export type SyncConfigDraft = Pick<SyncConfig, 'pluginId' | 'name' | 'settings' | 'direction' | 'autoSync'>

/**
 * 新增同步目标。
 *
 * 编辑走卡片内的就地编辑（字段少、上下文就在卡片里），这里只负责「新建」：
 * 选插件 → 填字段 → 定方向。
 */
export function SyncConfigAddDialog({
  open,
  onOpenChange,
  plugins,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 可添加的插件（已按平台可用性筛过；空数组时入口本不该出现） */
  plugins: readonly SyncPluginMeta[]
  /** secrets 只喂凭证 IPC，**不进 settings 持久化** */
  onSave: (draft: SyncConfigDraft, secrets: Record<string, string>) => void
}) {
  const t = useT()
  const [pluginId, setPluginId] = useState<string>('')
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [direction, setDirection] = useState<SyncDirection>('bidirectional')
  const [autoSync, setAutoSync] = useState(true)

  const plugin = plugins.find((item) => item.id === pluginId) ?? (plugins.length === 1 ? plugins[0] : undefined)
  const fields = plugin?.fields ?? []

  const resetForm = () => {
    setPluginId('')
    setName('')
    setValues({})
    setDirection('bidirectional')
    setAutoSync(true)
  }

  /** 默认值预填：只在用户还没动过这个字段时生效（如局域网端口 45871） */
  const valueOf = (field: SyncFieldDef): string => values[field.key] ?? field.defaultValue ?? ''

  const canSave =
    Boolean(plugin) && name.trim().length > 0 && fields.every((field) => !fieldErrorOf(field, valueOf(field), t))

  const handleSave = () => {
    if (!canSave || !plugin) return
    // 源头分流：口令类字段只进 secrets，其余进 settings（persist 白名单是第二道闸）
    const settings: Record<string, unknown> = {}
    const secrets: Record<string, string> = {}
    for (const field of fields) {
      const value = normalizeFieldValue(field, valueOf(field))
      if (!value) continue
      if (field.kind === 'password') secrets[field.key] = value
      else settings[field.key] = value
    }
    onSave(
      { pluginId: plugin.id, name: name.trim(), settings, direction, autoSync },
      secrets
    )
    resetForm()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white text-tagline">{t('sync.panel.addTitle')}</DialogTitle>
          <DialogDescription className="font-text text-caption text-white/60">
            {t('sync.panel.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 多个同步方式时才需要选；只有一个（桌面端默认就是这两个）直接省掉这一步 */}
          {plugins.length > 1 && (
            <div>
              <p className="font-text text-caption text-white/60 mb-1.5">{t('sync.panel.title')}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {plugins.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setPluginId(item.id)
                      setValues({})
                    }}
                    className={`rounded-[8px] px-2.5 py-1.5 font-text text-caption transition-colors duration-200 ease-mineradio ${
                      plugin?.id === item.id
                        ? 'bg-mint/15 text-mint'
                        : 'bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white/80'
                    }`}
                  >
                    {t(item.displayNameKey)}
                  </button>
                ))}
              </div>
              {plugin?.descriptionKey && (
                <p className="font-text text-caption text-white/40 mt-1">{t(plugin.descriptionKey)}</p>
              )}
            </div>
          )}

          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sync.config.nameLabel')}</p>
            <input
              type="text"
              value={name}
              placeholder={t('sync.config.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
              className={INPUT_CLS}
            />
          </div>

          {fields.map((field) => {
            const raw = valueOf(field)
            const error = fieldErrorOf(field, raw, t)
            return (
              <div key={field.key}>
                <p className="font-text text-caption text-white/60 mb-1.5">{t(field.labelKey)}</p>
                <input
                  type={field.kind === 'password' ? 'password' : 'text'}
                  inputMode={field.kind === 'port' ? 'numeric' : undefined}
                  value={raw}
                  placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
                  onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                  className={`${INPUT_CLS} ${error ? 'is-invalid' : ''}`}
                  autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
                />
                {field.hintKey && <p className="font-text text-caption text-white/40 mt-1">{t(field.hintKey)}</p>}
              </div>
            )
          })}

          <div>
            <p className="font-text text-caption text-white/60 mb-1.5">{t('sync.config.directionLabel')}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {DIRECTION_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDirection(option)}
                  className={`flex items-center rounded-[8px] px-2.5 py-1.5 font-text text-caption transition-colors duration-200 ease-mineradio ${
                    direction === option
                      ? 'bg-mint/15 text-mint'
                      : 'bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white/80'
                  }`}
                >
                  <DirectionIcon direction={option} />
                  {t(DIRECTION_LABEL_KEYS[option])}
                </button>
              ))}
            </div>
            <p className="font-text text-caption text-white/40 mt-1">{t(DIRECTION_HINT_KEYS[direction])}</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={autoSync}
              onClick={() => setAutoSync((prev) => !prev)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio ${
                autoSync ? 'bg-mint' : 'bg-white/[0.12]'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
                  autoSync ? 'translate-x-4.5' : 'translate-x-1'
                }`}
              />
            </button>
            <p className="font-text text-caption text-white/70">{t('sync.config.autoSync')}</p>
          </div>
          <p className="font-text text-caption text-white/40">{t('sync.config.autoSyncHint')}</p>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-4 text-white/60 hover:text-white/90"
            onClick={() => onOpenChange(false)}
          >
            {t('sync.config.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-9 px-5 bg-mint text-mint-fg font-semibold hover:bg-mint/90 disabled:opacity-40 disabled:hover:bg-mint"
            disabled={!canSave}
            onClick={handleSave}
          >
            {t('sync.panel.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建配置的 id 生成（与其它配置同一条 `generateId`） */
export function newSyncConfig(draft: SyncConfigDraft): SyncConfig {
  return {
    id: generateId(),
    pluginId: draft.pluginId,
    name: draft.name,
    settings: draft.settings,
    direction: draft.direction,
    autoSync: draft.autoSync,
    enabled: true,
  }
}

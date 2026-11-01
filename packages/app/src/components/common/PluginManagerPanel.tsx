import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  Download,
  FolderOpen,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLocale, useT } from '@/i18n'
import type { PluginCatalogEntry, PluginFailure } from '@aurora/shared'
import {
  builtinEntries,
  capabilityLabelsOf,
  describeBrokenReason,
  describeFailureReason,
  displayDescriptionOf,
  displayNameOf,
  installFromFileDialog,
  installFromUrl,
  installedEntries,
  loadPluginCatalog,
  loadPluginStartupReport,
  openPluginDir,
  permissionLinesOf,
  pluginToggleAvailable,
  removeBrokenPlugin,
  togglePluginEnabled,
  uninstallPlugin,
  type InstallOutcome,
} from './pluginManage'

/**
 * 插件管理面板（安装 / 卸载 / 目录）。
 *
 * 只出现在**具备安装能力**的端（桌面端）：移动端与 Web 没有插件文件系统，
 * 入口在那里整块隐藏而不是显示后再失败（与 `PluginAuthPanel` 同一纪律）。
 *
 * ## 四条刻意的交互决定
 *
 * 1. **安装前先展示权限，确认后才装**。"插件申请什么，就要让用户看见什么"
 *    （docs/plugins.md）——域名、凭证、文件读写必须逐条列出。当前 A 档插件不会
 *    执行任何代码，但用户仍然有权知道它的请求会发往哪里。
 * 2. **装完立即刷新列表**，而不是让用户自己点刷新：装成功的即时反馈是"它出现在列表里"。
 * 3. **卸载要二次确认**。卸载会连带删凭证，且使用它的音源立即失效 ——
 *    这两个后果都不该由一个误点触发。
 * 4. **启停是不卸载的"暂时不用"，因此**不**做二次确认**。停用不删任何东西、
 *    一点即回退，加一层确认只会让"临时换个源试试"变成三步操作。它与"源配置里的
 *    enabled"也是两件事：那个开关管的是**一条配置**要不要参与，这个开关管的是
 *    **整个插件实现**上不上场 —— 所以内置插件同样需要它（内置插件没法卸载，
 *    没有这一步，"我不想用它"就完全无法表达）。停用的卡片整块降透明度并给出说明，
 *    让"它还在、只是没上场"这件事一眼可读。
 */
export function PluginManagerPanel() {
  const t = useT()
  const [entries, setEntries] = useState<PluginCatalogEntry[] | null>(null)
  const [broken, setBroken] = useState<Array<{ path: string; message?: string }>>([])
  /** 启动加载阶段出错的插件（注册期抛错，与"磁盘文件读不出来"是两种不同的失败） */
  const [failures, setFailures] = useState<PluginFailure[]>([])
  const [manageable, setManageable] = useState(false)
  /**
   * 本端是否具备启停能力。
   *
   * 与 `manageable`（安装/卸载能力）分开判断：老 preload 可能有安装通道却没有启停通道，
   * 那种组合下插件列表照常显示，只是**整块不渲染开关**（隐藏而不是禁用 ——
   * 禁用态会让人以为"操作一下就开了"，实际是这一端永远做不到）。
   */
  const [toggleAvailable, setToggleAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string; issues?: InstallOutcome['issues'] } | null>(
    null
  )
  const [url, setUrl] = useState('')
  const [showUrlForm, setShowUrlForm] = useState(false)
  /** 待确认安装的插件（权限确认框的内容） */
  const [pending, setPending] = useState<{ url: string } | null>(null)
  /** 待确认卸载的插件 */
  const [confirmUninstall, setConfirmUninstall] = useState<PluginCatalogEntry | null>(null)

  // 语言从 i18n hooks 取，不从字典里"探测"：目录里的展示名要按当前语言解析，
  // 而 t() 的返回值是译文，不能反推语言。
  const locale = useLocale()

  const refresh = useCallback(async () => {
    const state = await loadPluginCatalog(locale)
    setEntries(state.entries)
    setBroken(state.broken)
    setManageable(state.manageable)
    // 启停能力单独探一次：它不随目录内容变，但与"能不能装"是两件事
    setToggleAvailable(pluginToggleAvailable())
    // 启动加载失败清单：一次性读，不随刷新变（那是"本次启动"的事实，重读也不会变）
    const report = await loadPluginStartupReport()
    setFailures(report?.failures ?? [])
  }, [locale])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleInstallFromFile = async () => {
    setBusy(true)
    setMessage(null)
    const outcome = await installFromFileDialog(locale)
    setBusy(false)
    // null = 用户取消了选择框，什么都不做（不显示"安装失败"）
    if (!outcome) return
    if (outcome.ok) {
      setMessage({ ok: true, text: t('sources.plugins.installedOk', { name: outcome.name || '' }) })
      await refresh()
      return
    }
    setMessage({ ok: false, text: outcome.message || '', issues: outcome.issues })
  }

  const handleConfirmUrlInstall = async () => {
    if (!pending) return
    setBusy(true)
    setMessage(null)
    const outcome = await installFromUrl(pending.url, locale)
    setBusy(false)
    setPending(null)
    if (outcome.ok) {
      setMessage({ ok: true, text: t('sources.plugins.installedOk', { name: outcome.name || '' }) })
      setUrl('')
      setShowUrlForm(false)
      await refresh()
      return
    }
    setMessage({ ok: false, text: outcome.message || '', issues: outcome.issues })
  }

  const handleUninstall = async () => {
    if (!confirmUninstall) return
    const target = confirmUninstall
    setBusy(true)
    setMessage(null)
    const outcome = await uninstallPlugin(target.id, locale)
    setBusy(false)
    setConfirmUninstall(null)
    if (outcome.ok) {
      setMessage({
        ok: true,
        text: t('sources.plugins.uninstalledOk', { name: displayNameOf(target, t) }),
      })
      await refresh()
      return
    }
    setMessage({ ok: false, text: outcome.message || '' })
  }

  const handleRemoveBroken = async (dirPath: string) => {
    setBusy(true)
    const ok = await removeBrokenPlugin(dirPath)
    setBusy(false)
    if (ok) await refresh()
  }

  /**
   * 拨一个插件的开关。
   *
   * 成功后**不回显成功提示、但一定回读目录**（`refresh()`），理由有两条：
   *
   * - 反馈已经够强：开关翻转 + 停用卡整块降透明度并出现停用说明，比一句 toast 更直接。
   *   每次都弹"已停用「X」"会把这个面板变成噪音源。
   * - `entry.enabled` 是主进程投影出来的权威值，落盘失败时主进程会回滚 ——
   *   本地乐观更新会让开关与实际状态错位，用户下次搜索才发现"关了还在用"。
   *   所以宁可多一次往返，也不用本地 state 假装已经切过去了。
   */
  const handleToggle = async (entry: PluginCatalogEntry, enabled: boolean) => {
    setBusy(true)
    setMessage(null)
    const outcome = await togglePluginEnabled(entry.id, enabled, t)
    setBusy(false)
    if (outcome.ok) {
      await refresh()
      return
    }
    // 失败必须可归因：`togglePluginEnabled` 已经把原因拼成「操作失败：<具体原因>」，
    // 这里原样上屏，不再叠一层自己的措辞（叠了反而看不到真正的原因）
    setMessage({ ok: false, text: outcome.message || t('sources.plugins.toggleUnsupported') })
  }

  // 本端没有安装能力：整块隐藏（不是显示"不支持"打扰用户）
  if (!manageable && (entries === null || entries.length === 0)) return null
  if (entries === null) {
    return (
      <div className="flex items-center gap-2 text-white/45 font-text text-caption py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.6} />
        {t('common.state.loading')}
      </div>
    )
  }

  const installed = installedEntries(entries)
  const builtin = builtinEntries(entries)

  return (
    <div className="space-y-3.5">
      {/* ─── 已安装 ─── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="font-text text-caption-strong text-white/80">
            {t('sources.plugins.installed')}
            <span className="text-white/40 ml-1.5">{installed.length}</span>
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-white/55"
              title={t('sources.plugins.openDir')}
              onClick={() => void openPluginDir()}
            >
              <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.6} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-white/55"
              title={t('sources.auth.refresh')}
              onClick={() => void refresh()}
              disabled={busy}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} strokeWidth={1.6} />
            </Button>
          </div>
        </div>

        {installed.length === 0 ? (
          <p className="font-text text-caption text-white/40 py-1.5">{t('sources.plugins.listEmpty')}</p>
        ) : (
          <div className="space-y-2">
            {installed.map((entry) => (
              <PluginEntryCard
                key={`${entry.domain}:${entry.id}`}
                entry={entry}
                onUninstall={() => setConfirmUninstall(entry)}
                onToggle={toggleAvailable ? (enabled) => void handleToggle(entry, enabled) : undefined}
                busy={busy}
              />
            ))}
          </div>
        )}
      </section>

      {/* ─── 安装入口 ─── */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            className="h-9 px-3.5"
            onClick={() => setShowUrlForm((value) => !value)}
            disabled={busy}
          >
            <Download className="h-4 w-4 mr-2" strokeWidth={1.6} />
            {t('sources.plugins.installFromUrl')}
            <ChevronDown
              className={`h-3.5 w-3.5 ml-1.5 transition-transform ${showUrlForm ? 'rotate-180' : ''}`}
              strokeWidth={1.6}
            />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-9 px-3.5"
            onClick={() => void handleInstallFromFile()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.6} />
            ) : (
              <Upload className="h-4 w-4 mr-2" strokeWidth={1.6} />
            )}
            {t('sources.plugins.installFromFile')}
          </Button>
        </div>

        {showUrlForm && (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-[10px] px-3.5 py-3 space-y-2">
            <p className="font-text text-caption text-white/60">{t('sources.plugins.urlLabel')}</p>
            <div className="flex items-center gap-1.5">
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={t('sources.plugins.urlPlaceholder')}
                className="inset-field flex-1 min-w-0 px-2.5 py-1.5 font-text text-caption text-white/70"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                variant="primary"
                size="sm"
                className="h-8 px-3 shrink-0"
                disabled={busy || !url.trim()}
                onClick={() => setPending({ url: url.trim() })}
              >
                {t('sources.plugins.install')}
              </Button>
            </div>
            <p className="font-text text-caption text-white/35">{t('sources.plugins.installHint')}</p>
          </div>
        )}

        {/* 安装结果：清单结构问题逐条展示（只说"安装失败"用户无法补救） */}
        {message && (
          <div
            className={`rounded-[10px] px-3.5 py-2.5 border ${
              message.ok
                ? 'bg-mint/[0.06] border-mint/20'
                : 'bg-coral/[0.06] border-coral/20'
            }`}
          >
            <p
              className={`font-text text-caption ${message.ok ? 'text-mint/90' : 'text-coral/90'}`}
            >
              {message.text}
            </p>
            {message.issues && message.issues.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {message.issues.map((issue, index) => (
                  <li key={index} className="font-text text-caption text-white/55">
                    {issue.field && <span className="text-white/40 mr-1">{issue.field}</span>}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* ─── 内置插件（不可卸载，但**可以停用**） ─── */}
      {/* 内置插件的实现编译在应用里，卸载无从谈起；没有这里的开关，"我不想用它"这件事
          对内置插件根本无法表达（只能去逐条改源配置）。所以开关一视同仁，只有卸载按钮
          由 `entry.removable` 决定。 */}
      {builtin.length > 0 && (
        <section className="space-y-2">
          <p className="font-text text-caption-strong text-white/60">
            {t('sources.plugins.builtin')}
            <span className="text-white/30 ml-1.5">{builtin.length}</span>
          </p>
          <div className="space-y-2">
            {builtin.map((entry) => (
              <PluginEntryCard
                key={`${entry.domain}:${entry.id}`}
                entry={entry}
                onToggle={toggleAvailable ? (enabled) => void handleToggle(entry, enabled) : undefined}
                busy={busy}
              />
            ))}
          </div>
        </section>
      )}

      {/* ─── 读不出来的插件文件 ─── */}
      {broken.length > 0 && (
        <section className="space-y-2">
          <p className="font-text text-caption-strong text-coral/80">
            {t('sources.plugins.listBroken', { count: broken.length })}
          </p>
          <p className="font-text text-caption text-white/40">{t('sources.plugins.brokenHint')}</p>
          <div className="space-y-1.5">
            {broken.map((item) => (
              <div
                key={item.path}
                className="flex items-start justify-between gap-2 bg-coral/[0.05] border border-coral/15 rounded-[8px] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="font-text text-caption text-white/70 truncate" title={item.path}>
                    {item.path}
                  </p>
                  <p className="font-text text-caption text-white/45 mt-0.5">
                    {describeBrokenReason(item.message, t)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-coral/70 shrink-0"
                  title={t('sources.plugins.removeBroken')}
                  disabled={busy}
                  onClick={() => void handleRemoveBroken(item.path)}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.6} />
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── 启动时加载失败的插件 ─── */}
      {/* 与下面的「读不出来的文件」分开：那种是磁盘内容不合格（有路径可删），
          这种是加载代码时抛错（没有文件路径可靠，只能给出 id 与原因）。
          两者对用户都是"这个插件用不了"，但补救动作不同，混在一起会说不清。 */}
      {failures.length > 0 && (
        <section className="space-y-2">
          <p className="font-text text-caption-strong text-coral/80">
            {t('sources.plugins.startupFailedList')}
            <span className="text-white/30 ml-1.5">{failures.length}</span>
          </p>
          <p className="font-text text-caption text-white/40">
            {t('sources.plugins.startupFailedHint')}
          </p>
          <div className="space-y-1.5">
            {failures.map((failure, index) => (
              <div
                key={`${failure.stage}:${failure.id}:${index}`}
                className="bg-coral/[0.05] border border-coral/15 rounded-[8px] px-3 py-2"
              >
                <p className="font-text text-caption text-white/70 truncate" title={failure.id}>
                  {/* 连 id 都取不到时显示阶段名：空行会让用户以为列表坏了 */}
                  {failure.id || failure.stage}
                </p>
                <p className="font-text text-caption text-white/45 mt-0.5 break-all">
                  {describeFailureReason(failure, t)}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── 权限确认（安装前） ─── */}
      {pending && (
        <ConfirmDialog
          title={t('sources.plugins.install')}
          body={
            <div className="space-y-2">
              <p className="font-text text-caption text-white/60 break-all">{pending.url}</p>
              <p className="font-text text-caption-strong text-white/80 mt-2">
                {t('sources.plugins.permissionTitle')}
              </p>
              {/* 安装前还没解析清单，域名只能装完才知道 —— 所以这里说的是
                  "这份清单会申请网络访问，装完在列表里能看到具体域名"。
                  不假装列出来：列不出就是列不出。 */}
              <ul className="space-y-1 pl-4 list-disc">
                <li className="font-text text-caption text-white/60">
                  {t('sources.plugins.permissionNetwork', { hosts: t('sources.plugins.pendingHosts') })}
                </li>
              </ul>
              <p className="font-text text-caption text-white/35">{t('sources.plugins.installHint')}</p>
            </div>
          }
          confirmLabel={t('sources.plugins.install')}
          cancelLabel={t('common.action.cancel')}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void handleConfirmUrlInstall()}
        />
      )}

      {/* ─── 卸载确认 ─── */}
      {confirmUninstall && (
        <ConfirmDialog
          title={t('sources.plugins.uninstallConfirmTitle', {
            name: displayNameOf(confirmUninstall, t),
          })}
          body={
            <p className="font-text text-caption text-white/60">{t('sources.plugins.uninstallConfirmBody')}</p>
          }
          confirmLabel={t('sources.plugins.uninstall')}
          cancelLabel={t('common.action.cancel')}
          destructive
          busy={busy}
          onCancel={() => setConfirmUninstall(null)}
          onConfirm={() => void handleUninstall()}
        />
      )}
    </div>
  )
}

/**
 * 单个插件条目。
 *
 * `onToggle` 缺席 = 本端没有启停能力，开关**整块不渲染**（不是渲染成禁用态）：
 * 禁用态会让用户以为"点一下就能开"，实际是这一端永远做不到 —— 与仓库里
 * 「能力缺失就隐藏入口」的一贯纪律一致。
 */
function PluginEntryCard({
  entry,
  onUninstall,
  onToggle,
  busy,
}: {
  entry: PluginCatalogEntry
  onUninstall?: () => void
  onToggle?: (enabled: boolean) => void
  busy?: boolean
}) {
  const t = useT()
  const name = displayNameOf(entry, t)
  const description = displayDescriptionOf(entry, t)
  const capabilities = capabilityLabelsOf(entry, t)
  const permissions = entry.provenance === 'installed'
    ? permissionLinesOf(entry.permissions, entry.hosts, t)
    : []
  // 当前状态只读 `entry.enabled`（主进程投影时已算好），不在渲染层自己推
  const enabled = entry.enabled !== false

  return (
    <div
      className={`bg-white/[0.03] border border-white/[0.06] rounded-[10px] px-3.5 py-2.5 transition-opacity duration-200 ease-mineradio ${
        enabled ? '' : 'opacity-55'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="font-text text-caption-strong text-white/90 truncate">{name}</p>
            <span className="font-text text-[10px] text-white/35 px-1.5 py-0.5 rounded bg-white/[0.06]">
              v{entry.version}
            </span>
            {entry.provenance === 'builtin' && (
              <span className="font-text text-[10px] text-white/35 px-1.5 py-0.5 rounded bg-white/[0.06]">
                {t('sources.plugins.builtin')}
              </span>
            )}
          </div>
          {description && (
            <p className="font-text text-caption text-white/50 mt-0.5">{description}</p>
          )}
          {capabilities.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-1.5">
              {capabilities.map((label) => (
                <span key={label} className="font-text text-[10px] text-white/45 px-1.5 py-0.5 rounded bg-white/[0.05]">
                  {label}
                </span>
              ))}
            </div>
          )}
          {/* 已安装插件必须显示它申请的域名：这是用户判断"该不该留"的唯一依据 */}
          {permissions.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {permissions.map((line) => (
                <li key={line} className="font-text text-[10px] text-white/35">
                  {line}
                </li>
              ))}
            </ul>
          )}
          {/* 停用态说明：只说"已停用"不够，用户要知道"什么不再工作、有没有被删掉" */}
          {!enabled && onToggle && (
            <p className="font-text text-[10px] text-white/40 mt-1.5">
              {t('sources.plugins.disabledHint')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onToggle && (
            // 样式照抄 SettingsPage 里源开关的那一套（role/aria-checked/尺寸/缓动一致），
            // 同一个应用里同一个动作长得不一样会让人怀疑它们不是同一件事
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={name}
              title={enabled ? t('sources.plugins.enableTitle') : t('sources.plugins.disableTitle')}
              disabled={busy}
              onClick={() => onToggle(!enabled)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ease-mineradio disabled:opacity-50 ${
                enabled ? 'bg-mint' : 'bg-white/[0.12]'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-mineradio ${
                  enabled ? 'translate-x-4.5' : 'translate-x-1'
                }`}
              />
            </button>
          )}
          {entry.removable && onUninstall && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-white/45 hover:text-coral shrink-0"
              title={t('sources.plugins.uninstall')}
              disabled={busy}
              onClick={onUninstall}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.6} />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 通用确认框（安装 / 卸载共用；不依赖 Radix Dialog，保持面板自包含） */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string
  body: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        // 点遮罩关闭：只有点在遮罩本身（不是内容区）时才关
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-md bg-[#16181d] border border-white/[0.08] rounded-[14px] p-4 space-y-3">
        <p className="font-text text-caption-strong text-white/90">{title}</p>
        <div>{body}</div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" className="h-9 px-3.5 text-white/60" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'secondary' : 'primary'}
            size="sm"
            className={`h-9 px-3.5 ${destructive ? 'text-coral' : ''}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.6} /> : <Package className="h-4 w-4 mr-2" strokeWidth={1.6} />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
